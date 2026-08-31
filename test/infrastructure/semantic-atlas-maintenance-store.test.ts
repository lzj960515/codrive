import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SemanticAtlasMaintenanceStore,
  type SemanticAtlasMaintenanceState,
} from "../../src/infrastructure/semantic-atlas-maintenance-store.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ),
  );
});

describe("SemanticAtlasMaintenanceStore", () => {
  it("starts empty and restores durable requests after restart", async () => {
    const directory = await createStateDirectory();
    const store = new SemanticAtlasMaintenanceStore(directory);
    const state: SemanticAtlasMaintenanceState = {
      schemaVersion: 1,
      handledIntegrationActivityIds: ["activity_handled"],
      requests: [{
        id: "activity_pending",
        projectId: "project_storefront",
        sourceTaskId: "task_checkout",
        createdAt: "2026-08-31T02:00:00.000Z",
      }],
    };

    await expect(store.read()).resolves.toEqual({
      schemaVersion: 1,
      handledIntegrationActivityIds: [],
      requests: [],
    });
    await store.save(state);

    const restartedStore = new SemanticAtlasMaintenanceStore(directory);
    await expect(restartedStore.read()).resolves.toEqual(state);
    await expect(readdir(directory)).resolves.toEqual([
      "semantic-atlas-maintenance.json",
    ]);
    expect((await stat(join(directory, "semantic-atlas-maintenance.json"))).mode & 0o777)
      .toBe(0o600);
  });

  it("fails closed for an unsupported persisted schema", async () => {
    const directory = await createStateDirectory();
    await writeFile(
      join(directory, "semantic-atlas-maintenance.json"),
      `${JSON.stringify({ schemaVersion: 2, requests: [] })}\n`,
      "utf8",
    );

    const store = new SemanticAtlasMaintenanceStore(directory);

    await expect(store.read()).rejects.toThrow(
      "Unsupported Semantic Atlas maintenance state 2",
    );
  });
});

async function createStateDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "codrive-semantic-atlas-state-"));
  directories.push(directory);
  return directory;
}
