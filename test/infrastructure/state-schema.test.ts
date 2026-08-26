import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ProjectStore } from "../../src/infrastructure/project-store.js";

describe("Codrive state schema", () => {
  it("initializes an empty directory with the current state contract", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "codrive-state-"));

    await new ProjectStore(stateDirectory).initialize();

    expect(
      JSON.parse(
        await readFile(join(stateDirectory, "state-schema.json"), "utf8"),
      ),
    ).toEqual({
      schemaVersion: 3,
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
  });

  it("accepts the current marker without rewriting it", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "codrive-state-"));
    const marker = '{"schemaVersion":3,"createdAt":"2026-08-26T00:00:00.000Z"}\n';
    await writeFile(join(stateDirectory, "state-schema.json"), marker, "utf8");

    await new ProjectStore(stateDirectory).initialize();

    await expect(
      readFile(join(stateDirectory, "state-schema.json"), "utf8"),
    ).resolves.toBe(marker);
  });

  it("rejects an unsupported schema without modifying persisted state", async () => {
    const stateDirectory = await persistedProjectState();
    const markerPath = join(stateDirectory, "state-schema.json");
    const projectPath = join(
      stateDirectory,
      "projects",
      "project_old",
      "project.json",
    );
    const marker = '{"schemaVersion":2,"migratedAt":"2026-08-25T00:00:00.000Z"}\n';
    await writeFile(markerPath, marker, "utf8");
    const project = await readFile(projectPath, "utf8");

    await expect(new ProjectStore(stateDirectory).initialize()).rejects.toThrow(
      /unsupported Codrive state version 2/i,
    );

    await expect(readFile(markerPath, "utf8")).resolves.toBe(marker);
    await expect(readFile(projectPath, "utf8")).resolves.toBe(project);
  });

  it("rejects unversioned persisted projects without creating a marker", async () => {
    const stateDirectory = await persistedProjectState();
    const markerPath = join(stateDirectory, "state-schema.json");
    const projectPath = join(
      stateDirectory,
      "projects",
      "project_old",
      "project.json",
    );
    const project = await readFile(projectPath, "utf8");

    await expect(new ProjectStore(stateDirectory).initialize()).rejects.toThrow(
      /missing.*state version|unversioned Codrive state/i,
    );

    await expect(readFile(markerPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(projectPath, "utf8")).resolves.toBe(project);
  });
});

async function persistedProjectState(): Promise<string> {
  const stateDirectory = await mkdtemp(join(tmpdir(), "codrive-state-unsupported-"));
  const projectDirectory = join(
    stateDirectory,
    "projects",
    "project_old",
  );
  await mkdir(projectDirectory, { recursive: true });
  await writeFile(
    join(projectDirectory, "project.json"),
    '{"id":"project_old","contextNotes":["old fact"]}\n',
    "utf8",
  );
  return stateDirectory;
}
