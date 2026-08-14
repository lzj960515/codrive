import { SystemUpdateConflictError } from "../domain/errors.js";
import { isActiveUpgradePhase } from "../domain/system-update.js";
import type { PackageVersionService } from "../infrastructure/package-version-service.js";
import type { SkillInstaller } from "../infrastructure/skill-installer.js";
import type { PackageVersionCheckTrigger } from "./package-version-check-scheduler.js";
import type { UpgradeCoordinator } from "./upgrade-coordinator.js";

export class SystemUpdateService {
  constructor(
    private readonly versions: PackageVersionService,
    private readonly upgrades: UpgradeCoordinator,
    private readonly skills: SkillInstaller,
    private readonly versionChecks: PackageVersionCheckTrigger,
  ) {}

  async read() {
    const [version, upgrade, skills] = await Promise.all([
      this.versions.read(),
      this.upgrades.read(),
      this.skills.getStatus(),
    ]);
    return { version, upgrade, skills };
  }

  async refresh() {
    await this.versionChecks.checkNow();
    return this.read();
  }

  async start(targetVersion: string) {
    await this.upgrades.start(targetVersion);
    return this.read();
  }

  async installSkills() {
    const activeUpgrade = await this.upgrades.read();
    if (activeUpgrade && isActiveUpgradePhase(activeUpgrade.phase)) {
      throw new SystemUpdateConflictError(
        `Codrive is already updating to ${activeUpgrade.targetVersion}`,
      );
    }
    await this.skills.install();
    const [version, skills] = await Promise.all([
      this.versions.read(),
      this.skills.getStatus(),
    ]);
    if (skills.state === "current") {
      await this.upgrades.completeAfterSkillRepair(version.currentVersion);
    }
    return this.read();
  }
}
