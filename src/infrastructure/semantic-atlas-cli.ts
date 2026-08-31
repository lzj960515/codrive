import { execFile as executeFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";

import type {
  SemanticAtlasClient,
  SemanticAtlasInstallation,
} from "../domain/semantic-atlas.js";

const execFile = promisify(executeFile);

const maintenanceStatusEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  ok: z.literal(true),
  command: z.literal("reconcile status"),
  data: z.object({
    required: z.boolean(),
  }).strict(),
}).passthrough();

export interface SemanticAtlasCliDependencies {
  execute(
    executable: string,
    arguments_: readonly string[],
  ): Promise<{ readonly stdout: string }>;
}

export class SemanticAtlasCli implements SemanticAtlasClient {
  public constructor(
    private readonly dependencies: SemanticAtlasCliDependencies = {
      execute: async (executable, arguments_) => execFile(executable, [...arguments_], {
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 4 * 1024 * 1024,
      }),
    },
  ) {}

  public async readInstallation(): Promise<SemanticAtlasInstallation> {
    try {
      await this.dependencies.execute("semantic-atlas", ["--version"]);
      return { installed: true };
    } catch {
      return { installed: false };
    }
  }

  public async maintenanceRequired(repositoryPath: string): Promise<boolean> {
    const result = await this.dependencies.execute("semantic-atlas", [
      "reconcile",
      "status",
      "--repo",
      repositoryPath,
    ]);
    const parsed = maintenanceStatusEnvelopeSchema.parse(
      JSON.parse(result.stdout) as unknown,
    );
    return parsed.data.required;
  }
}
