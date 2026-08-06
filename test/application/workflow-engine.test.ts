import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { WorkflowEngine } from "../../src/application/workflow-engine.js";
import type { ProjectReport, Task } from "../../src/domain/types.js";
import { ProjectStore } from "../../src/infrastructure/project-store.js";
import {
  RecordingProjectExecutor,
  RecordingTaskDispatcher,
} from "../support/recording-executors.js";

let store: ProjectStore;
let taskDispatcher: RecordingTaskDispatcher;
let projectExecutor: RecordingProjectExecutor;
let workflow: WorkflowEngine;
let id = 0;

beforeEach(async () => {
  store = new ProjectStore(await mkdtemp(join(tmpdir(), "codrive-workflow-")));
  taskDispatcher = new RecordingTaskDispatcher();
  projectExecutor = new RecordingProjectExecutor();
  workflow = new WorkflowEngine(
    store,
    taskDispatcher,
    {
      maxConcurrentTasks: 2,
      now: () => "2026-08-03T00:00:00.000Z",
      createId: (prefix) => `${prefix}_${++id}`,
    },
    projectExecutor,
  );
  id = 0;
});

async function registerProject(taskCount = 2) {
  return workflow.registerProject({
    name: "Tiny Game",
    repositoryPath: "/workspace/game",
    defaultBranch: "main",
    productDocument: "# Tiny Game\n",
    tasks: Array.from({ length: taskCount }, (_, index) => ({
      title: `Task ${index + 1}`,
      description: `Build task ${index + 1}`,
      acceptanceCriteria: [],
    })),
  });
}

async function finishProjectExecution(report: Omit<ProjectReport, "attemptId">) {
  const snapshot = (await store.getProject(report.projectId))!;
  const execution = snapshot.project.currentExecution!;
  await workflow.submitProjectReport({ ...report, attemptId: execution.attemptId });
  return workflow.completeProjectTurn(
    report.projectId,
    execution.attemptId,
    execution.turnId!,
  );
}

