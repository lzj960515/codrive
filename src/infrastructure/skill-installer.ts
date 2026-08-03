import { createHash } from "node:crypto";
import {
  access,
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

const managedSkills = [
  "codrive-forge",
  "codrive-task",
  "codrive-work",
  "codrive-control",
];

export type SkillInstallationState =
  | "missing"
  | "outdated"
  | "current"
  | "conflict";

export interface SkillInstallationStatus {
  state: SkillInstallationState;
  bundledVersion: string;
  installedVersion: string | null;
}

interface InstallationMarker {
  version: string;
  fingerprint: string;
}

export class SkillInstaller {
  constructor(
    private readonly sourceDirectory = resolveBundledSkillsDirectory(),
    private readonly targetDirectory = join(homedir(), ".agents", "skills"),
    private readonly version?: string,
  ) {}

  async install(): Promise<string[]> {
    await mkdir(this.targetDirectory, { recursive: true });
    const installationMarker = await this.createMarker();
    for (const skill of managedSkills) {
      const source = join(this.sourceDirectory, skill);
      const target = join(this.targetDirectory, skill);
      const markerPath = join(target, ".codrive-managed");
      if ((await exists(target)) && !(await exists(markerPath))) {
        throw new Error(
          `Refusing to replace unmanaged Skill at ${target}. Move it before running setup.`,
        );
      }

      const temporary = `${target}.installing-${process.pid}`;
      await rm(temporary, { recursive: true, force: true });
      await cp(source, temporary, { recursive: true });
      await writeFile(
        join(temporary, ".codrive-managed"),
        `${JSON.stringify(installationMarker, null, 2)}\n`,
        "utf8",
      );
      await rm(target, { recursive: true, force: true });
      await rename(temporary, target);
    }
    return managedSkills.map((skill) => join(this.targetDirectory, skill));
  }

  async getStatus(): Promise<SkillInstallationStatus> {
    const bundledVersion = await this.getBundledVersion();
    const targetStates = await Promise.all(
      managedSkills.map(async (skill) => {
        const target = join(this.targetDirectory, skill);
        return {
          exists: await exists(target),
          marker: await readMarker(join(target, ".codrive-managed")),
        };
      }),
    );
    const installedVersion =
      targetStates.find(({ marker }) => marker?.version)?.marker?.version ?? null;

    if (targetStates.every(({ exists: targetExists }) => !targetExists)) {
      return { state: "missing", bundledVersion, installedVersion };
    }
    if (
      targetStates.some(
        ({ exists: targetExists, marker }) => targetExists && marker === undefined,
      )
    ) {
      return { state: "conflict", bundledVersion, installedVersion };
    }
    if (targetStates.some(({ exists: targetExists }) => !targetExists)) {
      return { state: "missing", bundledVersion, installedVersion };
    }

    const bundledFingerprint = await fingerprintBundle(this.sourceDirectory);
    const installedFingerprint = await fingerprintBundle(this.targetDirectory);
    const markersMatch = targetStates.every(
      ({ marker }) =>
        marker?.version === bundledVersion &&
        marker.fingerprint === bundledFingerprint,
    );
    return {
      state:
        markersMatch && installedFingerprint === bundledFingerprint
          ? "current"
          : "outdated",
      bundledVersion,
      installedVersion,
    };
  }

  private async createMarker(): Promise<InstallationMarker> {
    return {
      version: await this.getBundledVersion(),
      fingerprint: await fingerprintBundle(this.sourceDirectory),
    };
  }

  private async getBundledVersion(): Promise<string> {
    if (this.version) return this.version;
    const packageJson = JSON.parse(
      await readFile(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    return packageJson.version;
  }
}

function resolveBundledSkillsDirectory(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  return join(moduleDirectory, "..", "..", "skills");
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readMarker(
  path: string,
): Promise<InstallationMarker | null | undefined> {
  try {
    const contents = await readFile(path, "utf8");
    try {
      return JSON.parse(contents) as InstallationMarker;
    } catch {
      return null;
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function fingerprintBundle(root: string): Promise<string> {
  const hash = createHash("sha256");
  for (const skill of [...managedSkills].sort()) {
    const directory = join(root, skill);
    for (const path of await listFiles(directory)) {
      const relativePath = join(skill, relative(directory, path));
      hash.update(relativePath);
      hash.update("\0");
      hash.update(await readFile(path));
      hash.update("\0");
    }
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
