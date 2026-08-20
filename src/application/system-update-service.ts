import { SystemUpdateConflictError } from "../domain/errors.js";
import { isActiveUpgradePhase } from "../domain/system-update.js";
import {
  isManagedResourceInstallationComplete,
  type ManagedResourceInstaller,
} from "../infrastructure/managed-resource-installer.js";
import type { PackageVersionService } from "../infrastructure/package-version-service.js";
import type { PackageVersionCheckTrigger } from "./package-version-check-scheduler.js";
import type { UpgradeCoordinator } from "./upgrade-coordinator.js";
import type { HookRuntimeStatusReader } from "./managed-hook-runtime-inspector.js";

export class SystemUpdateService {
  constructor(
    private readonly versions: PackageVersionService,
    private readonly upgrades: UpgradeCoordinator,
    private readonly resources: ManagedResourceInstaller,
    private readonly versionChecks: PackageVersionCheckTrigger,
    private readonly hookRuntime: HookRuntimeStatusReader,
  ) {}

  async read() {
    const [version, upgrade, resources, hookRuntime] = await Promise.all([
      this.versions.read(),
      this.upgrades.read(),
      this.resources.getStatus(),
      this.hookRuntime.read(),
    ]);
    return {
      version,
      upgrade,
      resources,
      skills: resources.skills,
      hook: resources.hook,
      hookRuntime,
    };
  }

  async refresh() {
    await this.versionChecks.checkNow();
    return this.read();
  }

  async start(targetVersion: string) {
    await this.upgrades.start(targetVersion);
    return this.read();
  }

  async installResources() {
    const activeUpgrade = await this.upgrades.read();
    if (activeUpgrade && isActiveUpgradePhase(activeUpgrade.phase)) {
      throw new SystemUpdateConflictError(
        `Codrive is already updating to ${activeUpgrade.targetVersion}`,
      );
    }
    await this.resources.install();
    const [version, resources] = await Promise.all([
      this.versions.read(),
      this.resources.getStatus(),
    ]);
    if (isManagedResourceInstallationComplete(resources.state)) {
      await this.upgrades.completeAfterResourceRepair(version.currentVersion);
    }
    return this.read();
  }

  installSkills() {
    return this.installResources();
  }
}
