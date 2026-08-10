import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { ModelRoutingSettings } from "../domain/types.js";

export interface CodriveConfig {
  schemaVersion: 2;
  host: "127.0.0.1";
  port: number;
  maxConcurrentTasks: number;
  models: ModelRoutingSettings;
  accessToken: string;
  stateDirectory: string;
  codexExecutable?: string;
}

const currentSchemaVersion = 2;

export function defaultStateDirectory(): string {
  return process.env.CODEDRIVE_HOME ?? join(homedir(), ".codrive");
}

export class ConfigStore {
  readonly configPath: string;

  constructor(readonly stateDirectory = defaultStateDirectory()) {
    this.configPath = join(stateDirectory, "config.json");
  }

  async loadOrCreate(): Promise<CodriveConfig> {
    await mkdir(this.stateDirectory, { recursive: true });
    try {
      return await this.readPersisted();
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
      const config: CodriveConfig = {
        schemaVersion: currentSchemaVersion,
        host: "127.0.0.1",
        port: 0,
        maxConcurrentTasks: 4,
        models: {
          primary: "gpt-5.6-sol",
          fallback: "gpt-5.6-terra",
        },
        accessToken: randomBytes(32).toString("hex"),
        stateDirectory: this.stateDirectory,
      };
      await this.save(config);
      return config;
    }
  }

  async read(): Promise<CodriveConfig> {
    return this.readPersisted();
  }

  async save(config: CodriveConfig): Promise<void> {
    await mkdir(dirname(this.configPath), { recursive: true });
    const temporaryPath = `${this.configPath}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, this.configPath);
    await chmod(this.configPath, 0o600);
  }

  private async readPersisted(): Promise<CodriveConfig> {
    const config = JSON.parse(await readFile(this.configPath, "utf8")) as {
      schemaVersion?: number;
    };
    if (config.schemaVersion !== currentSchemaVersion) {
      throw new Error(
        `Unsupported Codrive config version ${config.schemaVersion ?? "missing"}`,
      );
    }
    return config as CodriveConfig;
  }
}
