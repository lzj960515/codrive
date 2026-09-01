import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface SemanticAtlasMaintenanceRequest {
  id: string;
  projectId: string;
  sourceTaskId: string;
  createdAt: string;
  repositoryPath?: string;
}

export interface SemanticAtlasMaintenanceState {
  schemaVersion: 1;
  handledIntegrationActivityIds: string[];
  requests: SemanticAtlasMaintenanceRequest[];
}

const emptyState = (): SemanticAtlasMaintenanceState => ({
  schemaVersion: 1,
  handledIntegrationActivityIds: [],
  requests: [],
});

export class SemanticAtlasMaintenanceStore {
  private readonly statePath: string;

  public constructor(stateDirectory: string) {
    this.statePath = join(stateDirectory, "semantic-atlas-maintenance.json");
  }

  public async read(): Promise<SemanticAtlasMaintenanceState> {
    try {
      const state = JSON.parse(await readFile(this.statePath, "utf8")) as SemanticAtlasMaintenanceState;
      if (state.schemaVersion !== 1) {
        throw new Error(`Unsupported Semantic Atlas maintenance state ${String(state.schemaVersion)}`);
      }
      return state;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return emptyState();
      }
      throw error;
    }
  }

  public async save(state: SemanticAtlasMaintenanceState): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true });
    const temporaryPath = `${this.statePath}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, this.statePath);
  }
}
