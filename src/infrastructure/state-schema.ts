import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { upgradeStateV2ToV3 } from "./state-v2-upgrade.js";
import { upgradeStateV3ToV4 } from "./state-v3-upgrade.js";

const currentStateSchemaVersion = 4;

interface StateSchema {
  schemaVersion: number;
  createdAt?: string;
  migratedAt?: string;
}

export async function initializeStateDirectory(
  stateDirectory: string,
): Promise<void> {
  const schemaPath = join(stateDirectory, "state-schema.json");
  const schema = await readSchema(schemaPath);
  if (schema) {
    if (schema.schemaVersion === 2) {
      const createdAt = validTimestamp(schema.migratedAt, "Codrive state marker");
      const migratedAt = new Date().toISOString();
      await upgradeStateV2ToV3(stateDirectory, migratedAt);
      await atomicWriteJson(schemaPath, {
        schemaVersion: 3,
        createdAt,
      } satisfies StateSchema);
      await upgradeStateV3ToV4(stateDirectory, migratedAt, createdAt);
      return;
    }
    if (schema.schemaVersion === 3) {
      const createdAt = validTimestamp(schema.createdAt, "Codrive state marker");
      await upgradeStateV3ToV4(
        stateDirectory,
        new Date().toISOString(),
        createdAt,
      );
      return;
    }
    if (schema.schemaVersion !== currentStateSchemaVersion) {
      throw new Error(
        `Unsupported Codrive state version ${schema.schemaVersion}; ` +
          `this release requires version ${currentStateSchemaVersion}`,
      );
    }
    validTimestamp(schema.createdAt, "Codrive state marker");
    return;
  }

  if (await hasPersistedProjects(stateDirectory)) {
    throw new Error(
      `Unversioned Codrive state is unsupported; ` +
        `this release requires version ${currentStateSchemaVersion}`,
    );
  }

  await atomicWriteJson(schemaPath, {
    schemaVersion: currentStateSchemaVersion,
    createdAt: new Date().toISOString(),
  } satisfies StateSchema);
}

async function hasPersistedProjects(stateDirectory: string): Promise<boolean> {
  try {
    const entries = await readdir(join(stateDirectory, "projects"), {
      withFileTypes: true,
    });
    return entries.some((entry) => entry.isDirectory());
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
}

async function readSchema(path: string): Promise<StateSchema | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as {
      schemaVersion?: unknown;
      createdAt?: unknown;
      migratedAt?: unknown;
    };
    if (!Number.isInteger(value.schemaVersion)) {
      throw new Error("Codrive state version is missing or invalid");
    }
    return value as StateSchema;
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
}

function validTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, path);
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
