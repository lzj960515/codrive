import { mkdtemp, readFile, rm } from "node:fs/promises";
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
      status: "developing",
      requestedAction: "develop",
    });

    const loaded = await store.getProject(created.project.id);
    expect(loaded?.tasks).toHaveLength(2);
    expect(loaded?.tasks.find(({ id }) => id === first.id)).toMatchObject({
      status: "developing",
      requestedAction: "develop",
    });
  });

  it("matches paths inside a registered repository or task worktree", async () => {
    const { store } = await createStore();
    const created = await store.createProject(projectInput);
    await store.saveTask(created.project.id, {
      ...created.tasks[0]!,
      workspacePath: "/workspace/tiny-game/.worktrees/loop",
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
      requestedAction: "develop" as const,
    };
    await store.saveTask(created.project.id, selected);
    await store.appendEvent({
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
      tasks: [{ status: "backlog", requestedAction: "develop" }],
    });
  });
});
