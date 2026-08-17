import type {
  ManagedResourceInstallationStatus,
  ManagedResourceInstaller,
} from "../infrastructure/managed-resource-installer.js";
import { isManagedResourceInstallationComplete } from "../infrastructure/managed-resource-installer.js";
import type { UpgradeCoordinator } from "./upgrade-coordinator.js";
import { managedResourceSyncError } from "./managed-resource-sync.js";

interface ManagedResourceUpgradeReconcilerOptions {
  upgrades: Pick<
    UpgradeCoordinator,
    "read" | "confirmResourceSync" | "failResourceSync"
  >;
  resources: Pick<ManagedResourceInstaller, "getStatus" | "install">;
  currentVersion: string;
}

export class ManagedResourceUpgradeReconciler {
  private activeReconciliation: Promise<void> | null = null;

  constructor(
    private readonly options: ManagedResourceUpgradeReconcilerOptions,
  ) {}

  reconcile(): Promise<void> {
    if (this.activeReconciliation) return this.activeReconciliation;
    this.activeReconciliation = this.reconcileCurrentPackage().finally(() => {
      this.activeReconciliation = null;
    });
    return this.activeReconciliation;
  }

  private async reconcileCurrentPackage(): Promise<void> {
    const upgrade = await this.options.upgrades.read();
    if (
      !upgrade ||
      upgrade.phase !== "succeeded" ||
      upgrade.targetVersion !== this.options.currentVersion ||
      upgrade.resourceSync?.packageVersion === this.options.currentVersion
    ) {
      return;
    }

    let resources: ManagedResourceInstallationStatus | undefined;
    try {
      resources = await this.options.resources.getStatus();
      if (!isManagedResourceInstallationComplete(resources.state)) {
        await this.options.resources.install();
        resources = await this.options.resources.getStatus();
      }
    } catch {
      resources = await this.readStatusAfterFailure();
    }

    if (!resources || !isManagedResourceInstallationComplete(resources.state)) {
      await this.options.upgrades.failResourceSync(
        this.options.currentVersion,
        managedResourceSyncError(resources),
      );
      return;
    }

    await this.options.upgrades.confirmResourceSync(this.options.currentVersion);
  }

  private async readStatusAfterFailure(): Promise<
    ManagedResourceInstallationStatus | undefined
  > {
    try {
      return await this.options.resources.getStatus();
    } catch {
      // An unreadable status is reported as a generic managed-resource failure.
      return undefined;
    }
  }
}
