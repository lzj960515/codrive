import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { WorkflowEngine } from "../../src/application/workflow-engine.js";
import type {
  ProjectReport,
  Task,
  TaskReport,
} from "../../src/domain/types.js";
import { ProjectStore } from "../../src/infrastructure/project-store.js";
import {
  RecordingProjectExecutor,
  RecordingTaskDispatcher,
  testModelRouting,
} from "../support/recording-executors.js";

let store: ProjectStore;
let taskDispatcher: RecordingTaskDispatcher;
let projectExecutor: RecordingProjectExecutor;
let workflow: WorkflowEngine;
let id = 0;
let now: Date;

const models = {
  primary: "gpt-5.6-sol",
  fallback: "gpt-5.6-terra",
};

beforeEach(async () => {
  store = new ProjectStore(await mkdtemp(join(tmpdir(), "codrive-workflow-")));
  taskDispatcher = new RecordingTaskDispatcher();
  projectExecutor = new RecordingProjectExecutor();
  now = new Date("2026-08-03T00:00:00.000Z");
  workflow = new WorkflowEngine(
    store,
    taskDispatcher,
    {
      maxConcurrentTasks: 2,
      models,
      now: () => now.toISOString(),
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

async function finishTaskExecution(
  taskId: string,
  report: Omit<TaskReport, "taskId" | "attemptId">,
) {
  const task = (await store.findTask(taskId))!.task;
  const execution = task.currentExecution!;
  await workflow.submitReport({
    ...report,
    taskId,
    attemptId: execution.attemptId,
  });
  return workflow.completeTurn(taskId, execution.attemptId, execution.turnId!);
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

  it("dispatches four tasks selected in one planning attempt", async () => {
    workflow = new WorkflowEngine(
      store,
      taskDispatcher,
      {
        maxConcurrentTasks: 4,
        models,
        now: () => "2026-08-03T00:00:00.000Z",
        createId: (prefix) => `${prefix}_${++id}`,
      },
      projectExecutor,
    );
    const created = await registerProject(4);

    await finishProjectExecution({
      projectId: created.project.id,
      outcome: "selected",
      summary: "All four tasks can start independently",
      taskIds: created.tasks.map(({ id: taskId }) => taskId),
    });

    expect(taskDispatcher.started.map(({ task }) => task.id)).toEqual(
      created.tasks.map(({ id: taskId }) => taskId),
    );
    expect(projectExecutor.started).toHaveLength(1);
  });

  it("treats a partial multi-slot selection as complete for the current planning facts", async () => {
    workflow = new WorkflowEngine(
      store,
      taskDispatcher,
      {
        maxConcurrentTasks: 4,
        models,
        now: () => "2026-08-03T00:00:00.000Z",
        createId: (prefix) => `${prefix}_${++id}`,
      },
      projectExecutor,
    );
    const created = await registerProject(4);

    await finishProjectExecution({
      projectId: created.project.id,
      outcome: "selected",
      summary: "Only two tasks can start independently",
      taskIds: created.tasks.slice(0, 2).map(({ id: taskId }) => taskId),
    });

    expect(taskDispatcher.started.map(({ task }) => task.id)).toEqual(
      created.tasks.slice(0, 2).map(({ id: taskId }) => taskId),
    );
    expect(projectExecutor.started).toHaveLength(1);
  });

  it("continues a task pipeline while backlog planning waits for a project decision", async () => {
    const created = await registerProject(1);
    await finishProjectExecution({
      projectId: created.project.id,
      outcome: "selected",
      summary: "Start the foundation",
      taskIds: [created.tasks[0]!.id],
    });
    const developing = (await store.findTask(created.tasks[0]!.id))!.task;

    await workflow.addProjectWork(created.project.id, [
      {
        title: "Follow-up",
        description: "Needs a product decision",
        acceptanceCriteria: [],
      },
    ]);
    await finishProjectExecution({
      projectId: created.project.id,
      outcome: "needs_input",
      summary: "The follow-up needs a product decision",
      question: "Which product rule should the follow-up use?",
    });

    await workflow.submitReport({
      taskId: developing.id,
      attemptId: developing.currentExecution!.attemptId,
      outcome: "completed",
      summary: "Foundation implemented",
      workspacePath: "/workspace/game/.worktrees/foundation",
      candidateCommit: "candidate_1",
    });
    await workflow.completeTurn(
      developing.id,
      developing.currentExecution!.attemptId,
      developing.currentExecution!.turnId!,
    );

    const snapshot = (await store.getProject(created.project.id))!;
    expect(snapshot.project.status).toBe("active");
    expect(snapshot.tasks.find(({ id }) => id === developing.id)).toMatchObject({
      status: "reviewing",
      requestedAction: "review",
      currentExecution: { action: "review", status: "running" },
    });
  });

  it.each(["running", "needs_input", "failed"] as const)(
    "starts review while task selection is %s",
    async (selectionState) => {
      const created = await registerProject(2);
      const taskId = created.tasks[0]!.id;
      await finishProjectExecution({
        projectId: created.project.id,
        outcome: "selected",
        summary: "Start the foundation",
        taskIds: [taskId],
      });
      const replanned = await workflow.controlProject(created.project.id, "replan");

      if (selectionState === "needs_input") {
        await finishProjectExecution({
          projectId: created.project.id,
          outcome: "needs_input",
          summary: "A product decision is required",
          question: "Which direction should the backlog use?",
        });
      } else if (selectionState === "failed") {
        await workflow.failProjectTurn(
          created.project.id,
          replanned.currentExecution!.attemptId,
          {
            turnId: replanned.currentExecution!.turnId!,
            message: "The planning model failed",
          },
        );
      }

      await finishTaskExecution(taskId, {
        outcome: "completed",
        summary: "Implemented",
        workspacePath: "/workspace/game/.worktrees/foundation",
        candidateCommit: "candidate_1",
      });

      expect((await store.findTask(taskId))!.task).toMatchObject({
        status: "reviewing",
        requestedAction: "review",
        currentExecution: { action: "review", status: "running" },
      });
      expect((await store.getProject(created.project.id))!.project.status).toBe(
        "active",
      );
    },
  );

  it("advances planning only after a task completes its full pipeline", async () => {
    const created = await registerProject(2);
    const taskId = created.tasks[0]!.id;
    await finishProjectExecution({
      projectId: created.project.id,
      outcome: "selected",
      summary: "Start the foundation",
      taskIds: [taskId],
    });

    await finishTaskExecution(taskId, {
      outcome: "completed",
      summary: "Implemented",
      workspacePath: "/workspace/game/.worktrees/foundation",
      candidateCommit: "candidate_1",
    });
    expect((await store.getProject(created.project.id))!.project.planning.revision).toBe(1);

    await finishTaskExecution(taskId, {
      outcome: "approved",
      summary: "Approved",
      reviewedMainCommit: "main_1",
    });
    expect((await store.getProject(created.project.id))!.project.planning.revision).toBe(1);

    await finishTaskExecution(taskId, {
      outcome: "completed",
      summary: "Integrated",
      mergedCommit: "main_2",
    });

    const snapshot = (await store.getProject(created.project.id))!;
    expect(snapshot.tasks.find(({ id }) => id === taskId)?.status).toBe("done");
    expect(snapshot.project.planning).toMatchObject({
      revision: 2,
      changeReason: "task_completed",
    });
    expect(projectExecutor.started).toHaveLength(2);
    expect(projectExecutor.started[1]?.project.currentExecution).toMatchObject({
      action: "select_tasks",
      planningRevision: 2,
    });
  });

  it("supersedes a running selection when integration completes a task", async () => {
    const created = await registerProject(2);
    const taskId = created.tasks[0]!.id;
    await finishProjectExecution({
      projectId: created.project.id,
      outcome: "selected",
      summary: "Start the foundation",
      taskIds: [taskId],
    });
    await finishTaskExecution(taskId, {
      outcome: "completed",
      summary: "Implemented",
      workspacePath: "/workspace/game/.worktrees/foundation",
      candidateCommit: "candidate_1",
    });
    await finishTaskExecution(taskId, {
      outcome: "approved",
      summary: "Approved",
      reviewedMainCommit: "main_1",
    });
    const replanned = await workflow.controlProject(created.project.id, "replan");
    const supersededSelection = replanned.currentExecution!;

    await finishTaskExecution(taskId, {
      outcome: "completed",
      summary: "Integrated",
      mergedCommit: "main_2",
    });

    const snapshot = (await store.getProject(created.project.id))!;
    expect(snapshot.project.planning).toMatchObject({
      revision: 3,
      changeReason: "task_completed",
    });
    expect(snapshot.project.currentExecution).toMatchObject({
      action: "select_tasks",
      planningRevision: 3,
    });
    expect(projectExecutor.interrupted).toHaveLength(1);
    await expect(
      workflow.submitProjectReport({
        projectId: created.project.id,
        attemptId: supersededSelection.attemptId,
        outcome: "selected",
        summary: "This result belongs to revision 2",
        taskIds: [created.tasks[1]!.id],
      }),
    ).rejects.toThrow(/does not match the current project execution/i);
    expect((await store.findTask(created.tasks[1]!.id))!.task.requestedAction).toBe(
      null,
    );
  });

  it("waits for a blocked selected task until cancellation changes planning facts", async () => {
    const created = await registerProject(2);
    const taskId = created.tasks[0]!.id;
    await finishProjectExecution({
      projectId: created.project.id,
      outcome: "selected",
      summary: "Start the foundation",
      taskIds: [taskId],
    });

    await finishTaskExecution(taskId, {
      outcome: "blocked",
      summary: "The required tool is unavailable",
    });
    await workflow.recoverProjectsWithoutActiveWork();
    await workflow.recoverProjectsWithoutActiveWork();

    let snapshot = (await store.getProject(created.project.id))!;
    expect(snapshot.project.planning.revision).toBe(1);
    expect(projectExecutor.started).toHaveLength(1);

    await workflow.cancelTask(taskId, {
      cancelledBy: "codex",
      decisionBasis: "agent_decision",
      reason: "The blocked task is no longer required",
    });
    snapshot = (await store.getProject(created.project.id))!;
    expect(snapshot.project.planning).toMatchObject({
      revision: 2,
      changeReason: "task_cancelled",
    });
    expect(projectExecutor.started).toHaveLength(2);
  });

  it.each([
    {
      decisionBasis: "user_confirmed" as const,
      reason: "The user confirmed that D1 must be reviewed before replacing D2",
    },
    {
      decisionBasis: "agent_decision" as const,
      reason: "The duplicate task is fully covered by the accepted replacement",
    },
  ])(
    "persists a $decisionBasis Codex cancellation with its reason",
    async ({ decisionBasis, reason }) => {
      const created = await registerProject(1);
      const taskId = created.tasks[0]!.id;

      const cancelled = (await workflow.execute(
        {
          type: "task.control",
          payload: { taskId, action: "cancel", decisionBasis, reason },
        },
        "skill",
      )) as Task;

      expect(cancelled).toMatchObject({
        status: "cancelled",
        requestedAction: null,
        cancellation: {
          cancelledBy: "codex",
          decisionBasis,
          reason,
          cancelledAt: "2026-08-03T00:00:00.000Z",
        },
      });
    },
  );

  it("propagates a reasoned Codex project cancellation to unfinished tasks", async () => {
    const created = await registerProject(1);

    const cancelled = await workflow.execute(
      {
        type: "project.control",
        payload: {
          projectId: created.project.id,
          action: "cancel",
          decisionBasis: "agent_decision",
          reason: "The registered project duplicates an active canonical project",
        },
      },
      "skill",
    );

    expect(cancelled).toMatchObject({
      status: "cancelled",
      scheduling: "paused",
      cancellation: {
        cancelledBy: "codex",
        decisionBasis: "agent_decision",
        reason: "The registered project duplicates an active canonical project",
      },
    });
    expect((await store.findTask(created.tasks[0]!.id))!.task).toMatchObject({
      status: "cancelled",
      cancellation: {
        cancelledBy: "codex",
        decisionBasis: "agent_decision",
        reason: "The registered project duplicates an active canonical project",
      },
    });
  });

  it("starts one independent task selection per project", async () => {
    const first = await registerProject(1);
    const second = await registerProject(1);

    expect(projectExecutor.started).toHaveLength(2);
    expect(projectExecutor.started[0]?.project.id).toBe(first.project.id);
    expect(projectExecutor.started[1]?.project.id).toBe(second.project.id);
    expect(
      projectExecutor.started.map(
        ({ project }) => project.currentExecution?.selectionCapacity,
      ),
    ).toEqual([2, 2]);
  });

  it("dispatches each project's tasks against its own concurrency limit", async () => {
    const first = await store.createProject({
      name: "First",
      repositoryPath: "/workspace/first",
      defaultBranch: "main",
      productDocument: "# First\n",
      tasks: [{ title: "First task", description: "Build", acceptanceCriteria: [] }],
    });
    const second = await store.createProject({
      name: "Second",
      repositoryPath: "/workspace/second",
      defaultBranch: "main",
      productDocument: "# Second\n",
      tasks: [{ title: "Second task", description: "Build", acceptanceCriteria: [] }],
    });
    await store.saveTask(first.project.id, {
      ...first.tasks[0]!,
      requestedAction: "develop",
    });
    await store.saveTask(second.project.id, {
      ...second.tasks[0]!,
      requestedAction: "develop",
    });
    const perProjectDispatcher = new RecordingTaskDispatcher();
    const perProjectWorkflow = new WorkflowEngine(
      store,
      perProjectDispatcher,
      { maxConcurrentTasks: 1, models },
      new RecordingProjectExecutor(),
    );

    await perProjectWorkflow.reconcile();

    expect(perProjectDispatcher.started.map(({ task }) => task.projectId).sort()).toEqual(
      [first.project.id, second.project.id].sort(),
    );
  });

  it("does not let one project's selection failure block another project", async () => {
    const first = await store.createProject({
      name: "First",
      repositoryPath: "/workspace/first",
      defaultBranch: "main",
      productDocument: "# First\n",
      tasks: [{ title: "First task", description: "Build", acceptanceCriteria: [] }],
    });
    const second = await store.createProject({
      name: "Second",
      repositoryPath: "/workspace/second",
      defaultBranch: "main",
      productDocument: "# Second\n",
      tasks: [{ title: "Second task", description: "Build", acceptanceCriteria: [] }],
    });
    let startCount = 0;
    projectExecutor.beforeStartTurn = async () => {
      startCount += 1;
      if (startCount === 1) throw new Error("Planner failed to start");
    };

    await workflow.reconcile();

    expect((await store.getProject(first.project.id))!.project).toMatchObject({
      status: "active",
      planning: { lastDecision: { outcome: "blocked" } },
      currentExecution: { action: "select_tasks", status: "failed" },
    });
    expect((await store.getProject(second.project.id))!.project.currentExecution).toMatchObject({
      action: "select_tasks",
      status: "running",
    });
    expect(projectExecutor.started).toHaveLength(1);
    expect(projectExecutor.started[0]?.project.id).toBe(second.project.id);
  });

  it("keeps captured capacity when same-project work claims live slots", async () => {
    const capacityStore = new ProjectStore(
      await mkdtemp(join(tmpdir(), "codrive-selection-capacity-")),
    );
    const capacityDispatcher = new RecordingTaskDispatcher();
    const capacityExecutor = new RecordingProjectExecutor();
    const capacityWorkflow = new WorkflowEngine(
      capacityStore,
      capacityDispatcher,
      { maxConcurrentTasks: 2, models },
      capacityExecutor,
    );
    const planned = await capacityStore.createProject({
      name: "Planned",
      repositoryPath: "/workspace/planned",
      defaultBranch: "main",
      productDocument: "# Planned\n",
      tasks: [
        { title: "Busy one", description: "Build", acceptanceCriteria: [] },
        { title: "Busy two", description: "Build", acceptanceCriteria: [] },
        { title: "Selected one", description: "Build", acceptanceCriteria: [] },
        { title: "Selected two", description: "Build", acceptanceCriteria: [] },
      ],
    });
    await capacityWorkflow.reconcile();
    const selection = (await capacityStore.getProject(planned.project.id))!.project
      .currentExecution!;
    expect(selection.selectionCapacity).toBe(2);

    for (const [index, task] of planned.tasks.slice(0, 2).entries()) {
      await capacityStore.saveTask(planned.project.id, {
        ...task,
        status: "developing",
        requestedAction: "develop",
        currentExecution: {
          attemptId: `busy_${index}`,
          action: "develop",
          status: "running",
          startedAt: "2026-08-03T00:00:00.000Z",
          modelRouting: testModelRouting(),
        },
      });
    }
    await capacityWorkflow.submitProjectReport({
      projectId: planned.project.id,
      attemptId: selection.attemptId,
      outcome: "selected",
      summary: "Both planned tasks are independent",
      taskIds: planned.tasks.slice(2).map(({ id }) => id),
    });
    await capacityWorkflow.completeProjectTurn(
      planned.project.id,
      selection.attemptId,
      selection.turnId!,
    );

    let plannedSnapshot = (await capacityStore.getProject(planned.project.id))!;
    expect(plannedSnapshot.tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "backlog", requestedAction: "develop" }),
        expect.objectContaining({ status: "backlog", requestedAction: "develop" }),
      ]),
    );
    expect(capacityDispatcher.started).toHaveLength(0);

    for (const task of planned.tasks.slice(0, 2)) {
      const current = (await capacityStore.findTask(task.id))!.task;
      await capacityStore.saveTask(planned.project.id, {
        ...current,
        status: "done",
        requestedAction: null,
        currentExecution: {
          ...current.currentExecution!,
          status: "completed",
          finishedAt: "2026-08-03T01:00:00.000Z",
        },
      });
    }
    await capacityWorkflow.reconcile();

    plannedSnapshot = (await capacityStore.getProject(planned.project.id))!;
    expect(plannedSnapshot.tasks.slice(0, 2).every(({ status }) => status === "done"))
      .toBe(true);
    expect(
      plannedSnapshot.tasks.slice(2).every(({ status }) => status === "developing"),
    ).toBe(true);
    expect(capacityDispatcher.started).toHaveLength(2);
  });

  it("dispatches an existing task continuation before reserved development", async () => {
    const priorityStore = new ProjectStore(
      await mkdtemp(join(tmpdir(), "codrive-continuation-priority-")),
    );
    const priorityDispatcher = new RecordingTaskDispatcher();
    const priorityWorkflow = new WorkflowEngine(
      priorityStore,
      priorityDispatcher,
      { maxConcurrentTasks: 1, models },
      new RecordingProjectExecutor(),
    );
    const project = await priorityStore.createProject({
      name: "Prioritized",
      repositoryPath: "/workspace/prioritized",
      defaultBranch: "main",
      productDocument: "# Prioritized\n",
      tasks: [
        { title: "Review me", description: "Review", acceptanceCriteria: [] },
        { title: "Develop me", description: "Develop", acceptanceCriteria: [] },
      ],
    });
    await priorityStore.saveTask(project.project.id, {
      ...project.tasks[0]!,
      status: "reviewing",
      requestedAction: "review",
      currentExecution: {
        attemptId: "developed",
        action: "develop",
        status: "completed",
        startedAt: "2026-08-03T00:00:00.000Z",
        modelRouting: testModelRouting(),
        finishedAt: "2026-08-03T00:30:00.000Z",
      },
    });
    await priorityStore.saveTask(project.project.id, {
      ...project.tasks[1]!,
      requestedAction: "develop",
    });

    await priorityWorkflow.reconcile();

    expect(priorityDispatcher.started).toHaveLength(1);
    expect(priorityDispatcher.started[0]?.task.id).toBe(project.tasks[0]!.id);
    expect((await priorityStore.findTask(project.tasks[1]!.id))!.task.status).toBe(
      "backlog",
    );
  });

  it("manually replans the same project with a new revision", async () => {
    const created = await registerProject(2);
    await finishProjectExecution({
      projectId: created.project.id,
      outcome: "selected",
      summary: "Start one task",
      taskIds: [created.tasks[0]!.id],
    });

    const replanned = await workflow.controlProject(created.project.id, "replan");

    expect(replanned.planning).toMatchObject({
      revision: 2,
      changeReason: "manual_replan",
    });
    expect(replanned.currentExecution).toMatchObject({
      action: "select_tasks",
      planningRevision: 2,
      selectionCapacity: 1,
    });
    expect(projectExecutor.started).toHaveLength(2);
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
        modelRouting: testModelRouting(),
      },
    });

    const singleTaskWorkflow = new WorkflowEngine(
      store,
      new RecordingTaskDispatcher(),
      { maxConcurrentTasks: 1, models },
      new RecordingProjectExecutor(),
    );
    await singleTaskWorkflow.reconcile();

    const expandedExecutor = new RecordingProjectExecutor();
    const expandedWorkflow = new WorkflowEngine(
      store,
      new RecordingTaskDispatcher(),
      { maxConcurrentTasks: 4, models },
      expandedExecutor,
    );
    await expandedWorkflow.reconcile();
    await expandedWorkflow.reconcile();

    expect(expandedExecutor.started).toHaveLength(1);
    expect(expandedExecutor.started[0]?.project.requestedAction).toBe(
      "select_tasks",
    );
    expect((await store.getProject(created.project.id))!.project.planning).toMatchObject({
      revision: 2,
      changeReason: "concurrency_changed",
      concurrencyLimit: 4,
    });
  });

  it("does not let another project's active work consume selection capacity", async () => {
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
        modelRouting: testModelRouting(),
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
      { maxConcurrentTasks: 1, models },
      singleSlotExecutor,
    );

    await singleSlotWorkflow.reconcile();

    const selections = singleSlotExecutor.started.filter(
      ({ project }) => project.requestedAction === "select_tasks",
    );
    expect(selections).toHaveLength(1);
    expect(selections[0]?.project.id).toBe(waitingProject.project.id);
    expect(selections[0]?.project.currentExecution?.selectionCapacity).toBe(1);
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
        modelRouting: testModelRouting(),
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
    await expect(
      workflow.submitProjectReport({
        projectId: created.project.id,
        attemptId: firstExecution.attemptId,
        outcome: "selected",
        summary: "This report arrived after its planning facts changed",
        taskIds: [created.tasks[0]!.id],
      }),
    ).rejects.toThrow(/does not match the current project execution/i);
    expect((await store.findTask(created.tasks[0]!.id))!.task.requestedAction).toBe(
      null,
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

    await workflow.cancelProject(created.project.id, {
      cancelledBy: "codex",
      decisionBasis: "agent_decision",
      reason: "The completed project is being retired",
    });
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
    await expect(workflow.retryTask(developing.id)).rejects.toThrow(
      /still active and cannot be retried/,
    );

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

  it("keeps a selection decision non-blocking while a waiting task continues", async () => {
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
    await workflow.addProjectWork(created.project.id, [
      {
        title: "Later task",
        description: "Added after the first selection",
        acceptanceCriteria: [],
      },
    ]);
    await finishProjectExecution({
      projectId: created.project.id,
      outcome: "needs_input",
      summary: "No other task should start yet",
      question: "Wait for the first task?",
    });

    expect((await store.getProject(created.project.id))!.project.status).toBe("active");

    await workflow.submitReport({
      taskId,
      attemptId: execution.attemptId,
      outcome: "completed",
      summary: "Implemented after resolving the question",
      workspacePath: "/workspace/game/.worktrees/task_1",
      candidateCommit: "candidate_1",
    });

    const snapshot = (await store.getProject(created.project.id))!;
    expect(snapshot.project.status).toBe("active");
    expect(snapshot.project.planning.lastDecision?.question).toBe(
      "Wait for the first task?",
    );
    expect(projectExecutor.started).toHaveLength(2);
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
        modelRouting: testModelRouting(),
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
    const created = await registerProject(2);
    await finishProjectExecution({
      projectId: created.project.id,
      outcome: "selected",
      summary: "Start both tasks",
      taskIds: created.tasks.map(({ id: selectedTaskId }) => selectedTaskId),
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
    expect(taskDispatcher.started).toHaveLength(2);
    expect((await store.findTask(created.tasks[1]!.id))!.task).toMatchObject({
      status: "developing",
      currentExecution: { status: "running" },
    });

    await workflow.retryTask(developing.id);
    expect((await store.findTask(developing.id))!.task).toMatchObject({
      status: "developing",
      currentExecution: { status: "running" },
    });
    expect(taskDispatcher.started).toHaveLength(3);
  });

  it("retries failed project execution independently from scheduling resume", async () => {
    const created = await registerProject(1);
    const firstExecution = created.project.currentExecution!;

    await workflow.failProjectTurn(
      created.project.id,
      firstExecution.attemptId,
      {
        turnId: firstExecution.turnId!,
        message: "Planner process failed",
      },
    );
    const resumed = await workflow.controlProject(created.project.id, "resume");

    expect(resumed).toMatchObject({
      status: "active",
      scheduling: "running",
      requestedAction: "select_tasks",
      currentExecution: { status: "failed" },
      planning: { lastDecision: { outcome: "blocked" } },
    });
    expect(projectExecutor.started).toHaveLength(1);

    const retried = await workflow.retryProject(created.project.id);
    expect(retried).toMatchObject({
      status: "active",
      requestedAction: "select_tasks",
      currentExecution: { status: "running" },
    });
    expect(retried.currentExecution?.attemptId).not.toBe(firstExecution.attemptId);
    expect(projectExecutor.started).toHaveLength(2);
  });

  it("keeps project planning active while a capacity failure waits to retry", async () => {
    const created = await registerProject(1);
    const execution = created.project.currentExecution!;

    await workflow.failProjectTurn(created.project.id, execution.attemptId, {
      turnId: execution.turnId!,
      message: "Selected model is at capacity. Please try a different model.",
      codexErrorInfo: "serverOverloaded",
    });

    const scheduled = (await store.getProject(created.project.id))!.project;
    expect(scheduled).toMatchObject({
      status: "active",
      requestedAction: "select_tasks",
      planning: { revision: 1 },
      currentExecution: {
        attemptId: execution.attemptId,
        status: "retry_scheduled",
        modelRouting: {
          model: models.primary,
          route: "primary",
          retryCount: 1,
        },
      },
    });
    expect(scheduled.planning.lastDecision).toBeUndefined();

    now = new Date(now.getTime() + 5_000);
    await workflow.retryScheduledExecutions(now);
    expect((await store.getProject(created.project.id))!.project).toMatchObject({
      status: "active",
      currentExecution: {
        attemptId: execution.attemptId,
        status: "running",
        modelRouting: { model: models.primary, retryCount: 1 },
      },
    });
    expect(projectExecutor.started).toHaveLength(2);
  });

  it("retries model capacity failures three times before routing the same task attempt to the fallback model", async () => {
    const created = await registerProject(1);
    await finishProjectExecution({
      projectId: created.project.id,
      outcome: "selected",
      summary: "Start the task",
      taskIds: [created.tasks[0]!.id],
    });
    const taskId = created.tasks[0]!.id;
    const first = (await store.findTask(taskId))!.task.currentExecution!;

    expect(first).toMatchObject({
      modelRouting: {
        model: models.primary,
        route: "primary",
        retryCount: 0,
      },
    });

    for (const [index, delay] of [5_000, 10_000, 20_000].entries()) {
      const running = (await store.findTask(taskId))!.task.currentExecution!;
      await workflow.failTurn(taskId, running.attemptId, {
        turnId: running.turnId!,
        message: "Selected model is at capacity. Please try a different model.",
        codexErrorInfo: "serverOverloaded",
      });

      const scheduled = (await store.findTask(taskId))!.task;
      expect(scheduled).toMatchObject({
        status: "developing",
        currentExecution: {
          attemptId: first.attemptId,
          threadId: first.threadId,
          status: "retry_scheduled",
          modelRouting: {
            model: models.primary,
            route: "primary",
            retryCount: index + 1,
            lastError: {
              kind: "model_capacity",
              message: "Selected model is at capacity. Please try a different model.",
            },
          },
        },
      });
      expect(Date.parse(scheduled.currentExecution!.modelRouting.nextRetryAt!)).toBe(
        now.getTime() + delay,
      );

      now = new Date(now.getTime() + delay);
      await workflow.retryScheduledExecutions(now);
      expect((await store.findTask(taskId))!.task.currentExecution).toMatchObject({
        attemptId: first.attemptId,
        status: "running",
        modelRouting: {
          model: models.primary,
          route: "primary",
          retryCount: index + 1,
        },
      });
    }

    const finalPrimary = (await store.findTask(taskId))!.task.currentExecution!;
    await workflow.failTurn(taskId, finalPrimary.attemptId, {
      turnId: finalPrimary.turnId!,
      message: "Selected model is at capacity. Please try a different model.",
      codexErrorInfo: "serverOverloaded",
    });

    expect((await store.findTask(taskId))!.task).toMatchObject({
      status: "developing",
      currentExecution: {
        attemptId: first.attemptId,
        threadId: first.threadId,
        status: "running",
        modelRouting: {
          model: models.fallback,
          route: "fallback",
          retryCount: 0,
        },
      },
    });
    expect(taskDispatcher.started).toHaveLength(5);
    expect(taskDispatcher.started.at(-1)?.model).toBe(models.fallback);
  });

  it("blocks only after fallback capacity retries are exhausted", async () => {
    const created = await registerProject(1);
    await finishProjectExecution({
      projectId: created.project.id,
      outcome: "selected",
      summary: "Start the task",
      taskIds: [created.tasks[0]!.id],
    });
    const taskId = created.tasks[0]!.id;

    for (const route of ["primary", "fallback"] as const) {
      for (const delay of [5_000, 10_000, 20_000]) {
        const running = (await store.findTask(taskId))!.task.currentExecution!;
        expect(running.modelRouting.route).toBe(route);
        await workflow.failTurn(taskId, running.attemptId, {
          turnId: running.turnId!,
          message: "Selected model is at capacity. Please try a different model.",
          codexErrorInfo: "serverOverloaded",
        });
        now = new Date(now.getTime() + delay);
        await workflow.retryScheduledExecutions(now);
      }
      const running = (await store.findTask(taskId))!.task.currentExecution!;
      await workflow.failTurn(taskId, running.attemptId, {
        turnId: running.turnId!,
        message: "Selected model is at capacity. Please try a different model.",
        codexErrorInfo: "serverOverloaded",
      });
    }

    expect((await store.findTask(taskId))!.task).toMatchObject({
      status: "blocked",
      currentExecution: {
        status: "failed",
        modelRouting: {
          model: models.fallback,
          route: "fallback",
          retryCount: 3,
        },
      },
    });
  });

  it("does not retry a non-capacity model failure", async () => {
    const created = await registerProject(1);
    await finishProjectExecution({
      projectId: created.project.id,
      outcome: "selected",
      summary: "Start the task",
      taskIds: [created.tasks[0]!.id],
    });
    const running = (await store.findTask(created.tasks[0]!.id))!.task
      .currentExecution!;

    await workflow.failTurn(created.tasks[0]!.id, running.attemptId, {
      turnId: running.turnId!,
      message: "The prompt is invalid",
      codexErrorInfo: "badRequest",
    });

    expect((await store.findTask(created.tasks[0]!.id))!.task).toMatchObject({
      status: "blocked",
      currentExecution: { status: "failed" },
    });
    expect(taskDispatcher.started).toHaveLength(1);
  });

  it("keeps a scheduled retry paused and starts it once scheduling resumes", async () => {
    const created = await registerProject(1);
    await finishProjectExecution({
      projectId: created.project.id,
      outcome: "selected",
      summary: "Start the task",
      taskIds: [created.tasks[0]!.id],
    });
    const taskId = created.tasks[0]!.id;
    const running = (await store.findTask(taskId))!.task.currentExecution!;
    await workflow.failTurn(taskId, running.attemptId, {
      turnId: running.turnId!,
      message: "Selected model is at capacity. Please try a different model.",
      codexErrorInfo: "serverOverloaded",
    });
    await workflow.controlProject(created.project.id, "pause");

    now = new Date(now.getTime() + 5_000);
    await workflow.retryScheduledExecutions(now);
    expect((await store.findTask(taskId))!.task.currentExecution?.status).toBe(
      "retry_scheduled",
    );
    expect(taskDispatcher.started).toHaveLength(1);

    await workflow.controlProject(created.project.id, "resume");
    expect((await store.findTask(taskId))!.task.currentExecution).toMatchObject({
      status: "running",
      attemptId: running.attemptId,
    });
    expect(taskDispatcher.started).toHaveLength(2);
  });

  it("suppresses a stale recovery after the same task attempt has started", async () => {
    const created = await registerProject(1);
    await finishProjectExecution({
      projectId: created.project.id,
      outcome: "selected",
      summary: "Start",
      taskIds: [created.tasks[0]!.id],
    });
    const running = (await store.findTask(created.tasks[0]!.id))!.task;
    const events: Array<Record<string, unknown>> = [];
    store.subscribe((event) => events.push(event as unknown as Record<string, unknown>));

    await workflow.recoverTask(running.id, running.currentExecution!.attemptId);

    const current = (await store.findTask(running.id))!.task;
    expect(current.currentExecution?.attemptId).toBe(
      running.currentExecution!.attemptId,
    );
    expect(current.currentExecution?.turnId).toBe(running.currentExecution!.turnId);
    expect(taskDispatcher.started).toHaveLength(1);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "recovery.execution_suppressed",
        taskId: running.id,
        decision: "keep_current",
        reason: "execution_already_progressed",
      }),
    );
  });

  it("suppresses a stale recovery after the same project attempt has started", async () => {
    const created = await registerProject(1);
    const running = created.project.currentExecution!;

    await workflow.recoverProjectExecution(created.project.id, running.attemptId);

    const current = (await store.getProject(created.project.id))!.project;
    expect(current.currentExecution?.attemptId).toBe(running.attemptId);
    expect(current.currentExecution?.turnId).toBe(running.turnId);
    expect(projectExecutor.started).toHaveLength(1);
  });

  it("records concise state transitions around workflow events", async () => {
    const created = await store.createProject({
      name: "Tiny Game",
      repositoryPath: "/workspace/game",
      defaultBranch: "main",
      productDocument: "# Tiny Game\n",
      tasks: [{ title: "Task", description: "Build it", acceptanceCriteria: [] }],
    });
    const events: Array<Record<string, unknown>> = [];
    store.subscribe((event) => events.push(event as unknown as Record<string, unknown>));

    await workflow.controlProject(created.project.id, "pause");

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "project.paused",
        before: expect.objectContaining({
          status: "active",
          scheduling: "running",
        }),
        after: expect.objectContaining({
          status: "active",
          scheduling: "paused",
        }),
      }),
    );
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
        modelRouting: testModelRouting(),
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
