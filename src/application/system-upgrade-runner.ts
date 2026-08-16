import { dirname } from "node:path";

import type { ManagedResourceInstallationStatus } from "../infrastructure/managed-resource-installer.js";
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

interface SystemUpgradeRunnerOptions {
  store: UpgradeStateStore;
  packageUpgrader: Pick<NpmPackageUpgrader, "install" | "restart">;
  installResources: (
    packageRoot: string,
    targetVersion: string,
  ) => Promise<ManagedResourceSyncStatus>;
  verifyHealth: (targetVersion: string) => Promise<void>;
  now?: () => Date;
}

type ManagedResourceSyncStatus = Pick<
  ManagedResourceInstallationStatus,
  "state"
> & {
  skills: Pick<ManagedResourceInstallationStatus["skills"], "state">;
  hook: Pick<ManagedResourceInstallationStatus["hook"], "state">;
};

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

      await this.transition(request, "restarting");
      await this.options.packageUpgrader.restart(
        installed.cliPath,
        request.stateDirectory,
      );

      await this.transition(request, "syncing_skills");
      const resources = await this.options.installResources(
        packageRoot,
        request.targetVersion,
      );
      if (resources.state !== "current") throw resourceSyncFailure(resources);
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

function resourceSyncFailure(
  resources: ManagedResourceSyncStatus,
): UpgradeFailure {
  if (resources.hook.state === "conflict") {
    return new UpgradeFailure({
      code: "hook_conflict",
      summary:
        "A local unmanaged Codex Hook conflicts with Codrive. Move it aside, then retry the update.",
    });
  }
  if (resources.skills.state === "conflict") {
    return new UpgradeFailure({
      code: "skill_conflict",
      summary:
        "A local unmanaged Skill has the same name. Move it aside, then retry the update.",
    });
  }
  return new UpgradeFailure({
    code: "resource_sync_failed",
    summary:
      "Managed Skills and Hook did not match the updated Codrive package. Retry the update.",
  });
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
          error.step === "restart"
            ? "Codrive was installed, but the service could not restart with the current permissions. Repair local service access, then retry."
            : "Codrive could not install the package with the current npm permissions. Repair npm access, then retry.",
      };
    }
    if (error.step === "restart") {
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
  if (phase === "restarting") {
    return {
      code: "service_restart_failed",
      summary: "Codrive was installed, but the service could not restart. Run codrive upgrade to retry.",
    };
  }
  if (phase === "syncing_skills") {
    return {
      code: "resource_sync_failed",
      summary: "Codrive restarted, but its managed resources could not be synchronized. Retry from the Codrive update window.",
    };
  }
  return {
    code: "package_install_failed",
    summary: "The Codrive package could not be installed. Check npm access and run codrive upgrade to retry.",
  };
}
