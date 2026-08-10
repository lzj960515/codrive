import { EventEmitter } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  type NotificationSource,
  RecoveryManager,
} from "../../src/application/recovery-manager.js";
import { WorkflowEngine } from "../../src/application/workflow-engine.js";
import type { CodexTurnStatus } from "../../src/application/codex-gateway.js";
import type { JsonRpcNotification } from "../../src/infrastructure/json-rpc-connection.js";
import { ProjectStore } from "../../src/infrastructure/project-store.js";
import {
  RecordingProjectExecutor,
  RecordingTaskDispatcher,
  testModelRouting,
  testModels,
} from "../support/recording-executors.js";

class StubNotifications implements NotificationSource {
  private readonly events = new EventEmitter();
  turnStatus: CodexTurnStatus | null = null;
  turnError: Error | null = null;

  onNotification(listener: (notification: JsonRpcNotification) => void): () => void {
    this.events.on("notification", listener);
    return () => this.events.off("notification", listener);
  }

  async readTurnStatus(): Promise<CodexTurnStatus | null> {
    if (this.turnError) throw this.turnError;
    return this.turnStatus;
  }
}

async function createTaskConversationFixture(conversationActive = false) {
  const store = new ProjectStore(
    await mkdtemp(join(tmpdir(), "codrive-task-conversation-")),
  );
  const created = await store.createProject({
    name: "Game",
    repositoryPath: "/workspace/game",
    defaultBranch: "main",
    productDocument: "# Game\n",
    tasks: [{ title: "Loop", description: "Build loop", acceptanceCriteria: [] }],
  });
  const taskId = created.tasks[0]!.id;
  await store.saveTask(created.project.id, {
    ...created.tasks[0]!,
    requestedAction: "develop",
  });
  const dispatcher = new RecordingTaskDispatcher();
  dispatcher.conversationActive = conversationActive;
  let sequence = 0;
  const workflow = new WorkflowEngine(store, dispatcher, {
    maxConcurrentTasks: 1,
    models: testModels,
    now: () => "2026-08-03T00:00:00.000Z",
    createId: (prefix) => `${prefix}_${++sequence}`,
  });
  await workflow.reconcile();
  return { store, workflow, dispatcher, taskId };
}

