import { EventEmitter } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  type NotificationSource,
  RecoveryManager,
} from "../../src/application/recovery-manager.js";
import { ExecutionActivityBridge } from "../../src/application/execution-activity-bridge.js";
import { WorkflowEngine } from "../../src/application/workflow-engine.js";
import type {
  CodexTurnSnapshot,
  CodexTurnStatus,
} from "../../src/application/codex-gateway.js";
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
  turnSnapshot: CodexTurnSnapshot = {
    threadStatus: "idle",
    activeTurnIds: [],
    turn: null,
  };
  readonly snapshotReads: Array<{ threadId: string; turnId: string }> = [];
  beforeSnapshotReturn?: (() => Promise<void>) | undefined;

  onNotification(listener: (notification: JsonRpcNotification) => void): () => void {
    this.events.on("notification", listener);
    return () => this.events.off("notification", listener);
  }

  async readTurnStatus(): Promise<CodexTurnStatus | null> {
    if (this.turnError) throw this.turnError;
    return this.turnStatus;
  }

  async readTurnSnapshot(
    threadId: string,
    turnId: string,
  ): Promise<CodexTurnSnapshot> {
    if (this.turnError) throw this.turnError;
    this.snapshotReads.push({ threadId, turnId });
    await this.beforeSnapshotReturn?.();
    return this.turnSnapshot;
  }

}

