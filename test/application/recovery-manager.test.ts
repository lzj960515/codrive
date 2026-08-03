import { EventEmitter } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

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
} from "../support/recording-executors.js";

class StubNotifications implements NotificationSource {
  private readonly events = new EventEmitter();
  turnStatus: CodexTurnStatus | null = null;

  onNotification(listener: (notification: JsonRpcNotification) => void): () => void {
    this.events.on("notification", listener);
    return () => this.events.off("notification", listener);
  }

  async readTurnStatus(): Promise<CodexTurnStatus | null> {
    return this.turnStatus;
  }
}

describe("RecoveryManager", () => {
  let store: ProjectStore;
  let workflow: WorkflowEngine;
  let recovery: RecoveryManager;
  let notifications: StubNotifications;
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
    workflow = new WorkflowEngine(store, new RecordingTaskDispatcher(), {
      maxConcurrentTasks: 1,
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

  it("starts a new attempt when a running turn is absent after restart", async () => {
    const before = (await store.findTask(taskId))!.task.currentExecution!;

    await recovery.recoverInterruptedExecutions();

    const after = (await store.findTask(taskId))!.task.currentExecution!;
    expect(after.status).toBe("running");
    expect(after.attemptId).not.toBe(before.attemptId);
  });

  it("renews an expired lease while the App Server turn is active", async () => {
    notifications.turnStatus = "inProgress";
    const before = (await store.findTask(taskId))!.task.currentExecution!;

    await recovery.recoverExpiredExecutions(new Date("2026-08-03T07:00:00.000Z"));

    const after = (await store.findTask(taskId))!.task.currentExecution!;
    expect(after.attemptId).toBe(before.attemptId);
    expect(after.leaseExpiresAt).toBeDefined();
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
      { maxConcurrentTasks: 4 },
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
