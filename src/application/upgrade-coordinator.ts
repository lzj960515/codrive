import { randomUUID } from "node:crypto";

import {
  assertStableSemanticVersion,
  compareSemanticVersions,
  isActiveUpgradePhase,
  type PackageVersionStatus,
  type UpgradeState,
} from "../domain/system-update.js";
import { SystemUpdateConflictError } from "../domain/errors.js";
import type { UpgradeStateStore } from "../infrastructure/upgrade-state-store.js";

export interface UpgradeRequest {
  operationId: string;
  targetVersion: string;
  stateDirectory: string;
}

export interface UpgradeLauncher {
  launch(request: UpgradeRequest): Promise<number>;
}

export interface UpgradeCoordinatorOptions {
  store: UpgradeStateStore;
  versions: Pick<{ read(): Promise<PackageVersionStatus> }, "read">;
  launcher: UpgradeLauncher;
  stateDirectory?: string;
  now?: () => Date;
  createOperationId?: () => string;
  isProcessRunning?: (pid: number) => boolean;
}

export class UpgradeCoordinator {
  private readonly now: () => Date;
  private readonly createOperationId: () => string;
  private readonly isProcessRunning: (pid: number) => boolean;

  constructor(private readonly options: UpgradeCoordinatorOptions) {
    this.now = options.now ?? (() => new Date());
    this.createOperationId = options.createOperationId ?? (() => `upgrade_${randomUUID()}`);
    this.isProcessRunning = options.isProcessRunning ?? processIsRunning;
  }

  read(): Promise<UpgradeState | null> {
    return this.options.store.read();
  }

  async reconcile(): Promise<UpgradeState | null> {
    const current = await this.options.store.read();
    const workerIsStarting =
      current?.workerPid === undefined &&
      current?.phase === "checking" &&
      this.now().getTime() - Date.parse(current.updatedAt) < 10_000;
    if (
      !current ||
      !isActiveUpgradePhase(current.phase) ||
      workerIsStarting ||
      (current.workerPid !== undefined && this.isProcessRunning(current.workerPid))
    ) {
      return current;
    }
    const timestamp = this.now().toISOString();
    const failed: UpgradeState = {
      ...current,
      phase: "failed",
      updatedAt: timestamp,
      completedAt: timestamp,
      phaseStartedAt: { ...current.phaseStartedAt, failed: timestamp },
      error: {
        code: "package_install_failed",
        summary: "The previous Codrive update process stopped before completion. Retry the update.",
      },
    };
    await this.options.store.write(failed);
    return failed;
  }

  async start(targetVersion: string): Promise<UpgradeState> {
    return this.options.store.withStartLock(() =>
      this.startExclusive(targetVersion),
    );
  }

  completeAfterResourceRepair(currentVersion: string): Promise<UpgradeState | null> {
    return this.options.store.withStartLock(() =>
      this.completeAfterResourceRepairExclusive(currentVersion),
    );
  }

  private async completeAfterResourceRepairExclusive(
    currentVersion: string,
  ): Promise<UpgradeState | null> {
    const current = await this.options.store.read();
    if (
      !current ||
      current.phase !== "failed" ||
      current.targetVersion !== currentVersion
    ) {
      return current;
    }
    const timestamp = this.now().toISOString();
    const succeeded: UpgradeState = {
      ...current,
      phase: "succeeded",
      updatedAt: timestamp,
      completedAt: timestamp,
      phaseStartedAt: { ...current.phaseStartedAt, succeeded: timestamp },
    };
    delete succeeded.error;
    await this.options.store.write(succeeded);
    return succeeded;
  }
  private async startExclusive(targetVersion: string): Promise<UpgradeState> {
    assertStableSemanticVersion(targetVersion);
    const existing = await this.reconcile();
    if (existing && isActiveUpgradePhase(existing.phase)) {
      if (existing.targetVersion !== targetVersion) {
        throw new SystemUpdateConflictError(
          `Codrive is already updating to ${existing.targetVersion}`,
        );
      }
      return existing;
    }

    const versions = await this.options.versions.read();
    if (versions.latestVersion !== targetVersion) {
      throw new SystemUpdateConflictError("The selected Codrive version is no longer the checked latest version");
    }
    if (compareSemanticVersions(versions.currentVersion, targetVersion) >= 0) {
      throw new SystemUpdateConflictError(`Codrive ${targetVersion} is already running`);
    }

    const timestamp = this.now().toISOString();
    const state: UpgradeState = {
      operationId: this.createOperationId(),
      targetVersion,
      phase: "checking",
      startedAt: timestamp,
      updatedAt: timestamp,
      phaseStartedAt: { checking: timestamp },
    };
    await this.options.store.write(state);
    let workerPid: number;
    try {
      workerPid = await this.options.launcher.launch({
        operationId: state.operationId,
        targetVersion,
        stateDirectory: this.options.stateDirectory ?? "",
      });
    } catch (error) {
      const failedAt = this.now().toISOString();
      await this.options.store.write({
        ...state,
        phase: "failed",
        updatedAt: failedAt,
        completedAt: failedAt,
        phaseStartedAt: { ...state.phaseStartedAt, failed: failedAt },
        error: {
          code: "package_install_failed",
          summary: "Codrive could not start the independent update process. Retry the update.",
        },
      });
      throw error;
    }
    const launched = { ...state, workerPid };
    await this.options.store.write(launched);
    return launched;
  }
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
