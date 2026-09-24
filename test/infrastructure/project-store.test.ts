import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ProjectStore } from "../../src/infrastructure/project-store.js";
import { readTaskDocument } from "../../src/infrastructure/task-document.js";

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
  it("registers a task by document path and reads later edits from the source file", async () => {
    const { stateDirectory, store } = await createStore();
    const repositoryPath = join(stateDirectory, "repository");
    const taskDocumentPath = "docs/tasks/playable-loop.md";
    const documentFile = join(repositoryPath, taskDocumentPath);
    await mkdir(join(repositoryPath, "docs/tasks"), { recursive: true });
    await writeFile(documentFile, "# 可玩的主流程\n\n完成一局游戏。\n");

    const created = await store.createProject({
      ...projectInput,
      repositoryPath,
      tasks: [{ title: "完成可玩的主流程", taskDocumentPath }],
    });
    const task = created.tasks[0]!;

    expect(task).toMatchObject({ title: "完成可玩的主流程", taskDocumentPath });
    expect(task).not.toHaveProperty("description");
    expect(task).not.toHaveProperty("acceptanceCriteria");
    await expect(readTaskDocument(repositoryPath, taskDocumentPath)).resolves.toContain("完成一局游戏");

    await writeFile(documentFile, "# 可玩的主流程\n\n完成两局游戏。\n");
    await expect(readTaskDocument(repositoryPath, taskDocumentPath)).resolves.toContain("完成两局游戏");
  });

  it("rejects a new task whose document is absent or empty", async () => {
    const { stateDirectory, store } = await createStore();
    const repositoryPath = join(stateDirectory, "repository");
    await mkdir(repositoryPath, { recursive: true });

    await expect(store.createProject({
      ...projectInput,
      repositoryPath,
      tasks: [{ title: "缺少说明", taskDocumentPath: "docs/tasks/missing.md" }],
    })).rejects.toThrow(/document/i);

    await mkdir(join(repositoryPath, "docs/tasks"), { recursive: true });
    await writeFile(join(repositoryPath, "docs/tasks/empty.md"), " \n");
    await expect(store.createProject({
      ...projectInput,
      repositoryPath,
      tasks: [{ title: "空说明", taskDocumentPath: "docs/tasks/empty.md" }],
    })).rejects.toThrow(/document/i);

    const outsideDocument = join(stateDirectory, "outside.md");
    await writeFile(outsideDocument, "# 仓库外的说明\n");
    await expect(store.createProject({
      ...projectInput,
      repositoryPath,
      tasks: [{ title: "越界路径", taskDocumentPath: "../outside.md" }],
    })).rejects.toThrow(/inside the project repository/i);
    await expect(store.createProject({
      ...projectInput,
      repositoryPath,
      tasks: [{ title: "绝对路径", taskDocumentPath: outsideDocument }],
    })).rejects.toThrow(/inside the project repository/i);
  });

  it("persists milestone membership and restores milestone snapshots from activity events", async () => {
    const { stateDirectory, store } = await createStore();
    const created = await store.createProject({ ...projectInput, tasks: [], milestones: [{
      title: "Deliver the loop", description: "Finish the stage", acceptanceCriteria: ["Playable"], tasks: projectInput.tasks,
    }] });
    expect(created.milestones).toHaveLength(1);
    const milestone = created.milestones[0]!;
    expect(created.tasks[0]?.milestoneId).toBe(milestone.id);
    const activity = {
      id: "discovery_1", projectId: created.project.id, milestoneId: milestone.id,
      type: "discovery" as const, taskId: created.tasks[0]!.id, attemptId: "attempt_1", requestId: "request_1",
      summary: "One dependency remains", evidence: ["src/loop.ts"], affectedTaskIds: [], occurredAt: milestone.createdAt,
    };
    await store.appendEvent({ schemaVersion: 1, eventId: "event_discovery", type: "milestone.activity_recorded", projectId: created.project.id,
      milestoneId: milestone.id, occurredAt: milestone.createdAt, data: { milestoneActivity: activity } });
    await rm(store.milestonePath(created.project.id, milestone.id));
    const restarted = new ProjectStore(stateDirectory);
    await restarted.initialize();
    expect((await restarted.findMilestone(milestone.id))?.milestone).toEqual(milestone);
    expect(await restarted.listMilestoneActivities(created.project.id, milestone.id)).toEqual([activity]);
  });

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

  it("reads current project snapshots without optional archive metadata", async () => {
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
        reportOpportunityId: "report_selection_1",
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
