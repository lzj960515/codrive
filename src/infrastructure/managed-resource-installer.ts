import { homedir } from "node:os";
import { join } from "node:path";

import {
  HookInstaller,
  type HookInstallationStatus,
} from "./hook-installer.js";
import {
  SkillInstaller,
  type SkillInstallationStatus,
} from "./skill-installer.js";

export type ManagedResourceInstallationState =
  | "missing"
  | "outdated"
  | "current"
  | "conflict";

export interface ManagedResourceInstallationStatus {
  state: ManagedResourceInstallationState;
  bundledVersion: string;
  managedSkillCount: number;
  managedHookCount: number;
  conflictPaths: string[];
  skills: SkillInstallationStatus;
  hook: HookInstallationStatus;
}

export interface ManagedResourceInstallationResult {
  skillPaths: string[];
  hookPath: string;
}

interface ManagedResource {
  assertInstallable(): Promise<void>;
  install(): Promise<unknown>;
  getStatus(): Promise<SkillInstallationStatus | HookInstallationStatus>;
}

export class ManagedResourceInstaller {
  private activeInstallation: Promise<ManagedResourceInstallationResult> | null =
    null;

  constructor(
    private readonly skills: SkillInstaller = new SkillInstaller(),
    private readonly hook: HookInstaller = new HookInstaller(),
  ) {}

  static fromPackageRoot(
    packageRoot: string,
    targetVersion: string,
    userHome = homedir(),
  ): ManagedResourceInstaller {
    return new ManagedResourceInstaller(
      new SkillInstaller(
        join(packageRoot, "skills"),
        join(userHome, ".agents", "skills"),
        targetVersion,
      ),
      new HookInstaller({
        sourceDirectory: join(packageRoot, "hooks", "codrive"),
        targetDirectory: join(userHome, ".codex", "hooks", "codrive"),
        configPath: join(userHome, ".codex", "hooks.json"),
        version: targetVersion,
      }),
    );
  }

  async install(): Promise<ManagedResourceInstallationResult> {
    if (this.activeInstallation) return this.activeInstallation;
    this.activeInstallation = this.installResources();
    try {
      return await this.activeInstallation;
    } finally {
      this.activeInstallation = null;
    }
  }

  private async installResources(): Promise<ManagedResourceInstallationResult> {
    await this.assertAllInstallable();
    const skillPaths = await this.skills.install();
    const hookPath = await this.hook.install();
    return { skillPaths, hookPath };
  }

  async getStatus(): Promise<ManagedResourceInstallationStatus> {
    const [skills, hook] = await Promise.all([
      this.skills.getStatus(),
      this.hook.getStatus(),
    ]);
    return {
      state: combineStates(skills.state, hook.state),
      bundledVersion: skills.bundledVersion,
      managedSkillCount: skills.managedSkillCount,
      managedHookCount: hook.managedHookCount,
      conflictPaths: [...skills.conflictPaths, ...hook.conflictPaths],
      skills,
      hook,
    };
  }

  private async assertAllInstallable(): Promise<void> {
    const resources: ManagedResource[] = [this.skills, this.hook];
    const checks = await Promise.allSettled(
      resources.map((resource) => resource.assertInstallable()),
    );
    const conflicts = checks.flatMap((check) =>
      check.status === "rejected" ? [errorMessage(check.reason)] : [],
    );
    if (conflicts.length > 0) throw new Error(conflicts.join("\n"));
  }
}

function combineStates(
  skills: SkillInstallationStatus["state"],
  hook: HookInstallationStatus["state"],
): ManagedResourceInstallationState {
  if (skills === "conflict" || hook === "conflict") return "conflict";
  if (skills === "missing" || hook === "missing") return "missing";
  if (skills === "outdated" || hook === "outdated") return "outdated";
  return "current";
}

export function isManagedResourceInstallationComplete(
  state: ManagedResourceInstallationState,
): boolean {
  return state === "current";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
