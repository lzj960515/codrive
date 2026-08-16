import { randomUUID, createHash } from "node:crypto";
import {
  access,
  chmod,
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { readPackageVersion } from "./package-metadata.js";

const hookEvents = [
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Stop",
] as const;
const hookScript = "codrive-activity-hook.mjs";
const managedStatusMessage = "Reporting Codrive activity";

export type HookInstallationState =
  | "missing"
  | "outdated"
  | "current"
  | "conflict";

export interface HookInstallationStatus {
  state: HookInstallationState;
  bundledVersion: string;
  installedVersion: string | null;
  managedHookCount: 1;
  conflictPaths: string[];
}

interface InstallationMarker {
  version: string;
  fingerprint: string;
}

type HookConfig = Record<string, unknown> & {
  hooks?: Record<string, unknown>;
};

export interface HookInstallerOptions {
  sourceDirectory?: string;
  targetDirectory?: string;
  configPath?: string;
  version?: string;
}

export class HookInstaller {
  private readonly sourceDirectory: string;
  private readonly targetDirectory: string;
  private readonly configPath: string;
  private readonly version: string | undefined;

  constructor(options: HookInstallerOptions = {}) {
    this.sourceDirectory = options.sourceDirectory ?? resolveBundledHookDirectory();
    this.targetDirectory = options.targetDirectory
      ?? join(homedir(), ".codex", "hooks", "codrive");
    this.configPath = options.configPath ?? join(homedir(), ".codex", "hooks.json");
    this.version = options.version;
  }

  async install(): Promise<string> {
    await this.assertInstallable();
    const marker = await this.createMarker();
    const temporaryTarget = `${this.targetDirectory}.installing-${process.pid}-${randomUUID()}`;
    await mkdir(dirname(this.targetDirectory), { recursive: true });
    await rm(temporaryTarget, { recursive: true, force: true });
    await cp(this.sourceDirectory, temporaryTarget, { recursive: true });
    await writeFile(
      join(temporaryTarget, ".codrive-managed"),
      `${JSON.stringify(marker, null, 2)}\n`,
      "utf8",
    );
    await rm(this.targetDirectory, { recursive: true, force: true });
    await rename(temporaryTarget, this.targetDirectory);

    const config = await this.readConfig();
    await this.writeConfig(installManagedGroups(config, this.managedCommand()));
    return join(this.targetDirectory, hookScript);
  }

  async assertInstallable(): Promise<void> {
    const conflicts = await this.findConflicts();
    if (conflicts.length > 0) {
      throw new Error(
        `Refusing to replace unmanaged Hook at ${conflicts.join(", ")}. Move it before running setup.`,
      );
    }
  }

  async getStatus(): Promise<HookInstallationStatus> {
    const bundledVersion = await this.getBundledVersion();
    const marker = await readMarker(join(this.targetDirectory, ".codrive-managed"));
    const installedVersion = marker?.version ?? null;
    const conflictPaths = await this.findConflicts();
    const common = {
      bundledVersion,
      installedVersion,
      managedHookCount: 1 as const,
      conflictPaths,
    };
    if (conflictPaths.length > 0) return { state: "conflict", ...common };
    if (!(await exists(this.targetDirectory))) return { state: "missing", ...common };

    const config = await this.readConfig();
    if (!hasCurrentManagedGroups(config, this.managedCommand())) {
      return { state: "missing", ...common };
    }
    const bundledFingerprint = await fingerprintDirectory(this.sourceDirectory);
    const installedFingerprint = await fingerprintDirectory(this.targetDirectory);
    if (
      marker?.fingerprint !== bundledFingerprint ||
      installedFingerprint !== bundledFingerprint
    ) {
      return { state: "outdated", ...common };
    }
    return { state: "current", ...common };
  }

  private async findConflicts(): Promise<string[]> {
    const conflicts: string[] = [];
    if (
      (await exists(this.targetDirectory)) &&
      !(await exists(join(this.targetDirectory, ".codrive-managed")))
    ) {
      conflicts.push(this.targetDirectory);
    }
    try {
      const config = await this.readConfig();
      if (hasConflictingManagedGroup(config, this.managedCommand())) {
        conflicts.push(this.configPath);
      }
    } catch {
      if (await exists(this.configPath)) conflicts.push(this.configPath);
    }
    return conflicts;
  }

  private managedCommand(): string {
    return `node ${JSON.stringify(join(this.targetDirectory, hookScript))}`;
  }

  private async readConfig(): Promise<HookConfig> {
    let contents: string;
    try {
      contents = await readFile(this.configPath, "utf8");
    } catch (error) {
      if (isMissingFile(error)) return {};
      throw error;
    }
    const value = JSON.parse(contents) as unknown;
    if (!isRecord(value)) throw new Error("Codex hooks config must be an object");
    if ("hooks" in value && value.hooks !== undefined && !isRecord(value.hooks)) {
      throw new Error("Codex hooks config hooks must be an object");
    }
    return value as HookConfig;
  }

  private async writeConfig(config: HookConfig): Promise<void> {
    await mkdir(dirname(this.configPath), { recursive: true });
    const temporary = `${this.configPath}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, this.configPath);
    await chmod(this.configPath, 0o600);
  }

  private async createMarker(): Promise<InstallationMarker> {
    return {
      version: await this.getBundledVersion(),
      fingerprint: await fingerprintDirectory(this.sourceDirectory),
    };
  }

  private async getBundledVersion(): Promise<string> {
    return this.version ?? readPackageVersion();
  }
}

function installManagedGroups(config: HookConfig, command: string): HookConfig {
  const hooks = isRecord(config.hooks) ? { ...config.hooks } : {};
  for (const configName of hookEvents) {
    const groups = Array.isArray(hooks[configName]) ? hooks[configName] : [];
    const preserved = groups.flatMap((group) => preserveUserHandlers(group, command));
    hooks[configName] = [
      ...preserved,
      {
        hooks: [
          {
            type: "command",
            command,
            async: true,
            timeout: 2,
            statusMessage: managedStatusMessage,
          },
        ],
      },
    ];
  }
  return { ...config, hooks };
}

function preserveUserHandlers(group: unknown, command: string): unknown[] {
  if (!isRecord(group) || !Array.isArray(group.hooks)) return [group];
  const hooks = group.hooks.filter(
    (handler) => !isRecord(handler) || handler.command !== command,
  );
  return hooks.length > 0 ? [{ ...group, hooks }] : [];
}

function hasCurrentManagedGroups(config: HookConfig, command: string): boolean {
  if (!isRecord(config.hooks)) return false;
  return hookEvents.every((configName) => {
    const handlers = managedHandlers(config.hooks?.[configName], command);
    return handlers.length === 1 && isExpectedHandler(handlers[0]!, command);
  });
}

function hasConflictingManagedGroup(config: HookConfig, command: string): boolean {
  if (!isRecord(config.hooks)) return false;
  return Object.values(config.hooks).some(
    (groups) =>
      Array.isArray(groups) &&
      groups.some(
        (group) =>
          isRecord(group) &&
          Array.isArray(group.hooks) &&
          group.hooks.some(
            (handler) =>
              isRecord(handler) &&
              handler.statusMessage === managedStatusMessage &&
              handler.command !== command,
          ),
      ),
  );
}

function managedHandlers(groups: unknown, command: string): Record<string, unknown>[] {
  if (!Array.isArray(groups)) return [];
  return groups.flatMap((group) =>
    isRecord(group) && Array.isArray(group.hooks)
      ? group.hooks.filter(
          (handler): handler is Record<string, unknown> =>
            isRecord(handler) && handler.command === command,
        )
      : [],
  );
}

function isExpectedHandler(handler: Record<string, unknown>, command: string): boolean {
  return (
    handler.type === "command" &&
    handler.command === command &&
    handler.async === true &&
    handler.timeout === 2 &&
    handler.statusMessage === managedStatusMessage
  );
}

function resolveBundledHookDirectory(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  return join(moduleDirectory, "..", "..", "hooks", "codrive");
}

async function fingerprintDirectory(root: string): Promise<string> {
  const hash = createHash("sha256");
  for (const path of await listFiles(root)) {
    hash.update(relative(root, path));
    hash.update("\0");
    hash.update(await readFile(path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function listFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === ".codrive-managed") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(path)));
    else files.push(path);
  }
  return files.sort();
}

async function readMarker(path: string): Promise<InstallationMarker | null> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    return isRecord(value) &&
      typeof value.version === "string" &&
      typeof value.fingerprint === "string"
      ? (value as unknown as InstallationMarker)
      : null;
  } catch (error) {
    if (isMissingFile(error) || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