describe("WorkflowEngine", () => {
  it("persists a project thread before starting its turn", async () => {
    projectExecutor.beforeStartTurn = async (project, threadId) => {
      const stored = (await store.getProject(project.id))!.project;
      expect(stored.currentExecution?.threadId).toBe(threadId);
      expect(stored.currentExecution?.turnId).toBeUndefined();
    };

    await registerProject();

    expect(projectExecutor.started).toHaveLength(1);
  });

  it("starts independent task conversations only after AI selects their IDs", async () => {
    const created = await registerProject();
    const selectedIds = created.tasks.map(({ id }) => id);

    await finishProjectExecution({
      projectId: created.project.id,
      outcome: "selected",
      summary: "Both tasks can start",
      taskIds: selectedIds,
    });

    expect(taskDispatcher.started.map(({ task }) => task.id)).toEqual(selectedIds);
    expect(new Set(taskDispatcher.started.map(({ threadId }) => threadId)).size).toBe(
      selectedIds.length,
    );
    const updated = (await store.getProject(created.project.id))!;
    expect(updated.tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "developing", requestedAction: "develop" }),
        expect.objectContaining({ status: "developing", requestedAction: "develop" }),
      ]),
    );
  });

  it("reevaluates unchanged tasks when the concurrency limit increases", async () => {
    const created = await store.createProject({
      name: "Tiny Game",
      repositoryPath: "/workspace/game",
      defaultBranch: "main",
      productDocument: "# Tiny Game\n",
      tasks: [
        { title: "Foundation", description: "Build it", acceptanceCriteria: [] },
        { title: "Gameplay", description: "Build it too", acceptanceCriteria: [] },
      ],
    });
    await store.saveTask(created.project.id, {
      ...created.tasks[0]!,
      status: "developing",
      requestedAction: "develop",
      currentExecution: {
        attemptId: "attempt_1",
        action: "develop",
        status: "running",
        startedAt: "2026-08-03T00:00:00.000Z",
      },
    });

    const singleTaskWorkflow = new WorkflowEngine(
      store,
      new RecordingTaskDispatcher(),
      { maxConcurrentTasks: 1 },
      new RecordingProjectExecutor(),
    );
    await singleTaskWorkflow.reconcile();

    const expandedExecutor = new RecordingProjectExecutor();
    const expandedWorkflow = new WorkflowEngine(
      store,
      new RecordingTaskDispatcher(),
      { maxConcurrentTasks: 4 },
      expandedExecutor,
    );
    await expandedWorkflow.reconcile();

    expect(expandedExecutor.started).toHaveLength(1);
    expect(expandedExecutor.started[0]?.project.requestedAction).toBe(
      "select_tasks",
    );
  });

  it("fills a newly available slot immediately after another project finishes", async () => {
    const activeProject = await store.createProject({
      name: "Active Game",
      repositoryPath: "/workspace/active-game",
      defaultBranch: "main",
      productDocument: "# Active Game\n",
      tasks: [
        { title: "Foundation", description: "Build it", acceptanceCriteria: [] },
      ],
    });
    await store.saveTask(activeProject.project.id, {
      ...activeProject.tasks[0]!,
      status: "developing",
      requestedAction: "develop",
      currentExecution: {
        attemptId: "attempt_active",
        action: "develop",
        status: "running",
        startedAt: "2026-08-03T00:00:00.000Z",
      },
    });
    const waitingProject = await store.createProject({
      name: "Waiting Game",
      repositoryPath: "/workspace/waiting-game",
      defaultBranch: "main",
      productDocument: "# Waiting Game\n",
      tasks: [
        { title: "Gameplay", description: "Build it", acceptanceCriteria: [] },
      ],
    });
    const singleSlotExecutor = new RecordingProjectExecutor();
    const singleSlotWorkflow = new WorkflowEngine(
      store,
      new RecordingTaskDispatcher(),
      { maxConcurrentTasks: 1 },
      singleSlotExecutor,
    );

    await singleSlotWorkflow.reconcile();
    expect(singleSlotExecutor.started).toHaveLength(0);

    await store.saveTask(activeProject.project.id, {
      ...activeProject.tasks[0]!,
      status: "done",
      requestedAction: null,
      currentExecution: {
        attemptId: "attempt_active",
        action: "integrate",
        status: "completed",
        startedAt: "2026-08-03T00:00:00.000Z",
        finishedAt: "2026-08-03T01:00:00.000Z",
      },
      mergedCommit: "main_1",
    });

    await singleSlotWorkflow.reconcile();

    const selections = singleSlotExecutor.started.filter(
      ({ project }) => project.requestedAction === "select_tasks",
    );
    expect(selections).toHaveLength(1);
    expect(selections[0]?.project.id).toBe(waitingProject.project.id);
  });

  it("persists a task thread before starting its turn", async () => {
    const created = await registerProject(1);
    taskDispatcher.beforeStartTurn = async (request, threadId) => {
      const stored = (await store.findTask(request.task.id))!.task;
      expect(stored.currentExecution?.threadId).toBe(threadId);
      expect(stored.currentExecution?.turnId).toBeUndefined();
    };

    await finishProjectExecution({
      projectId: created.project.id,
      outcome: "selected",
      summary: "Start the task",
      taskIds: [created.tasks[0]!.id],
    });

    expect(taskDispatcher.started).toHaveLength(1);
  });

  it("lets the same project turn correct invalid task selection reports", async () => {
    const created = await registerProject(3);
    const project = (await store.getProject(created.project.id))!.project;
    const execution = project.currentExecution!;

    const expectRejectedWithoutEndingTurn = async (
      report: Pick<ProjectReport, "outcome" | "summary" | "taskIds">,
      expectedError: RegExp,
    ) => {
      await expect(
        workflow.submitProjectReport({
          projectId: created.project.id,
          attemptId: execution.attemptId,
          ...report,
        }),
      ).rejects.toThrow(expectedError);

      const rejected = (await store.getProject(project.id))!.project;
      expect(rejected.latestReport).toBeUndefined();
      expect(rejected.currentExecution).toMatchObject({
        attemptId: execution.attemptId,
        threadId: execution.threadId,
        turnId: execution.turnId,
        status: "running",
      });
      expect(rejected.currentExecution?.report).toBeUndefined();
    };

    await expectRejectedWithoutEndingTurn(
      {
        outcome: "selected",
        summary: "Duplicate selection",
        taskIds: [created.tasks[0]!.id, created.tasks[0]!.id],
      },
      /unique/i,
    );
    await expectRejectedWithoutEndingTurn(
      {
        outcome: "selected",
        summary: "Unknown task",
        taskIds: ["task_does_not_exist"],
      },
      new RegExp(`not available.*Available task IDs:.*${created.tasks[0]!.id}`, "i"),
    );
    await expectRejectedWithoutEndingTurn(
      {
        outcome: "selected",
        summary: "Too many tasks",
        taskIds: created.tasks.map(({ id }) => id),
      },
      /only 2 slots are available/i,
    );
    await expectRejectedWithoutEndingTurn(
      {
        outcome: "wait_for_active_tasks",
        summary: "Wait without ongoing work",
      },
      /requires at least one ongoing task/i,
    );
    expect(projectExecutor.opened).toHaveLength(1);
    expect(projectExecutor.started).toHaveLength(1);

    await workflow.submitProjectReport({
      projectId: created.project.id,
      attemptId: execution.attemptId,
      outcome: "selected",
      summary: "Corrected selection",
      taskIds: created.tasks.slice(0, 2).map(({ id }) => id),
    });
    await workflow.completeProjectTurn(
      project.id,
      execution.attemptId,
      execution.turnId!,
    );

    expect(projectExecutor.opened).toHaveLength(1);
    expect(projectExecutor.started).toHaveLength(1);
    expect(taskDispatcher.started.map(({ task }) => task.id)).toEqual(
      created.tasks.slice(0, 2).map(({ id }) => id),
    );
  });

  it("keeps project lifecycle and scheduling control independent", async () => {
    const created = await store.createProject({
      name: "Tiny Game",
      repositoryPath: "/workspace/game",
      defaultBranch: "main",
      productDocument: "# Tiny Game\n",
      tasks: [
        { title: "Task", description: "Build it", acceptanceCriteria: [] },
      ],
    });

    const paused = await workflow.controlProject(created.project.id, "pause");
    expect(paused).toMatchObject({ status: "active", scheduling: "paused" });

    const withWork = await workflow.addProjectWork(created.project.id, [
      { title: "More", description: "Add more", acceptanceCriteria: [] },
    ]);
    expect(withWork.project).toMatchObject({
      status: "active",
      scheduling: "paused",
    });

    const resumed = await workflow.controlProject(created.project.id, "resume");
    expect(resumed.scheduling).toBe("running");
    expect(projectExecutor.started).toHaveLength(1);
  });

  it("clears a resolved project question when its decision is recorded", async () => {
    const created = await store.createProject({
      name: "Tiny Game",
      repositoryPath: "/workspace/game",
      defaultBranch: "main",
      productDocument: "# Tiny Game\n",
      tasks: [{ title: "Task", description: "Build it", acceptanceCriteria: [] }],
    });
    const report = {
      projectId: created.project.id,
      attemptId: "selection_1",
      outcome: "needs_input" as const,
      summary: "Need a product decision",
      question: "Keyboard or controller?",
    };
    await store.saveProject({
      ...created.project,
      status: "waiting_for_input",
      latestReport: report,
      currentExecution: {
        attemptId: report.attemptId,
        action: "select_tasks",
        status: "completed",
        startedAt: "2026-08-03T00:00:00.000Z",
        report,
      },
    });

    const project = await workflow.recordProjectDecision(
      created.project.id,
      "Use both keyboard and controller.",
    );

    expect(project.status).not.toBe("waiting_for_input");
    expect(project.latestReport).toBeUndefined();
  });

  it("restarts temporary project selection when new work changes its facts", async () => {
    const created = await registerProject(1);
    const firstExecution = created.project.currentExecution!;

    const updated = await workflow.addProjectWork(created.project.id, [
      { title: "Audio", description: "Add audio", acceptanceCriteria: [] },
    ]);

    expect(projectExecutor.interrupted).toHaveLength(1);
    expect(projectExecutor.started).toHaveLength(2);
    expect(updated.tasks).toHaveLength(2);
    expect(updated.project.currentExecution).toMatchObject({
      action: "select_tasks",
      status: "running",
    });
    expect(updated.project.currentExecution?.attemptId).not.toBe(
      firstExecution.attemptId,
    );
  });

  it("reactivates a completed project when new work is added and rejects cancelled projects", async () => {
    const created = await store.createProject({
      name: "Tiny Game",
      repositoryPath: "/workspace/game",
      defaultBranch: "main",
      productDocument: "# Tiny Game\n",
      tasks: [{ title: "Task", description: "Build", acceptanceCriteria: [] }],
    });
    await store.saveProject({ ...created.project, status: "completed" });

    const active = await workflow.addProjectWork(created.project.id, [
      { title: "Expansion", description: "Build more", acceptanceCriteria: [] },
    ]);
    expect(active.project.status).not.toBe("completed");

    await workflow.controlProject(created.project.id, "cancel");
    await expect(
      workflow.addProjectWork(created.project.id, [
        { title: "Too late", description: "No", acceptanceCriteria: [] },
      ]),
    ).rejects.toThrow(/cancelled/i);
  });

  it("accepts a final report on the same attempt after input arrives in Codex App", async () => {
    const created = await registerProject(1);
    await finishProjectExecution({
      projectId: created.project.id,
      outcome: "selected",
      summary: "Start",
      taskIds: [created.tasks[0]!.id],
    });
    const developing = (await store.findTask(created.tasks[0]!.id))!.task;
    const execution = developing.currentExecution!;

    await workflow.submitReport({
      taskId: developing.id,
      attemptId: execution.attemptId,
      outcome: "needs_input",
      summary: "Need a product decision",
      question: "Should it be turn based?",
    });
    const waiting = await workflow.completeTurn(
      developing.id,
      execution.attemptId,
      execution.turnId!,
    );
    expect(waiting.currentExecution).toMatchObject({
      attemptId: execution.attemptId,
      status: "waiting_for_input",
    });

    await workflow.submitReport({
      taskId: developing.id,
      attemptId: execution.attemptId,
      outcome: "completed",
      summary: "Implemented after the answer",
      workspacePath: "/workspace/game/.worktrees/task_1",
      candidateCommit: "candidate_1",
    });

    const reviewing = (await store.findTask(developing.id))!.task;
    expect(reviewing).toMatchObject({
      status: "reviewing",
      requestedAction: "review",
      developmentThreadId: execution.threadId,
    });
    expect(reviewing.currentExecution?.action).toBe("review");
    expect(reviewing.reviewAttempts).toHaveLength(1);
  });

  it("invalidates a waiting task-selection result when task facts change", async () => {
    const created = await registerProject(2);
    const taskId = created.tasks[0]!.id;
    await finishProjectExecution({
      projectId: created.project.id,
      outcome: "selected",
      summary: "Start the first task",
      taskIds: [taskId],
    });
    const developing = (await store.findTask(taskId))!.task;
    const execution = developing.currentExecution!;

    await workflow.submitReport({
      taskId,
      attemptId: execution.attemptId,
      outcome: "needs_input",
      summary: "Need a decision",
      question: "Keep the existing files?",
    });
    await workflow.completeTurn(taskId, execution.attemptId, execution.turnId!);
    await finishProjectExecution({
      projectId: created.project.id,
      outcome: "needs_input",
      summary: "No other task should start yet",
      question: "Wait for the first task?",
    });

    expect((await store.getProject(created.project.id))!.project.status).toBe(
      "waiting_for_input",
    );

    await workflow.submitReport({
      taskId,
      attemptId: execution.attemptId,
      outcome: "completed",
      summary: "Implemented after resolving the question",
      workspacePath: "/workspace/game/.worktrees/task_1",
      candidateCommit: "candidate_1",
    });

    const snapshot = (await store.getProject(created.project.id))!;
    expect(snapshot.project.status).not.toBe("waiting_for_input");
    expect(snapshot.project.latestReport?.question).not.toBe(
      "Wait for the first task?",
    );
    expect(snapshot.tasks.find(({ id }) => id === taskId)).toMatchObject({
      status: "reviewing",
      requestedAction: "review",
      currentExecution: { action: "review", status: "running" },
    });
  });

  it("lets task selection wait for a task whose Codex conversation needs input", async () => {
    const created = await store.createProject({
      name: "Tiny Game",
      repositoryPath: "/workspace/game",
      defaultBranch: "main",
      productDocument: "# Tiny Game\n",
      tasks: [
        { title: "Foundation", description: "Build it", acceptanceCriteria: [] },
        { title: "Gameplay", description: "Build it next", acceptanceCriteria: [] },
      ],
    });
    await store.saveTask(created.project.id, {
      ...created.tasks[0]!,
      status: "waiting_for_input",
      requestedAction: "develop",
      currentExecution: {
        attemptId: "attempt_1",
        action: "develop",
        status: "waiting_for_input",
        startedAt: "2026-08-03T00:00:00.000Z",
      },
    });

    await workflow.reconcile();
    await finishProjectExecution({
      projectId: created.project.id,
      outcome: "wait_for_active_tasks",
      summary: "The next task should wait for the foundation",
    });

    expect((await store.getProject(created.project.id))!.project).toMatchObject({
      status: "active",
      requestedAction: null,
      latestReport: { outcome: "wait_for_active_tasks" },
    });
  });

  it("keeps a reported blocker visible until an explicit retry", async () => {
    const created = await registerProject(1);
    await finishProjectExecution({
      projectId: created.project.id,
      outcome: "selected",
      summary: "Start",
      taskIds: [created.tasks[0]!.id],
    });
    const developing = (await store.findTask(created.tasks[0]!.id))!.task;
    const execution = developing.currentExecution!;

    await workflow.submitReport({
      taskId: developing.id,
      attemptId: execution.attemptId,
      outcome: "blocked",
      summary: "The required tool is unavailable",
    });
    await workflow.completeTurn(
      developing.id,
      execution.attemptId,
      execution.turnId!,
    );

    const blocked = (await store.findTask(developing.id))!.task;
    expect(blocked).toMatchObject({
      status: "blocked",
      requestedAction: "develop",
      currentExecution: { status: "completed" },
    });
    expect(taskDispatcher.started).toHaveLength(1);

    await workflow.retryTask(developing.id);
    expect((await store.findTask(developing.id))!.task).toMatchObject({
      status: "developing",
      currentExecution: { status: "running" },
    });
    expect(taskDispatcher.started).toHaveLength(2);
  });

  it("uses one integration lease per repository", async () => {
    const created = await store.createProject({
      name: "Tiny Game",
      repositoryPath: "/workspace/game",
      defaultBranch: "main",
      productDocument: "# Tiny Game\n",
      tasks: [
        { title: "One", description: "One", acceptanceCriteria: [] },
        { title: "Two", description: "Two", acceptanceCriteria: [] },
      ],
    });
    for (const current of created.tasks) {
      const integrating: Task = {
        ...current,
        status: "integrating",
        requestedAction: "integrate",
      };
      await store.saveTask(created.project.id, integrating);
    }

    await workflow.reconcile();

    expect(taskDispatcher.started).toHaveLength(1);
    expect(taskDispatcher.started[0]?.task.currentExecution?.action).toBe("integrate");
  });

  it("keeps the integration lease while the integrating task waits for input", async () => {
    const created = await store.createProject({
      name: "Tiny Game",
      repositoryPath: "/workspace/game",
      defaultBranch: "main",
      productDocument: "# Tiny Game\n",
      tasks: [
        { title: "One", description: "One", acceptanceCriteria: [] },
        { title: "Two", description: "Two", acceptanceCriteria: [] },
      ],
    });
    await store.saveTask(created.project.id, {
      ...created.tasks[0]!,
      status: "waiting_for_input",
      requestedAction: "integrate",
      currentExecution: {
        attemptId: "integrate_1",
        action: "integrate",
        status: "waiting_for_input",
        startedAt: "2026-08-03T00:00:00.000Z",
      },
    });
    await store.saveTask(created.project.id, {
      ...created.tasks[1]!,
      status: "integrating",
      requestedAction: "integrate",
    });

    await workflow.reconcile();

    expect(taskDispatcher.started).toHaveLength(0);
  });

  it("starts product evaluation after all known tasks are complete", async () => {
    const created = await store.createProject({
      name: "Tiny Game",
      repositoryPath: "/workspace/game",
      defaultBranch: "main",
      productDocument: "# Tiny Game\n",
      tasks: [{ title: "Task", description: "Build", acceptanceCriteria: [] }],
    });
    await store.saveTask(created.project.id, {
      ...created.tasks[0]!,
      status: "done",
      mergedCommit: "main_1",
    });

    await workflow.reconcile();

    expect(projectExecutor.started[0]?.project).toMatchObject({
      status: "evaluating",
      requestedAction: "evaluate_product",
    });
  });
});
