import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface CodriveConfig {
  schemaVersion: number;
  host: "127.0.0.1";
  port: number;
  maxConcurrentTasks: number;
  accessToken: string;
  stateDirectory: string;
  codexExecutable?: string;
}

type PersistedCodriveConfig = Omit<CodriveConfig, "schemaVersion"> & {
  schemaVersion?: number;
};

const currentSchemaVersion = 1;

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
      const persisted = await this.readPersisted();
      const config = upgradeConfig(persisted);
      if (persisted.schemaVersion !== currentSchemaVersion) {
        await this.save(config);
      }
      return config;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
      const config: CodriveConfig = {
        schemaVersion: currentSchemaVersion,
        host: "127.0.0.1",
        port: 0,
        maxConcurrentTasks: 4,
        accessToken: randomBytes(32).toString("hex"),
        stateDirectory: this.stateDirectory,
      };
      await this.save(config);
      return config;
    }
  }

  async read(): Promise<CodriveConfig> {
    return upgradeConfig(await this.readPersisted());
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

  private async readPersisted(): Promise<PersistedCodriveConfig> {
    return JSON.parse(
      await readFile(this.configPath, "utf8"),
    ) as PersistedCodriveConfig;
  }
}

function upgradeConfig(config: PersistedCodriveConfig): CodriveConfig {
  if (config.schemaVersion === currentSchemaVersion) {
    return config as CodriveConfig;
  }
  if (config.schemaVersion !== undefined) {
    throw new Error(`Unsupported Codrive config version ${config.schemaVersion}`);
  }
  return {
    ...config,
    schemaVersion: currentSchemaVersion,
    maxConcurrentTasks:
      config.maxConcurrentTasks === 1 ? 4 : config.maxConcurrentTasks,
  };
}
