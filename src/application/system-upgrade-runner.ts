import { dirname } from "node:path";

import {
  isManagedResourceInstallationComplete,
} from "../infrastructure/managed-resource-installer.js";
import {
  PackageCommandError,
  type NpmPackageUpgrader,
} from "../infrastructure/npm-package-upgrader.js";
import type { UpgradeStateStore } from "../infrastructure/upgrade-state-store.js";
import type { UpgradeRequest } from "./upgrade-coordinator.js";
import {
  type SystemUpdateError,
  type UpgradePhase,
  type UpgradeState,
} from "../domain/system-update.js";
import {
  managedResourceSyncError,
  type ManagedResourceSyncStatus,
} from "./managed-resource-sync.js";

interface SystemUpgradeRunnerOptions {
  store: UpgradeStateStore;
  packageUpgrader: Pick<
    NpmPackageUpgrader,
    "install" | "stop" | "migrate" | "start"
  >;
  installResources: (
    packageRoot: string,
    targetVersion: string,
  ) => Promise<ManagedResourceSyncStatus>;
  verifyHealth: (targetVersion: string) => Promise<void>;
  now?: () => Date;
}

export class SystemUpgradeRunner {
  private readonly now: () => Date;

  constructor(private readonly options: SystemUpgradeRunnerOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async run(request: UpgradeRequest): Promise<void> {
    try {
      await this.transition(request, "installing");
      const installed = await this.options.packageUpgrader.install(request.targetVersion);
      const packageRoot = dirname(dirname(dirname(dirname(installed.cliPath))));

      await this.transition(request, "stopping");
      await this.options.packageUpgrader.stop(
        installed.cliPath,
        request.stateDirectory,
      );

      await this.transition(request, "migrating");
      await this.options.packageUpgrader.migrate(
        installed.cliPath,
        request.stateDirectory,
      );

      await this.transition(request, "syncing_resources");
      const resources = await this.options.installResources(
        packageRoot,
        request.targetVersion,
      );
      if (!isManagedResourceInstallationComplete(resources.state)) {
        throw new UpgradeFailure(managedResourceSyncError(resources));
      }

      await this.transition(request, "restarting");
      await this.options.packageUpgrader.start(
        installed.cliPath,
        request.stateDirectory,
      );
      await this.options.verifyHealth(request.targetVersion);
      await this.transition(request, "succeeded", true);
    } catch (error) {
      const current = await this.options.store.read();
      const failure = classifyUpgradeError(error, current?.phase);
      await this.transition(request, "failed", true, failure);
      throw new Error(failure.summary, { cause: error });
    }
  }

  private async transition(
    request: UpgradeRequest,
    phase: UpgradePhase,
    completed = false,
    error?: SystemUpdateError,
  ): Promise<void> {
    const current = await this.options.store.read();
    if (!current || current.operationId !== request.operationId) {
      throw new Error(`Upgrade operation ${request.operationId} is no longer current`);
    }
    const timestamp = this.now().toISOString();
    const next: UpgradeState = {
      ...current,
      phase,
      updatedAt: timestamp,
      phaseStartedAt: { ...current.phaseStartedAt, [phase]: timestamp },
      ...(completed ? { completedAt: timestamp } : {}),
      ...(error ? { error } : {}),
    };
    await this.options.store.write(next);
  }
}

class UpgradeFailure extends Error {
  constructor(readonly detail: SystemUpdateError) {
    super(detail.summary);
  }
}

function classifyUpgradeError(
  error: unknown,
  phase?: UpgradePhase,
): SystemUpdateError {
  if (error instanceof UpgradeFailure) return error.detail;
  if (error instanceof PackageCommandError) {
    if (error.kind === "permission_denied") {
      return {
        code: "permission_denied",
        summary:
          error.step === "stop"
            ? "Codrive was installed, but the old service could not stop with the current permissions. Repair local service access, then retry."
            : error.step === "start"
            ? "Codrive was installed, but the service could not restart with the current permissions. Repair local service access, then retry."
            : error.step === "migrate"
            ? "Codrive was installed, but its state could not be migrated with the current permissions. Repair state access, then retry."
            : "Codrive could not install the package with the current npm permissions. Repair npm access, then retry.",
      };
    }
    if (error.step === "stop") {
      return {
        code: "service_stop_failed",
        summary: "Codrive was installed, but the old service could not stop. Run codrive upgrade to retry.",
      };
    }
    if (error.step === "migrate") {
      return {
        code: "state_migration_failed",
        summary:
          "Codrive stopped, but its state could not be migrated safely. Restore or repair the v3 state, then retry.",
      };
    }
    if (error.step === "start") {
      return {
        code: "service_restart_failed",
        summary: "Codrive was installed, but the service could not restart. Run codrive upgrade to retry.",
      };
    }
    return {
      code: "package_install_failed",
      summary: "The Codrive package could not be installed. Check npm access and run codrive upgrade to retry.",
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/EACCES|EPERM|permission/i.test(message)) {
    return {
      code: "permission_denied",
      summary: "Codrive could not install the package with the current npm permissions. Repair npm access, then retry.",
    };
  }
  if (phase === "migrating") {
    return {
      code: "state_migration_failed",
      summary:
        "Codrive stopped, but its state could not be migrated safely. Restore or repair the v3 state, then retry.",
    };
  }
  if (/timed out|timeout/i.test(message)) {
    return {
      code: "service_start_timeout",
      summary: "The package installed, but the updated Codrive service did not become healthy in time. Run codrive upgrade to retry.",
    };
  }
  if (/restarted with version .* expected/i.test(message)) {
    return {
      code: "wrong_version",
      summary: "Codrive restarted with a different version than the selected target. Run codrive upgrade to retry.",
    };
  }
  if (/Refusing to replace unmanaged Skill/i.test(message)) {
    return {
      code: "skill_conflict",
      summary: "A local unmanaged Skill has the same name. Move it aside, then retry the update.",
    };
  }
  if (/Refusing to replace unmanaged Hook/i.test(message)) {
    return {
      code: "hook_conflict",
      summary:
        "A local unmanaged Codex Hook conflicts with Codrive. Move it aside, then retry the update.",
    };
  }
  if (phase === "stopping") {
    return {
      code: "service_stop_failed",
      summary: "Codrive was installed, but the old service could not stop. Run codrive upgrade to retry.",
    };
  }
  if (phase === "restarting") {
    return {
      code: "service_restart_failed",
      summary: "Codrive was installed, but the service could not restart. Run codrive upgrade to retry.",
    };
  }
  if (phase === "syncing_resources") {
    return {
      code: "resource_sync_failed",
      summary:
        "Codrive state migrated, but its managed resources could not be synchronized while stopped. Retry from the Codrive update window.",
    };
  }
  return {
    code: "package_install_failed",
    summary: "The Codrive package could not be installed. Check npm access and run codrive upgrade to retry.",
  };
}
