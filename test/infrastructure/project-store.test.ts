import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ProjectStore } from "../../src/infrastructure/project-store.js";

async function createStore() {
  const stateDirectory = await mkdtemp(join(tmpdir(), "codrive-store-"));
  return { stateDirectory, store: new ProjectStore(stateDirectory) };
}

const projectInput = {
  name: "Tiny game",
  repositoryPath: "/workspace/tiny-game",
  defaultBranch: "main",
  productDocument: "# Tiny game\n\nShip a playable loop.\n",
  tasks: [
    {
      title: "Build the loop",
      description: "Create one playable loop.",
      acceptanceCriteria: ["The loop can be completed."],
    },
  ],
};

describe("ProjectStore", () => {
  it("persists product context, task snapshots, and append-only events", async () => {
    const { stateDirectory, store } = await createStore();

    const created = await store.createProject(projectInput);
    const loaded = await store.getProject(created.project.id);
    const productDocument = await readFile(
      store.productDocumentPath(created.project.id),
      "utf8",
    );
    const events = await readFile(
      join(stateDirectory, "projects", created.project.id, "events.ndjson"),
      "utf8",
    );

    expect(loaded).toMatchObject({
      project: { status: "active", scheduling: "running" },
      tasks: [{ status: "backlog", requestedAction: null }],
    });
    expect(productDocument).toContain("Ship a playable loop");
    expect(
      events
        .trim()
        .split("\n")
        .map((line) => (JSON.parse(line) as { type: string }).type),
    ).toEqual(["project.created", "project.activated", "task.created"]);
  });

  it("reads existing schema-v3 project snapshots without archive metadata", async () => {
    const { stateDirectory, store } = await createStore();
    const created = await store.createProject(projectInput);
    const projectPath = join(
      stateDirectory,
      "projects",
      created.project.id,
      "project.json",
    );

    expect(JSON.parse(await readFile(projectPath, "utf8"))).not.toHaveProperty(
      "archivedAt",
    );

    const restartedStore = new ProjectStore(stateDirectory);
    await restartedStore.initialize();

    const loaded = await restartedStore.getProject(created.project.id);
    expect(loaded?.project).toMatchObject({
      id: created.project.id,
      status: "active",
      scheduling: "running",
    });
    expect(loaded?.project).not.toHaveProperty("archivedAt");
  });

  it("updates one task without losing other project state", async () => {
    const { store } = await createStore();
    const created = await store.createProject({
      ...projectInput,
      tasks: [
        ...projectInput.tasks,
        { title: "Second", description: "Second task", acceptanceCriteria: [] },
      ],
    });
    const first = created.tasks[0]!;

    await store.saveTask(created.project.id, {
      ...first,
      status: "working",
      requestedAction: "work",
    });

    const loaded = await store.getProject(created.project.id);
    expect(loaded?.tasks).toHaveLength(2);
    expect(loaded?.tasks.find(({ id }) => id === first.id)).toMatchObject({
      status: "working",
      requestedAction: "work",
    });
  });

  it("matches paths inside a registered repository or task worktree", async () => {
    const { store } = await createStore();
    const created = await store.createProject(projectInput);
    await store.appendEvent({
      schemaVersion: 1,
      eventId: "activity_event_developed",
      type: "task.activity_recorded",
      projectId: created.project.id,
      taskId: created.tasks[0]!.id,
      occurredAt: "2026-08-03T00:00:00.000Z",
      data: {
        activity: {
          id: "activity_developed",
          projectId: created.project.id,
          taskId: created.tasks[0]!.id,
          type: "work_completed",
          action: "work",
          outcome: "completed",
          workActivityId: "activity_developed",
          attemptId: "develop_1",
          summary: "Implemented",
          occurredAt: "2026-08-03T00:00:00.000Z",
          evidence: {
            workspacePath: "/workspace/tiny-game/.worktrees/loop",
            candidateCommit: "candidate_1",
          },
        },
      },
    });

    await expect(
      store.findProjectsByPath("/workspace/tiny-game/src/game"),
    ).resolves.toHaveLength(1);
    await expect(
      store.findProjectsByPath("/workspace/tiny-game/.worktrees/loop/src"),
    ).resolves.toHaveLength(1);
    await expect(store.findProjectsByPath("/workspace/other")).resolves.toEqual([]);
  });

  it("rebuilds missing snapshots from the append-only event log", async () => {
    const { stateDirectory, store } = await createStore();
    const created = await store.createProject(projectInput);
    const selected = {
      ...created.tasks[0]!,
      requestedAction: "work" as const,
    };
    await store.saveTask(created.project.id, selected);
    await store.appendEvent({
      schemaVersion: 1,
      eventId: "event_selected",
      type: "task.selected",
      projectId: created.project.id,
      taskId: selected.id,
      occurredAt: "2026-08-03T00:00:00.000Z",
    });

    await rm(join(stateDirectory, "projects", created.project.id, "project.json"));
    await rm(store.taskPath(created.project.id, selected.id));

    const restartedStore = new ProjectStore(stateDirectory);
    await restartedStore.initialize();

    expect(await restartedStore.getProject(created.project.id)).toMatchObject({
      project: { name: "Tiny game" },
      tasks: [{ status: "backlog", requestedAction: "work" }],
    });
  });

  it("interrupts stale selection when PROJECT.md changes while Codrive is stopped", async () => {
    const { stateDirectory, store } = await createStore();
    const created = await store.createProject(projectInput);
    await store.saveProject({
      ...created.project,
      requestedAction: "select_tasks",
      currentExecution: {
        attemptId: "selection_1",
        action: "select_tasks",
        status: "running",
        threadId: "thread_1",
        turnId: "turn_1",
        startedAt: "2026-08-26T00:00:00.000Z",
        modelRouting: {
          model: "gpt-5.6-sol",
          route: "primary",
          retryCount: 0,
        },
      },
    });
    await writeFile(
      store.productDocumentPath(created.project.id),
      "# Tiny game\n\nChanged while stopped.\n",
    );

    const restartedStore = new ProjectStore(stateDirectory);
    await restartedStore.initialize();

    const project = (await restartedStore.getProject(created.project.id))!.project;
    expect(project).toMatchObject({
      requestedAction: null,
      productFacts: created.project.productFacts,
      currentExecution: { attemptId: "selection_1", status: "interrupted" },
    });
    expect(await restartedStore.listProjectEvents(created.project.id)).toContainEqual(
      expect.objectContaining({
        type: "project.product_document_modified",
        data: expect.objectContaining({
          acceptedDocumentDigest: created.project.productFacts.digest,
        }),
      }),
    );
  });
});