describe("RecoveryManager", () => {
  let store: ProjectStore;
  let workflow: WorkflowEngine;
  let recovery: RecoveryManager;
  let notifications: StubNotifications;
  let taskDispatcher: RecordingTaskDispatcher;
  let taskId: string;
  let createId: number;

  beforeEach(async () => {
    store = new ProjectStore(await mkdtemp(join(tmpdir(), "codrive-recovery-")));
    const snapshot = await store.createProject({
      name: "Game",
      repositoryPath: "/workspace/game",
      defaultBranch: "main",
      productDocument: "# Game\n",
      tasks: [{ title: "Loop", description: "Build loop", acceptanceCriteria: [] }],
    });
    taskId = snapshot.tasks[0]!.id;
    await store.saveTask(snapshot.project.id, {
      ...snapshot.tasks[0]!,
      requestedAction: "develop",
    });
    createId = 0;
    taskDispatcher = new RecordingTaskDispatcher();
    workflow = new WorkflowEngine(store, taskDispatcher, {
      maxConcurrentTasks: 1,
      models: testModels,
      now: () => "2026-08-03T00:00:00.000Z",
      createId: (prefix) => `${prefix}_${++createId}`,
    });
    await workflow.reconcile();
    notifications = new StubNotifications();
    recovery = new RecoveryManager(store, workflow, notifications);
  });

  it("marks an interrupted App Server turn as failed", async () => {
    const execution = (await store.findTask(taskId))!.task.currentExecution!;

    await recovery.handleNotification({
      method: "turn/completed",
      params: {
        turn: { id: execution.turnId, status: "interrupted", error: null },
      },
    });

    expect((await store.findTask(taskId))?.task).toMatchObject({
      status: "blocked",
      currentExecution: { status: "failed" },
    });
  });

  it("restores a persisted model-capacity retry at its exact backoff deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-03T00:00:00.000Z"));
    const timedStore = new ProjectStore(
      await mkdtemp(join(tmpdir(), "codrive-model-retry-")),
    );
    const created = await timedStore.createProject({
      name: "Retry Game",
      repositoryPath: "/workspace/retry-game",
      defaultBranch: "main",
      productDocument: "# Retry Game\n",
      tasks: [{ title: "Loop", description: "Build", acceptanceCriteria: [] }],
    });
    await timedStore.saveTask(created.project.id, {
      ...created.tasks[0]!,
      requestedAction: "develop",
    });
    const dispatcher = new RecordingTaskDispatcher();
    const timedWorkflow = new WorkflowEngine(timedStore, dispatcher, {
      maxConcurrentTasks: 1,
      models: testModels,
      now: () => new Date(Date.now()).toISOString(),
    });
    await timedWorkflow.reconcile();
    const first = (await timedStore.findTask(created.tasks[0]!.id))!.task
      .currentExecution!;
    await timedWorkflow.failTurn(created.tasks[0]!.id, first.attemptId, {
      turnId: first.turnId!,
      message: "Selected model is at capacity. Please try a different model.",
      codexErrorInfo: "serverOverloaded",
    });
    const restartedRecovery = new RecoveryManager(
      timedStore,
      new WorkflowEngine(timedStore, dispatcher, {
        maxConcurrentTasks: 1,
        models: testModels,
        now: () => new Date(Date.now()).toISOString(),
      }),
      new StubNotifications(),
    );

    try {
      await restartedRecovery.start();
      expect(vi.getTimerCount()).toBe(2);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(dispatcher.started).toHaveLength(1);
      expect(
        (await timedStore.findTask(created.tasks[0]!.id))!.task.currentExecution,
      ).toMatchObject({ status: "retry_scheduled", attemptId: first.attemptId });

      const beforeRetry = Date.now();
      await vi.advanceTimersToNextTimerAsync();
      expect(Date.now() - beforeRetry).toBe(1);
      vi.useRealTimers();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(
        (await timedStore.findTask(created.tasks[0]!.id))!.task.currentExecution,
      ).toMatchObject({ status: "running", attemptId: first.attemptId });
      expect(dispatcher.started).toHaveLength(2);

      await timedWorkflow.retryScheduledExecutions(new Date());
      expect(dispatcher.started).toHaveLength(2);
    } finally {
      restartedRecovery.stop();
      vi.useRealTimers();
    }
  });

  it("keeps the newest retry timer when schedule refreshes finish out of order", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-03T00:00:00.000Z"));
    const snapshot = (await store.getProject(
      (await store.findTask(taskId))!.project.id,
    ))!;
    const running = snapshot.tasks[0]!.currentExecution!;
    const retrySnapshot = (nextRetryAt: string) => ({
      project: snapshot.project,
      tasks: [
        {
          ...snapshot.tasks[0]!,
          currentExecution: {
            ...running,
            status: "retry_scheduled" as const,
            modelRouting: {
              ...running.modelRouting,
              nextRetryAt,
            },
          },
        },
      ],
    });
    let resolveOlderRefresh!: (
      value: Awaited<ReturnType<ProjectStore["listProjects"]>>,
    ) => void;
    const olderRefresh = new Promise<
      Awaited<ReturnType<ProjectStore["listProjects"]>>
    >((resolve) => {
      resolveOlderRefresh = resolve;
    });
    vi.spyOn(store, "listProjects")
      .mockImplementationOnce(() => olderRefresh)
      .mockResolvedValueOnce([
        retrySnapshot("2026-08-03T00:00:10.000Z"),
      ]);
    const refreshTimer = (
      recovery as unknown as {
        scheduleRetryWakeup(now?: Date): Promise<void>;
      }
    ).scheduleRetryWakeup.bind(recovery);

    try {
      const older = refreshTimer();
      await refreshTimer();
      resolveOlderRefresh([
        retrySnapshot("2026-08-03T00:00:05.000Z"),
      ]);
      await older;

      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(vi.getTimerCount()).toBe(1);
    } finally {
      recovery.stop();
      vi.useRealTimers();
    }
  });

  it("asks the same task conversation for a missing report", async () => {
    const execution = (await store.findTask(taskId))!.task.currentExecution!;

    await recovery.handleNotification({
      method: "turn/completed",
      params: { turn: { id: execution.turnId, status: "completed", error: null } },
    });

    expect((await store.findTask(taskId))?.task.currentExecution).toMatchObject({
      status: "awaiting_report",
      reportReminderCount: 1,
      turnId: "task_reminder_1",
    });
  });

  it("waits for an active task conversation before sending the report reminder", async () => {
    const { store, workflow, dispatcher, taskId } =
      await createTaskConversationFixture();
    const running = (await store.findTask(taskId))!.task;
    dispatcher.conversationActive = true;

    await workflow.completeTurn(
      running.id,
      running.currentExecution!.attemptId,
      running.currentExecution!.turnId!,
    );

    const waiting = (await store.findTask(running.id))!.task;
    expect(waiting.currentExecution).toMatchObject({
      status: "awaiting_report",
      turnId: running.currentExecution!.turnId,
      turnCompletedAt: "2026-08-03T00:00:00.000Z",
    });
    expect(dispatcher.reminders).toHaveLength(0);

    dispatcher.conversationActive = false;
    const deferredRecovery = new RecoveryManager(
      store,
      workflow,
      new StubNotifications(),
    );
    await deferredRecovery.recoverUnattendedWork(
      new Date("2026-08-03T00:01:00.000Z"),
    );

    const reminded = (await store.findTask(running.id))!.task;
    expect(reminded.currentExecution).toMatchObject({
      status: "awaiting_report",
      turnId: "task_reminder_1",
    });
    expect(reminded.currentExecution?.turnCompletedAt).toBeUndefined();
    expect(dispatcher.reminders).toHaveLength(1);
  });

  it("retries a deferred task turn during the minute recovery check", async () => {
    const { store, workflow, dispatcher, taskId } =
      await createTaskConversationFixture(true);

    expect((await store.findTask(taskId))!.task).toMatchObject({
      status: "developing",
      currentExecution: { status: "pending" },
    });
    expect(dispatcher.started).toHaveLength(0);

    dispatcher.conversationActive = false;
    const deferredRecovery = new RecoveryManager(
      store,
      workflow,
      new StubNotifications(),
    );
    await deferredRecovery.recoverUnattendedWork(
      new Date("2026-08-03T00:01:00.000Z"),
    );

    expect((await store.findTask(taskId))!.task).toMatchObject({
      status: "developing",
      currentExecution: { status: "running", turnId: "task_turn_1" },
    });
    expect(dispatcher.started).toHaveLength(1);
  });

  it("starts a deferred task as soon as its conversation becomes idle", async () => {
    const { store, workflow, dispatcher, taskId } =
      await createTaskConversationFixture(true);
    const pending = (await store.findTask(taskId))!.task;
    dispatcher.conversationActive = false;
    const deferredRecovery = new RecoveryManager(
      store,
      workflow,
      new StubNotifications(),
    );

    await deferredRecovery.handleNotification({
      method: "thread/status/changed",
      params: {
        threadId: pending.currentExecution!.threadId,
        status: { type: "idle" },
      },
    });

    expect((await store.findTask(pending.id))!.task.currentExecution).toMatchObject({
      status: "running",
      turnId: "task_turn_1",
    });
  });

  it("starts a new attempt when a running turn is absent after restart", async () => {
    const before = (await store.findTask(taskId))!.task.currentExecution!;

    await recovery.recoverInterruptedExecutions();

    const after = (await store.findTask(taskId))!.task.currentExecution!;
    expect(after.status).toBe("running");
    expect(after.attemptId).not.toBe(before.attemptId);
  });

  it("keeps the current attempt when its App Server turn is still running", async () => {
    notifications.turnStatus = "inProgress";
    const before = (await store.findTask(taskId))!.task.currentExecution!;
    const events: Array<Record<string, unknown>> = [];
    store.subscribe((event) => events.push(event as unknown as Record<string, unknown>));

    await recovery.recoverInterruptedExecutions();

    const after = (await store.findTask(taskId))!.task.currentExecution!;
    expect(after.attemptId).toBe(before.attemptId);
    expect(after.turnId).toBe(before.turnId);
    expect(taskDispatcher.started).toHaveLength(1);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "recovery.execution_observed",
        source: "recovery",
        taskId,
        attemptId: before.attemptId,
        threadId: before.threadId,
        turnId: before.turnId,
        decision: "keep_running",
        result: "inProgress",
      }),
    );
  });

  it("defers recovery when App Server turn status cannot be read", async () => {
    notifications.turnError = new Error("transport unavailable");
    const before = (await store.findTask(taskId))!.task.currentExecution!;
    const events: Array<Record<string, unknown>> = [];
    store.subscribe((event) => events.push(event as unknown as Record<string, unknown>));

    await recovery.recoverInterruptedExecutions();

    const after = (await store.findTask(taskId))!.task.currentExecution!;
    expect(after.attemptId).toBe(before.attemptId);
    expect(after.turnId).toBe(before.turnId);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "recovery.execution_observed",
        taskId,
        decision: "defer",
        result: "read_failed",
        reason: "transport unavailable",
      }),
    );
  });

  it("renews an expired lease while the App Server turn is active", async () => {
    notifications.turnStatus = "inProgress";
    const before = (await store.findTask(taskId))!.task.currentExecution!;

    await recovery.recoverExpiredExecutions(new Date("2026-08-03T07:00:00.000Z"));

    const after = (await store.findTask(taskId))!.task.currentExecution!;
    expect(after.attemptId).toBe(before.attemptId);
    expect(after.leaseExpiresAt).toBeDefined();
  });

  it("does not repeat an earlier wait decision when work stops without completing", async () => {
    const idleStore = new ProjectStore(
      await mkdtemp(join(tmpdir(), "codrive-idle-recovery-")),
    );
    const created = await idleStore.createProject({
      name: "Game",
      repositoryPath: "/workspace/game",
      defaultBranch: "main",
      productDocument: "# Game\n",
      tasks: [
        { title: "Foundation", description: "Build it", acceptanceCriteria: [] },
        { title: "Gameplay", description: "Build it next", acceptanceCriteria: [] },
      ],
    });
    await idleStore.saveTask(created.project.id, {
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
    const projectExecutor = new RecordingProjectExecutor();
    const idleWorkflow = new WorkflowEngine(
      idleStore,
      new RecordingTaskDispatcher(),
      {
        maxConcurrentTasks: 4,
        models: testModels,
        now: () => "2026-08-03T00:00:00.000Z",
        createId: (prefix) => `${prefix}_idle`,
      },
      projectExecutor,
    );
    await idleWorkflow.reconcile();
    const selecting = (await idleStore.getProject(created.project.id))!.project;
    await idleWorkflow.submitProjectReport({
      projectId: created.project.id,
      attemptId: selecting.currentExecution!.attemptId,
      outcome: "wait_for_active_tasks",
      summary: "Gameplay should wait for the foundation",
    });
    await idleWorkflow.completeProjectTurn(
      created.project.id,
      selecting.currentExecution!.attemptId,
      selecting.currentExecution!.turnId!,
    );
    const idleRecovery = new RecoveryManager(
      idleStore,
      idleWorkflow,
      new StubNotifications(),
    );
    const suppressedReasons: string[] = [];
    idleStore.subscribe((event) => {
      if (event.type === "recovery.planning_suppressed") {
        suppressedReasons.push(event.reason ?? "");
      }
    });

    await idleRecovery.recoverUnattendedWork();
    expect(projectExecutor.started).toHaveLength(1);

    const foundation = (await idleStore.findTask(created.tasks[0]!.id))!.task;
    await idleStore.saveTask(created.project.id, {
      ...foundation,
      requestedAction: null,
      currentExecution: {
        ...foundation.currentExecution!,
        status: "completed",
        finishedAt: "2026-08-03T01:00:00.000Z",
      },
    });

    const beforeExpiry = new Date("2026-08-03T01:00:00.000Z");
    await idleRecovery.recoverUnattendedWork(beforeExpiry);
    await idleRecovery.recoverUnattendedWork(beforeExpiry);

    expect(projectExecutor.started).toHaveLength(1);
    expect(suppressedReasons).toEqual([
      "planning_revision_already_evaluated",
      "planning_revision_already_evaluated",
    ]);
  });

  it("checks every minute for a running project with no active Codex work", async () => {
    const timedStore = new ProjectStore(
      await mkdtemp(join(tmpdir(), "codrive-timed-recovery-")),
    );
    const projectExecutor = new RecordingProjectExecutor();
    const timedWorkflow = new WorkflowEngine(
      timedStore,
      new RecordingTaskDispatcher(),
      { maxConcurrentTasks: 4, models: testModels },
      projectExecutor,
    );
    const timedRecovery = new RecoveryManager(
      timedStore,
      timedWorkflow,
      new StubNotifications(),
    );
    const periodicCheck = vi.spyOn(timedRecovery, "recoverUnattendedWork");
    vi.useFakeTimers();
    try {
      await timedRecovery.start();
      await timedStore.createProject({
        name: "Game",
        repositoryPath: "/workspace/game",
        defaultBranch: "main",
        productDocument: "# Game\n",
        tasks: [
          { title: "Loop", description: "Build loop", acceptanceCriteria: [] },
        ],
      });

      await vi.advanceTimersByTimeAsync(60_000);
      expect(periodicCheck).toHaveBeenCalledTimes(1);
      await periodicCheck.mock.results[0]!.value;

      expect(projectExecutor.started).toHaveLength(1);
      expect(projectExecutor.started[0]?.project.requestedAction).toBe(
        "select_tasks",
      );
    } finally {
      timedRecovery.stop();
      vi.useRealTimers();
    }
  });

  it("advances a saved task report when thread/read says the turn completed", async () => {
    const started = (await store.findTask(taskId))!.task;
    await workflow.submitReport({
      taskId,
      attemptId: started.currentExecution!.attemptId,
      outcome: "completed",
      summary: "Implemented",
      workspacePath: "/workspace/game/.worktrees/loop",
      candidateCommit: "abc123",
    });
    notifications.turnStatus = "completed";

    await recovery.recoverInterruptedExecutions();

    expect((await store.findTask(taskId))?.task).toMatchObject({
      status: "reviewing",
      requestedAction: "review",
      latestReport: { candidateCommit: "abc123" },
      currentExecution: { action: "review", status: "running" },
    });
  });

  it("routes completed temporary project turns to product evaluation", async () => {
    const evaluationStore = new ProjectStore(
      await mkdtemp(join(tmpdir(), "codrive-evaluation-recovery-")),
    );
    const created = await evaluationStore.createProject({
      name: "Game",
      repositoryPath: "/workspace/game",
      defaultBranch: "main",
      productDocument: "# Game\n",
      tasks: [{ title: "Loop", description: "Build loop", acceptanceCriteria: [] }],
    });
    await evaluationStore.saveTask(created.project.id, {
      ...created.tasks[0]!,
      status: "done",
      mergedCommit: "merged_1",
    });
    const projectExecutor = new RecordingProjectExecutor();
    const evaluationWorkflow = new WorkflowEngine(
      evaluationStore,
      new RecordingTaskDispatcher(),
      { maxConcurrentTasks: 4, models: testModels },
      projectExecutor,
    );
    await evaluationWorkflow.reconcile();
    const evaluating = (await evaluationStore.getProject(created.project.id))!.project;
    await evaluationWorkflow.submitProjectReport({
      projectId: created.project.id,
      attemptId: evaluating.currentExecution!.attemptId,
      outcome: "completed",
      summary: "Product criteria satisfied",
    });
    const evaluationRecovery = new RecoveryManager(
      evaluationStore,
      evaluationWorkflow,
      new StubNotifications(),
    );

    await evaluationRecovery.handleNotification({
      method: "turn/completed",
      params: {
        turn: {
          id: evaluating.currentExecution!.turnId,
          status: "completed",
          error: null,
        },
      },
    });

    expect(
      (await evaluationStore.getProject(created.project.id))?.project.status,
    ).toBe("completed");
  });
});
