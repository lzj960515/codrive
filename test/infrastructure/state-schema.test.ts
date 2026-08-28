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
      schemaVersion: 4,
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
  });

  it("accepts the current marker without rewriting it", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "codrive-state-"));
    const marker = '{"schemaVersion":4,"createdAt":"2026-08-26T00:00:00.000Z"}\n';
    await writeFile(join(stateDirectory, "state-schema.json"), marker, "utf8");

    await new ProjectStore(stateDirectory).initialize();

    await expect(
      readFile(join(stateDirectory, "state-schema.json"), "utf8"),
    ).resolves.toBe(marker);
  });

  it("upgrades schema v2 projects and active task executions exactly once", async () => {
    const stateDirectory = await persistedV2State();
    const projectDirectory = join(
      stateDirectory,
      "projects",
      "project_old",
    );
    const taskPath = join(projectDirectory, "tasks", "task_old.json");

    const store = new ProjectStore(stateDirectory);
    await store.initialize();

    const marker = JSON.parse(
      await readFile(join(stateDirectory, "state-schema.json"), "utf8"),
    );
    expect(marker).toEqual({
      schemaVersion: 4,
      createdAt: "2026-08-25T00:00:00.000Z",
      migratedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
    const snapshot = await store.getProject("project_old");
    expect(snapshot?.project).toMatchObject({
      id: "project_old",
      planning: { changeReason: "product_document_updated" },
      productFacts: {
        revision: 1,
        digest: expect.stringMatching(/^sha256:/),
        changedAt: "2026-08-25T01:00:00.000Z",
      },
    });
    expect(snapshot?.project).not.toHaveProperty("contextNotes");
    expect(snapshot?.project).not.toHaveProperty("evaluation");
    expect(snapshot?.tasks[0]).toMatchObject({
      requestedAction: "work",
      currentExecution: {
        action: "work",
        reportOpportunityId: expect.stringMatching(/^report_opportunity_/),
      },
    });
    await expect(
      readFile(
        join(
          stateDirectory,
          "backups",
          "state-v2",
          "projects",
          "project_old",
          "project.json",
        ),
        "utf8",
      ),
    ).resolves.toContain('"contextNotes"');
    await expect(
      readFile(
        join(stateDirectory, "backups", "state-v2", "state-schema.json"),
        "utf8",
      ),
    ).resolves.toContain('"schemaVersion":2');

    const firstTask = await readFile(taskPath, "utf8");
    const firstEvents = await readFile(join(projectDirectory, "events.ndjson"), "utf8");
    expect(firstEvents).toContain('"eventId":"migration_v3_state_project_old"');
    expect(firstEvents).toContain('"eventId":"migration_v3_state_task_old"');
    await new ProjectStore(stateDirectory).initialize();
    await expect(readFile(taskPath, "utf8")).resolves.toBe(firstTask);
    await expect(
      readFile(join(projectDirectory, "events.ndjson"), "utf8"),
    ).resolves.toBe(firstEvents);
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
    const marker = '{"schemaVersion":1,"migratedAt":"2026-08-25T00:00:00.000Z"}\n';
    await writeFile(markerPath, marker, "utf8");
    const project = await readFile(projectPath, "utf8");

    await expect(new ProjectStore(stateDirectory).initialize()).rejects.toThrow(
      /unsupported Codrive state version 1/i,
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

async function persistedV2State(): Promise<string> {
  const stateDirectory = await mkdtemp(join(tmpdir(), "codrive-state-v2-"));
  const projectDirectory = join(
    stateDirectory,
    "projects",
    "project_old",
  );
  const tasksDirectory = join(projectDirectory, "tasks");
  await mkdir(tasksDirectory, { recursive: true });
  await writeFile(
    join(stateDirectory, "state-schema.json"),
    '{"schemaVersion":2,"migratedAt":"2026-08-25T00:00:00.000Z"}\n',
    "utf8",
  );
  await writeFile(
    join(projectDirectory, "PROJECT.md"),
    "# Existing product\n\nCurrent facts.\n",
    "utf8",
  );
  await writeFile(
    join(projectDirectory, "project.json"),
    `${JSON.stringify(
      {
        id: "project_old",
        name: "Existing product",
        repositoryPath: "/tmp/existing-product",
        defaultBranch: "main",
        status: "active",
        scheduling: "running",
        requestedAction: null,
        planning: {
          revision: 2,
          evaluatedRevision: 2,
          changedAt: "2026-08-25T01:00:00.000Z",
          changeReason: "project_decision_recorded",
          lastDecision: { revision: 2 },
        },
        contextNotes: ["Historical product decision"],
        evaluation: { stagnantRounds: 0 },
        createdAt: "2026-08-24T01:00:00.000Z",
        updatedAt: "2026-08-25T01:00:00.000Z",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(
    join(tasksDirectory, "task_old.json"),
    `${JSON.stringify(
      {
        id: "task_old",
        projectId: "project_old",
        title: "Continue existing work",
        description: "Keep the existing attempt reportable.",
        acceptanceCriteria: ["The attempt can report after upgrade."],
        order: 1,
        status: "waiting_for_input",
        requestedAction: "develop",
        currentExecution: {
          attemptId: "attempt_old",
          action: "develop",
          status: "waiting_for_input",
          startedAt: "2026-08-25T01:00:00.000Z",
          modelRouting: {
            model: "gpt-5.6-sol",
            route: "primary",
            retryCount: 0,
          },
        },
        createdAt: "2026-08-25T01:00:00.000Z",
        updatedAt: "2026-08-25T01:00:00.000Z",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(join(projectDirectory, "events.ndjson"), "", "utf8");
  return stateDirectory;
}