function requiredReportOpportunity(execution: {
  reportOpportunityId?: string;
}): string {
  expect(execution.reportOpportunityId).toEqual(expect.any(String));
  return execution.reportOpportunityId!;
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

  it("resumes an interrupted App Server turn in the same task execution", async () => {
    const execution = (await store.findTask(taskId))!.task.currentExecution!;

    await recovery.handleNotification({
      method: "turn/completed",
      params: {
        turn: { id: execution.turnId, status: "interrupted", error: null },
      },
    });

    expect((await store.findTask(taskId))?.task).toMatchObject({
      status: "developing",
      currentExecution: {
        status: "running",
        attemptId: execution.attemptId,
        threadId: execution.threadId,
      },
    });
    expect((await store.findTask(taskId))?.task.currentExecution?.turnId).not.toBe(
      execution.turnId,
    );
    expect(taskDispatcher.resumed).toHaveLength(1);
  });

  it("ignores the interrupted notification produced by task cancellation", async () => {
    const execution = (await store.findTask(taskId))!.task.currentExecution!;
    await workflow.cancelTask(taskId, {
      cancelledBy: "user",
      decisionBasis: "user_confirmed",
      reason: "Stop this task",
    });

    await recovery.handleNotification({
      method: "turn/completed",
      params: {
        turn: { id: execution.turnId, status: "interrupted", error: null },
      },
    });

    expect((await store.findTask(taskId))?.task).toMatchObject({
      status: "cancelled",
      requestedAction: null,
      currentExecution: {
        status: "interrupted",
        attemptId: execution.attemptId,
        threadId: execution.threadId,
      },
    });
    expect(taskDispatcher.resumed).toHaveLength(0);
  });

  it("ignores high-frequency App Server notifications that cannot change workflow state", async () => {
    const record = vi.spyOn(workflow.lifecycle, "record");

    await recovery.handleNotification({
      method: "item/agentMessage/delta",
      params: { delta: "partial response" },
    });

    expect(record).not.toHaveBeenCalled();
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
    const restartedWorkflow = new WorkflowEngine(timedStore, dispatcher, {
      maxConcurrentTasks: 1,
      models: testModels,
      now: () => new Date(Date.now()).toISOString(),
    });
    const restartedRecovery = new RecoveryManager(
      timedStore,
      restartedWorkflow,
      new StubNotifications(),
    );
    let resolveRetryStarted!: () => void;
    const retryStarted = new Promise<void>((resolve) => {
      resolveRetryStarted = resolve;
    });
    const unsubscribeRetryStarted = timedStore.subscribe((event) => {
      if (
        event.type === "turn.started" &&
        event.taskId === created.tasks[0]!.id &&
        event.attemptId === first.attemptId
      ) {
        resolveRetryStarted();
      }
    });

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
      await retryStarted;
      expect(
        (await timedStore.findTask(created.tasks[0]!.id))!.task.currentExecution,
      ).toMatchObject({ status: "running", attemptId: first.attemptId });
      expect(dispatcher.started).toHaveLength(2);

      await timedWorkflow.retryScheduledExecutions(new Date());
      expect(dispatcher.started).toHaveLength(2);
    } finally {
      unsubscribeRetryStarted();
      restartedRecovery.stop();
      vi.useRealTimers();
    }
  });

  it("restores a persisted planned blocker at its exact deadline after restart", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-03T00:00:00.000Z"));
    const timedStore = new ProjectStore(
      await mkdtemp(join(tmpdir(), "codrive-scheduled-resume-")),
    );
    const created = await timedStore.createProject({
      name: "Scheduled Game",
      repositoryPath: "/workspace/scheduled-game",
      defaultBranch: "main",
      productDocument: "# Scheduled Game\n",
      tasks: [{ title: "Loop", description: "Build", acceptanceCriteria: [] }],
    });
    await timedStore.saveTask(created.project.id, {
      ...created.tasks[0]!,
      status: "blocked",
      requestedAction: "develop",
      currentExecution: {
        attemptId: "attempt_1",
        action: "develop",
        status: "waiting_for_resume",
        startedAt: "2026-08-02T23:00:00.000Z",
        threadId: "thread_1",
        modelRouting: testModelRouting(),
        scheduledResume: {
          reason: "Wait for the build",
          resumeAt: "2026-08-03T00:00:05.000Z",
          resumePrompt: "Inspect build 42 and continue.",
        },
      },
    });
    const dispatcher = new RecordingTaskDispatcher();
    const restartedWorkflow = new WorkflowEngine(timedStore, dispatcher, {
      maxConcurrentTasks: 1,
      models: testModels,
      now: () => new Date(Date.now()).toISOString(),
    });
    const resumeScheduledTasks = vi.spyOn(
      restartedWorkflow,
      "resumeScheduledTasks",
    );
    const restartedRecovery = new RecoveryManager(
      timedStore,
      restartedWorkflow,
      new StubNotifications(),
    );
    let resolveResumeStarted!: () => void;
    const resumeStarted = new Promise<void>((resolve) => {
      resolveResumeStarted = resolve;
    });
    const unsubscribeResumeStarted = timedStore.subscribe((event) => {
      if (event.type === "task.scheduled_resume_started") {
        resolveResumeStarted();
      }
    });

    try {
      await restartedRecovery.start();
      expect(vi.getTimerCount()).toBe(2);
      expect(dispatcher.scheduledResumes).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(dispatcher.scheduledResumes).toHaveLength(0);

      await vi.advanceTimersToNextTimerAsync();
      await resumeStarted;
      expect(Date.now()).toBe(Date.parse("2026-08-03T00:00:05.000Z"));
      expect(resumeScheduledTasks).toHaveBeenLastCalledWith(
        new Date("2026-08-03T00:00:05.000Z"),
      );
      expect(
        (await timedStore.findTask(created.tasks[0]!.id))!.task.currentExecution,
      ).toMatchObject({ status: "running", attemptId: "attempt_1" });
      expect(dispatcher.scheduledResumes).toHaveLength(1);
    } finally {
      unsubscribeResumeStarted();
      restartedRecovery.stop();
      vi.useRealTimers();
    }
  });

  it("waits in timer-sized segments for a scheduled resume beyond the Node timer limit", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-03T00:00:00.000Z"));
    const timedStore = new ProjectStore(
      await mkdtemp(join(tmpdir(), "codrive-long-scheduled-resume-")),
    );
    const created = await timedStore.createProject({
      name: "Long Scheduled Game",
      repositoryPath: "/workspace/long-scheduled-game",
      defaultBranch: "main",
      productDocument: "# Long Scheduled Game\n",
      tasks: [{ title: "Loop", description: "Build", acceptanceCriteria: [] }],
    });
    await timedStore.saveTask(created.project.id, {
      ...created.tasks[0]!,
      status: "blocked",
      requestedAction: "develop",
      currentExecution: {
        attemptId: "attempt_1",
        action: "develop",
        status: "waiting_for_resume",
        startedAt: "2026-08-02T23:00:00.000Z",
        threadId: "thread_1",
        modelRouting: testModelRouting(),
        scheduledResume: {
          reason: "Wait for the release window",
          resumeAt: "2026-09-02T00:00:00.000Z",
          resumePrompt: "Inspect the release window and continue.",
        },
      },
    });
    const dispatcher = new RecordingTaskDispatcher();
    const restartedRecovery = new RecoveryManager(
      timedStore,
      new WorkflowEngine(timedStore, dispatcher, {
        maxConcurrentTasks: 1,
        models: testModels,
        now: () => new Date(Date.now()).toISOString(),
      }),
      new StubNotifications(),
    );
    type RetryScheduler = {
      scheduleRetryWakeup(now?: Date): Promise<void>;
    };
    const retryScheduler = restartedRecovery as unknown as RetryScheduler;
    const scheduleRetryWakeup =
      retryScheduler.scheduleRetryWakeup.bind(retryScheduler);
    let completedSchedules = 0;
    let resolveNextSegmentScheduled!: () => void;
    const nextSegmentScheduled = new Promise<void>((resolve) => {
      resolveNextSegmentScheduled = resolve;
    });
    const scheduleRetryWakeupSpy = vi
      .spyOn(retryScheduler, "scheduleRetryWakeup")
      .mockImplementation(async (now?: Date) => {
        await scheduleRetryWakeup(now);
        completedSchedules += 1;
        if (completedSchedules === 2) resolveNextSegmentScheduled();
      });
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    try {
      await restartedRecovery.start();

      expect(setTimeoutSpy).toHaveBeenCalledWith(
        expect.any(Function),
        2_147_483_647,
      );
      await vi.advanceTimersByTimeAsync(2_147_483_647);
      await nextSegmentScheduled;
      expect(dispatcher.scheduledResumes).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(2);
    } finally {
      restartedRecovery.stop();
      scheduleRetryWakeupSpy.mockRestore();
      setTimeoutSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("does not spin a zero-delay timer when a due resume is waiting for capacity", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-03T00:00:00.000Z"));
    const timedStore = new ProjectStore(
      await mkdtemp(join(tmpdir(), "codrive-capacity-scheduled-resume-")),
    );
    const created = await timedStore.createProject({
      name: "Capacity Scheduled Game",
      repositoryPath: "/workspace/capacity-scheduled-game",
      defaultBranch: "main",
      productDocument: "# Capacity Scheduled Game\n",
      tasks: [
        { title: "Active", description: "Build", acceptanceCriteria: [] },
        { title: "Waiting", description: "Wait", acceptanceCriteria: [] },
      ],
    });
    await timedStore.saveTask(created.project.id, {
      ...created.tasks[0]!,
      status: "developing",
      requestedAction: "develop",
      currentExecution: {
        attemptId: "active_attempt",
        action: "develop",
        status: "running",
        startedAt: "2026-08-02T23:00:00.000Z",
        threadId: "active_thread",
        turnId: "active_turn",
        modelRouting: testModelRouting(),
      },
    });
    await timedStore.saveTask(created.project.id, {
      ...created.tasks[1]!,
      status: "blocked",
      requestedAction: "develop",
      currentExecution: {
        attemptId: "waiting_attempt",
        action: "develop",
        status: "waiting_for_resume",
        startedAt: "2026-08-02T23:00:00.000Z",
        threadId: "waiting_thread",
        modelRouting: testModelRouting(),
        scheduledResume: {
          reason: "Wait for capacity",
          resumeAt: "2026-08-03T00:00:05.000Z",
          resumePrompt: "Continue when capacity is available.",
        },
      },
    });
    const dispatcher = new RecordingTaskDispatcher();
    const capacityWorkflow = new WorkflowEngine(timedStore, dispatcher, {
      maxConcurrentTasks: 1,
      models: testModels,
      now: () => new Date(Date.now()).toISOString(),
    });
    const capacityRecovery = new RecoveryManager(
      timedStore,
      capacityWorkflow,
      new StubNotifications(),
    );
    const refreshTimer = (
      capacityRecovery as unknown as {
        scheduleRetryWakeup(now?: Date): Promise<void>;
      }
    ).scheduleRetryWakeup.bind(capacityRecovery);

    try {
      vi.setSystemTime(new Date("2026-08-03T00:00:05.000Z"));
      await capacityWorkflow.resumeScheduledTasks(new Date());
      await refreshTimer(new Date());

      expect(dispatcher.scheduledResumes).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);

      const active = (await timedStore.findTask(created.tasks[0]!.id))!.task;
      await timedStore.saveTask(created.project.id, {
        ...active,
        status: "done",
        requestedAction: null,
        currentExecution: {
          ...active.currentExecution!,
          status: "completed",
          finishedAt: new Date(Date.now()).toISOString(),
        },
      });
      await capacityWorkflow.resumeScheduledTasks(new Date());
      expect(dispatcher.scheduledResumes).toHaveLength(1);
    } finally {
      capacityRecovery.stop();
      vi.useRealTimers();
    }
  });

  it("compensates an overdue planned blocker once during startup", async () => {
    const found = (await store.findTask(taskId))!;
    const execution = found.task.currentExecution!;
    await workflow.submitReport({
      taskId,
      attemptId: execution.attemptId,
      reportOpportunityId: requiredReportOpportunity(execution),
      outcome: "blocked",
      summary: "Wait for the build",
      resumeAt: "2026-08-03T00:01:00.000Z",
      resumePrompt: "Inspect the build and continue.",
    });
    await workflow.completeTurn(taskId, execution.attemptId, execution.turnId!);
    const blockedActivityId = (await store.findTask(taskId))!.task
      .currentExecution!.submittedActivityId;
    const blockedOpportunityId = execution.reportOpportunityId;

    await recovery.start();
    await recovery.recoverUnattendedWork(new Date("2026-08-03T00:02:00.000Z"));

    expect(taskDispatcher.scheduledResumes).toHaveLength(1);
    expect((await store.findTask(taskId))!.task.currentExecution).toMatchObject({
      attemptId: execution.attemptId,
      status: "running",
    });
    const resumedExecution = (await store.findTask(taskId))!.task.currentExecution!;
    expect(resumedExecution.reportOpportunityId).not.toBe(blockedOpportunityId);
    const reported = await workflow.submitReport({
      taskId,
      attemptId: execution.attemptId,
      reportOpportunityId: requiredReportOpportunity(resumedExecution),
      outcome: "completed",
      summary: "Implemented after startup resumed the wait",
      workspacePath: "/workspace/game/.worktrees/loop",
      candidateCommit: "candidate_after_restart",
    });
    const completedActivityId = reported.currentExecution!.submittedActivityId;
    expect(completedActivityId).toBeDefined();
    expect(completedActivityId).not.toBe(blockedActivityId);
    const reportActivities = (
      await store.listTaskActivities(found.project.id, taskId)
    ).filter(
      ({ attemptId, outcome }) =>
        attemptId === execution.attemptId && outcome !== undefined,
    );
    expect(reportActivities).toHaveLength(2);
    expect(reportActivities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: blockedActivityId, outcome: "blocked" }),
        expect.objectContaining({ outcome: "completed" }),
      ]),
    );
    recovery.stop();
  });

  it("defers one due resume while its conversation is busy and resumes once on idle", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-03T00:00:00.000Z"));
    const found = (await store.findTask(taskId))!;
    const execution = found.task.currentExecution!;
    await store.saveTask(found.project.id, {
      ...found.task,
      status: "blocked",
      currentExecution: {
        ...execution,
        status: "waiting_for_resume",
        submittedActivityId: "activity_before_wait",
        scheduledResume: {
          reason: "Wait for the build",
          resumeAt: "2026-08-02T23:59:00.000Z",
          resumePrompt: "Inspect the build and continue.",
        },
      },
    });
    taskDispatcher.conversationActive = true;
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    try {
      await recovery.start();

      expect(taskDispatcher.scheduledResumes).toHaveLength(0);
      expect((await store.findTask(taskId))!.task.currentExecution).toMatchObject({
        status: "waiting_for_resume",
        reportOpportunityId: expect.any(String),
        scheduledResume: { wakeAttemptedAt: "2026-08-03T00:00:00.000Z" },
      });
      const deferredOpportunityId = (await store.findTask(taskId))!.task
        .currentExecution!.reportOpportunityId;
      expect(deferredOpportunityId).not.toBe(execution.reportOpportunityId);
      expect(setTimeoutSpy.mock.calls).not.toContainEqual([
        expect.any(Function),
        0,
      ]);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(taskDispatcher.scheduledResumes).toHaveLength(0);

      taskDispatcher.conversationActive = false;
      const idleNotification: JsonRpcNotification = {
        method: "thread/status/changed",
        params: {
          threadId: execution.threadId,
          status: { type: "idle" },
        },
      };
      await recovery.handleNotification(idleNotification);
      await recovery.handleNotification(idleNotification);

      expect(taskDispatcher.scheduledResumes).toHaveLength(1);
      expect((await store.findTask(taskId))!.task.currentExecution).toMatchObject({
        status: "running",
        attemptId: execution.attemptId,
        threadId: execution.threadId,
        reportOpportunityId: deferredOpportunityId,
      });
    } finally {
      recovery.stop();
      setTimeoutSpy.mockRestore();
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
      reportOpportunityId: execution.reportOpportunityId,
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
      reportOpportunityId: running.currentExecution!.reportOpportunityId,
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
      reportOpportunityId: running.currentExecution!.reportOpportunityId,
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

  it("resumes an interrupted task in its current attempt and conversation", async () => {
    notifications.turnStatus = "interrupted";
    const found = (await store.findTask(taskId))!;
    const before = found.task.currentExecution!;
    await store.saveTask(found.project.id, {
      ...found.task,
      currentExecution: {
        ...before,
        turnStartedAt: "2026-08-02T23:59:00.000Z",
        modelRouting: {
          model: testModels.fallback,
          route: "fallback",
          retryCount: 2,
        },
      },
    });

    await recovery.recoverInterruptedExecutions();

    const after = (await store.findTask(taskId))!.task.currentExecution!;
    expect(after).toMatchObject({
      status: "running",
      attemptId: before.attemptId,
      action: before.action,
      threadId: before.threadId,
      modelRouting: {
        model: testModels.fallback,
        route: "fallback",
        retryCount: 2,
        circuitBreaker: {
          state: "open",
          primaryProbeAt: "2026-08-03T00:05:00.000Z",
        },
      },
    });
    expect(after.turnId).not.toBe(before.turnId);
    expect(after.reportOpportunityId).toBe(before.reportOpportunityId);
    expect(taskDispatcher.opened).toHaveLength(1);
    expect(taskDispatcher.resumed).toEqual([
      expect.objectContaining({
        task: expect.objectContaining({ id: taskId }),
        threadId: before.threadId,
      }),
    ]);
    expect(await store.listTaskActivities(found.project.id, taskId)).toEqual([
      expect.objectContaining({
        type: "execution_recovered",
        attemptId: before.attemptId,
        threadId: before.threadId,
      }),
    ]);

    await expect(
      workflow.submitReport({
        taskId,
        attemptId: before.attemptId,
        reportOpportunityId: requiredReportOpportunity(after),
        outcome: "completed",
        summary: "Completed after service recovery",
        workspacePath: "/workspace/game/.worktrees/task",
        candidateCommit: "candidate_after_recovery",
      }),
    ).resolves.toMatchObject({
      currentExecution: {
        attemptId: before.attemptId,
        submittedActivityId: expect.any(String),
      },
    });
  });

  it("blocks recovery instead of creating a new conversation when the persisted thread cannot resume", async () => {
    notifications.turnStatus = "interrupted";
    const before = (await store.findTask(taskId))!.task.currentExecution!;
    taskDispatcher.beforeResumeThread = async () => {
      throw new Error("persisted thread is unavailable");
    };

    await recovery.recoverInterruptedExecutions();

    const found = (await store.findTask(taskId))!;
    expect(found.task).toMatchObject({
      status: "blocked",
      currentExecution: {
        status: "failed",
        attemptId: before.attemptId,
        threadId: before.threadId,
      },
    });
    expect(taskDispatcher.opened).toHaveLength(1);
    expect(taskDispatcher.started).toHaveLength(1);
    expect(await store.listTaskActivities(found.project.id, taskId)).toEqual([
      expect.objectContaining({
        type: "execution_failed",
        summary: expect.stringContaining("persisted thread is unavailable"),
        attemptId: before.attemptId,
        threadId: before.threadId,
      }),
    ]);
  });

  it("probes primary when stable fallback recovery reaches its cooldown", async () => {
    notifications.turnStatus = "interrupted";
    const found = (await store.findTask(taskId))!;
    const before = found.task.currentExecution!;
    await store.saveTask(found.project.id, {
      ...found.task,
      currentExecution: {
        ...before,
        turnStartedAt: "2026-08-02T23:55:00.000Z",
        modelRouting: {
          model: testModels.fallback,
          route: "fallback",
          retryCount: 2,
          circuitBreaker: {
            state: "open",
            primaryProbeAt: "2026-08-03T00:00:00.000Z",
          },
        },
      },
    });

    await recovery.recoverInterruptedExecutions();

    expect((await store.findTask(taskId))!.task.currentExecution).toMatchObject({
      status: "running",
      attemptId: before.attemptId,
      threadId: before.threadId,
      modelRouting: {
        model: testModels.primary,
        route: "primary",
        retryCount: 0,
        circuitBreaker: {
          state: "half_open",
          fallbackRetryCount: 0,
        },
      },
    });
    expect(taskDispatcher.resumed.at(-1)?.task.currentExecution?.modelRouting).toMatchObject({
      model: testModels.primary,
      route: "primary",
      circuitBreaker: { state: "half_open" },
    });
  });

  it("keeps a recovered half-open probe on the primary model", async () => {
    notifications.turnStatus = "interrupted";
    const found = (await store.findTask(taskId))!;
    const before = found.task.currentExecution!;
    await store.saveTask(found.project.id, {
      ...found.task,
      currentExecution: {
        ...before,
        turnStartedAt: "2026-08-02T23:59:00.000Z",
        modelRouting: {
          model: testModels.primary,
          route: "primary",
          retryCount: 0,
          circuitBreaker: {
            state: "half_open",
            fallbackRetryCount: 2,
            probeStartedAt: "2026-08-02T23:59:00.000Z",
          },
        },
      },
    });

    await recovery.recoverInterruptedExecutions();

    expect((await store.findTask(taskId))!.task.currentExecution).toMatchObject({
      status: "running",
      attemptId: before.attemptId,
      threadId: before.threadId,
      modelRouting: {
        model: testModels.primary,
        route: "primary",
        retryCount: 0,
        circuitBreaker: {
          state: "half_open",
          fallbackRetryCount: 2,
          probeStartedAt: "2026-08-03T00:00:00.000Z",
        },
      },
    });
    expect(taskDispatcher.resumed).toHaveLength(1);
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

  it("starts a fresh ten-minute observation window before inspecting persisted running work", async () => {
    const startedAt = new Date("2026-08-03T00:00:00.000Z");
    const activityBridge = new ExecutionActivityBridge({
      store,
      now: () => startedAt,
    });
    const silentRecovery = new RecoveryManager(store, workflow, notifications, {
      activityBridge,
      now: () => startedAt,
    });
    const execution = (await store.findTask(taskId))!.task.currentExecution!;
    notifications.turnSnapshot = coherentSnapshot(execution.turnId!, "interrupted");

    try {
      await silentRecovery.start();

      expect(notifications.snapshotReads).toEqual([]);
      expect(taskDispatcher.resumed).toEqual([]);

      await silentRecovery.recoverSilentTaskExecutions(
        new Date("2026-08-03T00:09:59.999Z"),
      );
      expect(notifications.snapshotReads).toEqual([]);

      await silentRecovery.recoverSilentTaskExecutions(
        new Date("2026-08-03T00:10:00.000Z"),
      );
      expect(notifications.snapshotReads).toEqual([
        { threadId: execution.threadId, turnId: execution.turnId },
      ]);
      expect(taskDispatcher.resumed).toHaveLength(1);
    } finally {
      silentRecovery.stop();
      activityBridge.close();
    }
  });

  it("restarts the silence window when the exact turn is still in progress", async () => {
    const observedAt = new Date("2026-08-03T00:00:00.000Z");
    const activityBridge = new ExecutionActivityBridge({
      store,
      now: () => observedAt,
    });
    await activityBridge.initialize(observedAt);
    const silentRecovery = new RecoveryManager(store, workflow, notifications, {
      activityBridge,
    });
    const execution = (await store.findTask(taskId))!.task.currentExecution!;
    notifications.turnSnapshot = coherentSnapshot(execution.turnId!, "inProgress");

    await silentRecovery.recoverSilentTaskExecutions(
      new Date("2026-08-03T00:10:00.000Z"),
    );
    await silentRecovery.recoverSilentTaskExecutions(
      new Date("2026-08-03T00:19:59.999Z"),
    );
    expect(notifications.snapshotReads).toHaveLength(1);

    await silentRecovery.recoverSilentTaskExecutions(
      new Date("2026-08-03T00:20:00.000Z"),
    );
    expect(notifications.snapshotReads).toHaveLength(2);
    expect(taskDispatcher.resumed).toEqual([]);
    activityBridge.close();
  });

  it("completes a silent turn whose persisted thread is not loaded", async () => {
    const observedAt = new Date("2026-08-03T00:00:00.000Z");
    const activityBridge = new ExecutionActivityBridge({
      store,
      now: () => observedAt,
    });
    await activityBridge.initialize(observedAt);
    const silentRecovery = new RecoveryManager(store, workflow, notifications, {
      activityBridge,
    });
    const execution = (await store.findTask(taskId))!.task.currentExecution!;
    notifications.turnSnapshot = {
      ...coherentSnapshot(execution.turnId!, "completed"),
      threadStatus: "notLoaded",
    };

    await silentRecovery.recoverSilentTaskExecutions(
      new Date("2026-08-03T00:10:00.000Z"),
    );

    expect(taskDispatcher.resumed).toEqual([]);
    expect(taskDispatcher.reminders).toHaveLength(1);
    expect((await store.findTask(taskId))!.task.currentExecution).toMatchObject({
      attemptId: execution.attemptId,
      status: "awaiting_report",
      turnId: "task_reminder_1",
    });
    activityBridge.close();
  });

  it.each(["interrupted", "failed"] as const)(
    "resumes a silent %s turn whose persisted thread is not loaded",
    async (status) => {
      const observedAt = new Date("2026-08-03T00:00:00.000Z");
      const activityBridge = new ExecutionActivityBridge({
        store,
        now: () => observedAt,
      });
      await activityBridge.initialize(observedAt);
      const silentRecovery = new RecoveryManager(store, workflow, notifications, {
        activityBridge,
      });
      const execution = (await store.findTask(taskId))!.task.currentExecution!;
      notifications.turnSnapshot = {
        ...coherentSnapshot(execution.turnId!, status),
        threadStatus: "notLoaded",
      };

      await silentRecovery.recoverSilentTaskExecutions(
        new Date("2026-08-03T00:10:00.000Z"),
      );

      expect(taskDispatcher.resumed).toHaveLength(1);
      expect(
        await store.listTaskActivities(
          (await store.findTask(taskId))!.project.id,
          taskId,
        ),
      ).toEqual([
        expect.objectContaining({
          type: "execution_recovered",
          attemptId: execution.attemptId,
          threadId: execution.threadId,
        }),
      ]);
      activityBridge.close();
    },
  );

  it.each([
    ["active", []],
    ["systemError", []],
    ["notLoaded", ["turn-new"]],
  ] as const)(
    "defers a terminal turn when thread status %s still conflicts with it",
    async (threadStatus, activeTurnIds) => {
      const observedAt = new Date("2026-08-03T00:00:00.000Z");
      const activityBridge = new ExecutionActivityBridge({
        store,
        now: () => observedAt,
      });
      await activityBridge.initialize(observedAt);
      const silentRecovery = new RecoveryManager(store, workflow, notifications, {
        activityBridge,
      });
      const execution = (await store.findTask(taskId))!.task.currentExecution!;
      notifications.turnSnapshot = {
        threadStatus,
        activeTurnIds: [...activeTurnIds],
        turn: {
          id: execution.turnId!,
          status: "failed",
          items: [],
        },
      };

      await silentRecovery.recoverSilentTaskExecutions(
        new Date("2026-08-03T00:10:00.000Z"),
      );

      expect(taskDispatcher.resumed).toEqual([]);
      expect((await store.findTask(taskId))!.task.currentExecution).toMatchObject({
        attemptId: execution.attemptId,
        status: execution.status,
        threadId: execution.threadId,
        turnId: execution.turnId,
      });
      activityBridge.close();
    },
  );

  it("defers a missing or contradictory exact turn and retries the observation later", async () => {
    const observedAt = new Date("2026-08-03T00:00:00.000Z");
    const activityBridge = new ExecutionActivityBridge({
      store,
      now: () => observedAt,
    });
    await activityBridge.initialize(observedAt);
    const silentRecovery = new RecoveryManager(store, workflow, notifications, {
      activityBridge,
    });
    const execution = (await store.findTask(taskId))!.task.currentExecution!;
    notifications.turnSnapshot = {
      threadStatus: "active",
      activeTurnIds: ["turn-new"],
      turn: null,
    };

    await silentRecovery.recoverSilentTaskExecutions(
      new Date("2026-08-03T00:10:00.000Z"),
    );
    expect(taskDispatcher.resumed).toEqual([]);
    expect(await store.listTaskActivities((await store.findTask(taskId))!.project.id, taskId))
      .toEqual([]);

    notifications.turnSnapshot = coherentSnapshot(execution.turnId!, "failed");
    await silentRecovery.recoverSilentTaskExecutions(
      new Date("2026-08-03T00:10:59.999Z"),
    );
    expect(notifications.snapshotReads).toHaveLength(1);
    await silentRecovery.recoverSilentTaskExecutions(
      new Date("2026-08-03T00:11:00.000Z"),
    );
    expect(notifications.snapshotReads).toHaveLength(2);
    expect(taskDispatcher.resumed).toHaveLength(1);
    activityBridge.close();
  });

  it("does not resume a silent interrupted turn while its project is paused", async () => {
    const observedAt = new Date("2026-08-03T00:00:00.000Z");
    const activityBridge = new ExecutionActivityBridge({
      store,
      now: () => observedAt,
    });
    await activityBridge.initialize(observedAt);
    const silentRecovery = new RecoveryManager(store, workflow, notifications, {
      activityBridge,
    });
    const found = (await store.findTask(taskId))!;
    await store.saveProject({ ...found.project, scheduling: "paused" });
    notifications.turnSnapshot = coherentSnapshot(
      found.task.currentExecution!.turnId!,
      "interrupted",
    );

    await silentRecovery.recoverSilentTaskExecutions(
      new Date("2026-08-03T00:10:00.000Z"),
    );

    expect(taskDispatcher.resumed).toEqual([]);
    expect((await store.findTask(taskId))!.task.currentExecution).toMatchObject({
      attemptId: found.task.currentExecution!.attemptId,
      turnId: found.task.currentExecution!.turnId,
      status: "running",
    });
    activityBridge.close();
  });

  it("keeps a silent turn stopped when its project no longer has recovery capacity", async () => {
    const observedAt = new Date("2026-08-03T00:00:00.000Z");
    const found = (await store.findTask(taskId))!;
    const [second] = await store.addTasks(found.project.id, [
      { title: "Second", description: "Second", acceptanceCriteria: [] },
    ]);
    await store.saveTask(found.project.id, {
      ...second!,
      status: "developing",
      requestedAction: "develop",
      currentExecution: {
        ...found.task.currentExecution!,
        attemptId: "attempt-second",
        threadId: "thread-second",
        turnId: "turn-second",
      },
    });
    const activityBridge = new ExecutionActivityBridge({
      store,
      now: () => observedAt,
    });
    await activityBridge.initialize(observedAt);
    const silentRecovery = new RecoveryManager(store, workflow, notifications, {
      activityBridge,
    });
    notifications.turnSnapshot = coherentSnapshot(
      found.task.currentExecution!.turnId!,
      "interrupted",
    );
    const suppressed: string[] = [];
    store.subscribe((event) => {
      if (event.type === "recovery.execution_suppressed" && event.reason) {
        suppressed.push(event.reason);
      }
    });

    await silentRecovery.recoverSilentTaskExecutions(
      new Date("2026-08-03T00:10:00.000Z"),
    );

    expect(taskDispatcher.resumed).toEqual([]);
    expect(suppressed).toContain("project_capacity_unavailable");
    activityBridge.close();
  });

  it("requires the repository integration lease before resuming a silent integrate turn", async () => {
    const observedAt = new Date("2026-08-03T00:00:00.000Z");
    const found = (await store.findTask(taskId))!;
    const integrationExecution = {
      ...found.task.currentExecution!,
      action: "integrate" as const,
    };
    await store.saveTask(found.project.id, {
      ...found.task,
      status: "integrating",
      requestedAction: "integrate",
      currentExecution: integrationExecution,
    });
    const competing = await store.createProject({
      name: "Competing integration",
      repositoryPath: found.project.repositoryPath,
      defaultBranch: "main",
      productDocument: "# Competing\n",
      tasks: [{ title: "Integrate", description: "Integrate", acceptanceCriteria: [] }],
    });
    await store.saveTask(competing.project.id, {
      ...competing.tasks[0]!,
      status: "integrating",
      requestedAction: "integrate",
      currentExecution: {
        ...integrationExecution,
        attemptId: "attempt-competing",
        threadId: "thread-competing",
        turnId: "turn-competing",
      },
    });
    const activityBridge = new ExecutionActivityBridge({
      store,
      now: () => observedAt,
    });
    await activityBridge.initialize(observedAt);
    const silentRecovery = new RecoveryManager(store, workflow, notifications, {
      activityBridge,
    });
    notifications.turnSnapshot = coherentSnapshot(
      integrationExecution.turnId!,
      "interrupted",
    );
    const suppressed: string[] = [];
    store.subscribe((event) => {
      if (event.type === "recovery.execution_suppressed" && event.reason) {
        suppressed.push(event.reason);
      }
    });

    await silentRecovery.recoverSilentTaskExecutions(
      new Date("2026-08-03T00:10:00.000Z"),
    );

    expect(taskDispatcher.resumed).toEqual([]);
    expect(suppressed).toContain("repository_integration_unavailable");
    activityBridge.close();
  });

  it("allows only one competing silence scan to resume the exact failed turn", async () => {
    const observedAt = new Date("2026-08-03T00:00:00.000Z");
    const activityBridge = new ExecutionActivityBridge({
      store,
      now: () => observedAt,
    });
    await activityBridge.initialize(observedAt);
    const silentRecovery = new RecoveryManager(store, workflow, notifications, {
      activityBridge,
    });
    const execution = (await store.findTask(taskId))!.task.currentExecution!;
    notifications.turnSnapshot = coherentSnapshot(execution.turnId!, "failed");
    const scanAt = new Date("2026-08-03T00:10:00.000Z");

    await Promise.all([
      silentRecovery.recoverSilentTaskExecutions(scanAt),
      silentRecovery.recoverSilentTaskExecutions(scanAt),
    ]);

    expect(notifications.snapshotReads).toHaveLength(1);
    expect(taskDispatcher.resumed).toHaveLength(1);
    expect(await store.listTaskActivities((await store.findTask(taskId))!.project.id, taskId))
      .toEqual([
        expect.objectContaining({
          type: "execution_recovered",
          attemptId: execution.attemptId,
          threadId: execution.threadId,
        }),
      ]);
    activityBridge.close();
  });

  it("suppresses recovery when the persisted execution changes after the snapshot read", async () => {
    const observedAt = new Date("2026-08-03T00:00:00.000Z");
    const activityBridge = new ExecutionActivityBridge({
      store,
      now: () => observedAt,
    });
    await activityBridge.initialize(observedAt);
    const silentRecovery = new RecoveryManager(store, workflow, notifications, {
      activityBridge,
    });
    const found = (await store.findTask(taskId))!;
    const execution = found.task.currentExecution!;
    notifications.turnSnapshot = coherentSnapshot(execution.turnId!, "interrupted");
    notifications.beforeSnapshotReturn = async () => {
      notifications.beforeSnapshotReturn = undefined;
      await store.saveTask(found.project.id, {
        ...found.task,
        currentExecution: {
          ...execution,
          turnId: "turn-new",
          turnStartedAt: "2026-08-03T00:09:59.000Z",
        },
      });
    };

    await silentRecovery.recoverSilentTaskExecutions(
      new Date("2026-08-03T00:10:00.000Z"),
    );

    expect(taskDispatcher.resumed).toEqual([]);
    expect((await store.findTask(taskId))!.task.currentExecution).toMatchObject({
      attemptId: execution.attemptId,
      turnId: "turn-new",
      status: "running",
    });
    activityBridge.close();
  });

  it("keeps the original turn identity when the conversation becomes active before recovery dispatch", async () => {
    const observedAt = new Date("2026-08-03T00:00:00.000Z");
    const activityBridge = new ExecutionActivityBridge({
      store,
      now: () => observedAt,
    });
    await activityBridge.initialize(observedAt);
    const silentRecovery = new RecoveryManager(store, workflow, notifications, {
      activityBridge,
    });
    const execution = (await store.findTask(taskId))!.task.currentExecution!;
    notifications.turnSnapshot = coherentSnapshot(execution.turnId!, "interrupted");
    taskDispatcher.conversationActive = true;

    await silentRecovery.recoverSilentTaskExecutions(
      new Date("2026-08-03T00:10:00.000Z"),
    );

    expect((await store.findTask(taskId))!.task.currentExecution).toMatchObject({
      attemptId: execution.attemptId,
      status: execution.status,
      threadId: execution.threadId,
      turnId: execution.turnId,
    });
    expect(await store.listTaskActivities((await store.findTask(taskId))!.project.id, taskId))
      .toEqual([]);
    activityBridge.close();
  });

  it("does not let the legacy lease scan bypass an uncertain exact-turn snapshot", async () => {
    const observedAt = new Date("2026-08-03T00:00:00.000Z");
    const activityBridge = new ExecutionActivityBridge({
      store,
      now: () => observedAt,
    });
    await activityBridge.initialize(observedAt);
    const silentRecovery = new RecoveryManager(store, workflow, notifications, {
      activityBridge,
    });
    notifications.turnStatus = "interrupted";
    notifications.turnSnapshot = {
      threadStatus: "active",
      activeTurnIds: ["turn-unknown"],
      turn: null,
    };
    const execution = (await store.findTask(taskId))!.task.currentExecution!;

    await silentRecovery.recoverUnattendedWork(
      new Date("2026-08-03T07:00:00.000Z"),
    );

    expect(taskDispatcher.resumed).toEqual([]);
    expect((await store.findTask(taskId))!.task.currentExecution).toMatchObject({
      attemptId: execution.attemptId,
      turnId: execution.turnId,
      status: execution.status,
    });
    activityBridge.close();
  });

  it("does not resume an in-flight silence check after the service stops", async () => {
    const observedAt = new Date("2026-08-03T00:00:00.000Z");
    const activityBridge = new ExecutionActivityBridge({
      store,
      now: () => observedAt,
    });
    await activityBridge.initialize(observedAt);
    const silentRecovery = new RecoveryManager(store, workflow, notifications, {
      activityBridge,
    });
    const execution = (await store.findTask(taskId))!.task.currentExecution!;
    notifications.turnSnapshot = coherentSnapshot(execution.turnId!, "interrupted");
    let releaseSnapshot!: () => void;
    let markSnapshotStarted!: () => void;
    const snapshotStarted = new Promise<void>((resolve) => {
      markSnapshotStarted = resolve;
    });
    notifications.beforeSnapshotReturn = async () => {
      markSnapshotStarted();
      await new Promise<void>((resolve) => {
        releaseSnapshot = resolve;
      });
    };

    const recoveryCheck = silentRecovery.recoverSilentTaskExecutions(
      new Date("2026-08-03T00:10:00.000Z"),
    );
    await snapshotStarted;
    silentRecovery.stop();
    releaseSnapshot();
    await recoveryCheck;

    expect(taskDispatcher.resumed).toEqual([]);
    expect((await store.findTask(taskId))!.task.currentExecution).toMatchObject({
      attemptId: execution.attemptId,
      turnId: execution.turnId,
      status: execution.status,
    });
    activityBridge.close();
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
      timedRecovery.stop();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(periodicCheck).toHaveBeenCalledTimes(1);
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
      reportOpportunityId: requiredReportOpportunity(started.currentExecution!),
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
      currentExecution: { action: "review", status: "running" },
    });
    expect(await store.listTaskActivities((await store.findTask(taskId))!.project.id, taskId))
      .toEqual([
        expect.objectContaining({
          type: "development_completed",
          evidence: { workspacePath: "/workspace/game/.worktrees/loop", candidateCommit: "abc123" },
        }),
      ]);
  });

  it("leaves an idle project without a temporary project execution", async () => {
    const idleStore = new ProjectStore(
      await mkdtemp(join(tmpdir(), "codrive-idle-recovery-")),
    );
    const created = await idleStore.createProject({
      name: "Game",
      repositoryPath: "/workspace/game",
      defaultBranch: "main",
      productDocument: "# Game\n",
      tasks: [{ title: "Loop", description: "Build loop", acceptanceCriteria: [] }],
    });
    await idleStore.saveTask(created.project.id, {
      ...created.tasks[0]!,
      status: "done",
    });
    await idleStore.appendEvent({
      eventId: "activity_event_integrated",
      type: "task.activity_recorded",
      projectId: created.project.id,
      taskId: created.tasks[0]!.id,
      occurredAt: "2026-08-03T00:00:00.000Z",
      data: {
        activity: {
          id: "activity_integrated",
          projectId: created.project.id,
          taskId: created.tasks[0]!.id,
          type: "integration_completed",
          action: "integrate",
          outcome: "completed",
          attemptId: "integrate_1",
          summary: "Merged",
          occurredAt: "2026-08-03T00:00:00.000Z",
          evidence: { mergedCommit: "merged_1" },
        },
      },
    });
    const projectExecutor = new RecordingProjectExecutor();
    const idleWorkflow = new WorkflowEngine(
      idleStore,
      new RecordingTaskDispatcher(),
      { maxConcurrentTasks: 4, models: testModels },
      projectExecutor,
    );
    await idleWorkflow.reconcile();

    expect((await idleStore.getProject(created.project.id))?.project).toMatchObject({
      status: "idle",
      requestedAction: null,
    });
    expect(projectExecutor.started).toHaveLength(0);
  });
});

function coherentSnapshot(
  turnId: string,
  status: CodexTurnStatus,
): CodexTurnSnapshot {
  return {
    threadStatus: status === "inProgress" ? "active" : "idle",
    activeTurnIds: status === "inProgress" ? [turnId] : [],
    turn: { id: turnId, status, items: [] },
  };
}
