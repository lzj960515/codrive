import type { WorkflowEngine } from "./workflow-engine.js";
import type {
  CodexTurnSnapshot,
  CodexTurnStatus,
} from "./codex-gateway.js";
import type {
  ExecutionActivityBridge,
  ExecutionSilenceClaim,
} from "./execution-activity-bridge.js";
import type {
  ProjectExecution,
  TaskExecution,
  TaskExecutionIdentity,
} from "../domain/types.js";
import { projectCanSchedule } from "../domain/project.js";
import type { ProjectStore } from "../infrastructure/project-store.js";
import type { JsonRpcNotification } from "../infrastructure/json-rpc-connection.js";

interface TurnObservation {
  status: CodexTurnStatus | null;
  error?: string;
}

interface SilentTurnInspection {
  decision: "complete" | "keep_running" | "defer" | "recover";
  result: string;
  reason?: string;
}

export interface NotificationSource {
  onNotification(listener: (notification: JsonRpcNotification) => void): () => void;
  readTurnStatus(
    threadId: string,
    turnId: string,
  ): Promise<CodexTurnStatus | null>;
  readTurnSnapshot(
    threadId: string,
    turnId: string,
  ): Promise<CodexTurnSnapshot>;
}

export interface RecoveryManagerOptions {
  activityBridge?: Pick<
    ExecutionActivityBridge,
    | "initialize"
    | "claimSilentExecutions"
    | "isSilenceClaimCurrent"
    | "finishSilenceCheck"
  >;
  now?: () => Date;
  scanIntervalMs?: number;
  silenceThresholdMs?: number;
}

const retryScheduleEventTypes = new Set([
  "turn.retry_scheduled",
  "turn.started",
  "task.activity_recorded",
  "task.scheduled_resume_requested",
  "task.scheduled_resume_rescheduled",
  "task.scheduled_resume_started",
  "task.scheduled_resume_waiting",
  "task.scheduled_resume_deferred",
  "task.cancelled",
  "project.cancelled",
  "project.paused",
  "project.resumed",
  "project.archived",
  "project.unarchived",
]);
const workflowNotificationMethods = new Set([
  "transport/disconnected",
  "thread/status/changed",
  "turn/completed",
]);
const maximumTimerDelayMs = 2_147_483_647;
const defaultScanIntervalMs = 60_000;
const defaultSilenceThresholdMs = 10 * 60_000;

export class RecoveryManager {
  private unsubscribe: (() => void) | null = null;
  private unsubscribeStore: (() => void) | null = null;
  private leaseTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private retryScheduleGeneration = 0;
  private readonly now: () => Date;
  private readonly scanIntervalMs: number;
  private readonly silenceThresholdMs: number;
  private stopped = false;

  constructor(
    private readonly store: ProjectStore,
    private readonly workflow: WorkflowEngine,
    private readonly notifications: NotificationSource,
    private readonly options: RecoveryManagerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.scanIntervalMs = options.scanIntervalMs ?? defaultScanIntervalMs;
    this.silenceThresholdMs =
      options.silenceThresholdMs ?? defaultSilenceThresholdMs;
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.unsubscribe = this.notifications.onNotification((notification) => {
      void this.handleNotification(notification);
    });
    this.unsubscribeStore = this.store.subscribe((event) => {
      if (changesRetrySchedule(event.type)) void this.scheduleRetryWakeup();
    });
    const startedAt = this.now();
    await this.options.activityBridge?.initialize(startedAt);
    await this.recoverInterruptedExecutions(
      this.options.activityBridge !== undefined,
    );
    await this.workflow.resumeScheduledTasks(startedAt, undefined, true);
    await this.workflow.lifecycle.run(
      {
        source: "recovery",
        component: "recovery",
        correlationId: this.workflow.lifecycle.id("recovery_scan"),
      },
      () => this.workflow.recoverProjectsWithoutActiveWork(),
    );
    await this.scheduleRetryWakeup();
    this.leaseTimer = setInterval(async () => {
      await this.recoverUnattendedWork(this.now());
    }, this.scanIntervalMs);
    this.leaseTimer.unref();
  }

  stop(): void {
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.unsubscribeStore?.();
    this.unsubscribeStore = null;
    if (this.leaseTimer) clearInterval(this.leaseTimer);
    this.leaseTimer = null;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.retryScheduleGeneration += 1;
  }

  async handleNotification(notification: JsonRpcNotification): Promise<void> {
    if (!workflowNotificationMethods.has(notification.method)) return;
    const correlationId = this.workflow.lifecycle.id("notification");
    await this.workflow.lifecycle.run(
      { source: "app_server", component: "app_server", correlationId },
      async () => {
        const received = await this.workflow.lifecycle.record({
          type: "app_server.notification_received",
          result: notification.method,
        });
        await this.workflow.lifecycle.run(
          {
            source: "app_server",
            component: "app_server",
            causationId: received.eventId,
          },
          async () => {
            if (notification.method === "transport/disconnected") {
              await this.options.activityBridge?.initialize(this.now());
              await this.recoverInterruptedExecutions(
                this.options.activityBridge !== undefined,
              );
              return;
            }
            if (notification.method === "thread/status/changed") {
              const params = notification.params as {
                threadId?: string;
                status?: { type?: string };
              };
              if (params.threadId && params.status?.type === "idle") {
                await this.recoverDeferredTaskTurns(params.threadId);
                await this.workflow.resumeScheduledTasks(
                  this.now(),
                  params.threadId,
                );
              }
              return;
            }
            if (notification.method !== "turn/completed") return;
            await this.handleCompletedTurn(notification);
          }
        );
      },
    );
  }

  async recoverInterruptedExecutions(
    preserveObservedTaskTurns = false,
  ): Promise<void> {
    const correlationId = this.workflow.lifecycle.id("recovery_scan");
    await this.workflow.lifecycle.run(
      { source: "recovery", component: "recovery", correlationId },
      async () => {
        await this.workflow.lifecycle.record({
          type: "recovery.scan_started",
          result: "startup_or_reconnect",
        });
        const activeStatuses = new Set(["pending", "running", "awaiting_report"]);
        for (const snapshot of await this.store.listProjects()) {
          if (!projectCanSchedule(snapshot.project)) {
            continue;
          }
          const projectExecution = snapshot.project.currentExecution;
          if (projectExecution && activeStatuses.has(projectExecution.status)) {
            await this.recoverInterruptedProject(
              snapshot.project.id,
              projectExecution,
            );
          }
          for (const task of snapshot.tasks) {
            const execution = task.currentExecution;
            if (
              !execution ||
              !activeStatuses.has(execution.status) ||
              !task.requestedAction
            ) {
              continue;
            }
            if (
              preserveObservedTaskTurns &&
              execution.threadId &&
              execution.turnId &&
              !isDeferredTaskTurn(execution)
            ) {
              continue;
            }
            await this.recoverInterruptedTask(snapshot.project.id, task.id, execution);
          }
        }
        await this.workflow.lifecycle.record({
          type: "recovery.scan_completed",
          result: "completed",
        });
      },
    );
  }

  async recoverExpiredExecutions(now = this.now()): Promise<void> {
    const correlationId = this.workflow.lifecycle.id("recovery_scan");
    await this.workflow.lifecycle.run(
      { source: "recovery", component: "recovery", correlationId },
      async () => {
        const activeStatuses = new Set(["pending", "running", "awaiting_report"]);
        for (const snapshot of await this.store.listProjects()) {
          if (!projectCanSchedule(snapshot.project)) {
            continue;
          }
          const projectExecution = snapshot.project.currentExecution;
          if (
            projectExecution &&
            activeStatuses.has(projectExecution.status) &&
            isExpired(projectExecution.leaseExpiresAt, now)
          ) {
            await this.recoverInterruptedProject(
              snapshot.project.id,
              projectExecution,
            );
          }

          for (const task of snapshot.tasks) {
            const execution = task.currentExecution;
            if (
              !execution ||
              !activeStatuses.has(execution.status) ||
              isDeferredTaskTurn(execution) ||
              (this.options.activityBridge !== undefined &&
                execution.threadId !== undefined &&
                execution.turnId !== undefined) ||
              !isExpired(execution.leaseExpiresAt, now)
            ) {
              continue;
            }
            await this.recoverInterruptedTask(
              snapshot.project.id,
              task.id,
              execution,
            );
          }
        }
      },
    );
  }

  async recoverUnattendedWork(now = this.now()): Promise<void> {
    await this.workflow.resetStableModelCapacityFailures(now);
    await this.workflow.resumeScheduledTasks(now, undefined, true);
    await this.recoverDeferredTaskTurns();
    await this.recoverSilentTaskExecutions(now);
    await this.recoverExpiredExecutions(now);
    await this.workflow.lifecycle.run(
      {
        source: "recovery",
        component: "recovery",
        correlationId: this.workflow.lifecycle.id("recovery_scan"),
      },
      () => this.workflow.recoverProjectsWithoutActiveWork(),
    );
    await this.scheduleRetryWakeup(now);
  }

  async recoverSilentTaskExecutions(now = this.now()): Promise<void> {
    if (this.stopped) return;
    const activityBridge = this.options.activityBridge;
    if (!activityBridge) return;
    const claims = activityBridge.claimSilentExecutions(
      now,
      this.silenceThresholdMs,
    );
    for (const claim of claims) {
      await this.verifySilentTaskExecution(claim, now);
    }
  }

  private async scheduleRetryWakeup(now = this.now()): Promise<void> {
    const generation = ++this.retryScheduleGeneration;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const snapshots = await this.store.listProjects();
    if (generation !== this.retryScheduleGeneration) return;
    const nextRetryAt = Math.min(
      ...snapshots.flatMap(({ project, tasks }) => {
        if (!projectCanSchedule(project)) {
          return [];
        }
        const modelRetries = [
          project.currentExecution,
          ...tasks.map((task) => task.currentExecution),
        ]
          .filter((execution) => execution?.status === "retry_scheduled")
          .map((execution) => Date.parse(execution!.modelRouting.nextRetryAt!));
        const scheduledResumes = tasks
          .filter(
            (task) =>
              task.currentExecution?.status === "waiting_for_resume" &&
              task.currentExecution.scheduledResume &&
              !task.currentExecution.scheduledResume.wakeAttemptedAt &&
              Date.parse(task.currentExecution.scheduledResume.resumeAt) >
                now.getTime(),
          )
          .map((task) =>
            Date.parse(task.currentExecution!.scheduledResume!.resumeAt),
          );
        return [...modelRetries, ...scheduledResumes];
      }),
    );
    if (!Number.isFinite(nextRetryAt)) return;

    this.retryTimer = setTimeout(async () => {
      if (generation !== this.retryScheduleGeneration) return;
      this.retryTimer = null;
      const wakeupTime = this.now();
      await this.workflow.retryScheduledExecutions(wakeupTime);
      await this.workflow.resumeScheduledTasks(wakeupTime);
      if (generation === this.retryScheduleGeneration) {
        await this.scheduleRetryWakeup();
      }
    }, Math.min(Math.max(0, nextRetryAt - now.getTime()), maximumTimerDelayMs));
    this.retryTimer.unref();
  }

  async recoverDeferredTaskTurns(threadId?: string): Promise<void> {
    const correlationId = this.workflow.lifecycle.id("recovery_scan");
    await this.workflow.lifecycle.run(
      { source: "recovery", component: "recovery", correlationId },
      async () => {
        for (const snapshot of await this.store.listProjects()) {
          if (!projectCanSchedule(snapshot.project)) {
            continue;
          }
          for (const task of snapshot.tasks) {
            const execution = task.currentExecution;
            if (
              !task.requestedAction ||
              !execution ||
              !isDeferredTaskTurn(execution) ||
              (threadId && execution.threadId !== threadId)
            ) {
              continue;
            }
            const observed = await this.recordExecutionObservation({
              projectId: snapshot.project.id,
              taskId: task.id,
              execution,
              decision: "resume_deferred",
              result: execution.status,
            });
            await this.workflow.lifecycle.run(
              {
                source: "recovery",
                component: "recovery",
                causationId: observed.eventId,
              },
              () => this.workflow.recoverTask(task.id, execution.attemptId),
            );
          }
        }
      },
    );
  }

  private async handleCompletedTurn(
    notification: JsonRpcNotification,
  ): Promise<void> {
    const params = notification.params as {
      turn?: {
        id?: string;
        status?: string;
        error?: { message?: string; codexErrorInfo?: unknown } | null;
      };
    };
    const turnId = params.turn?.id;
    if (!turnId) {
      await this.workflow.lifecycle.record({
        type: "app_server.notification_ignored",
        decision: "ignore",
        reason: "missing_turn_id",
      });
      return;
    }
    const found = await this.store.findTaskByTurnId(turnId);
    const taskExecution = found?.task.currentExecution;
    if (found && taskExecution) {
      const matched = await this.workflow.lifecycle.record({
        type: "app_server.notification_matched",
        projectId: found.project.id,
        taskId: found.task.id,
        attemptId: taskExecution.attemptId,
        ...(taskExecution.threadId ? { threadId: taskExecution.threadId } : {}),
        turnId,
        result: params.turn?.status ?? "unknown",
      });
      await this.workflow.lifecycle.run(
        {
          source: "app_server",
          component: "workflow",
          causationId: matched.eventId,
        },
        () =>
          params.turn?.status === "completed"
            ? this.workflow.completeTurn(
                found.task.id,
                taskExecution.attemptId,
                turnId,
              )
            : params.turn?.status === "interrupted"
              ? this.workflow.resumeTaskAfterInterruption(
                  taskRecoveryTarget(found.project.id, found.task.id, taskExecution),
                )
            : this.workflow.failTurn(
                found.task.id,
                taskExecution.attemptId,
                {
                  turnId,
                  message:
                    params.turn?.error?.message ??
                    `Turn ${params.turn?.status ?? "failed"}`,
                  codexErrorInfo: params.turn?.error?.codexErrorInfo,
                },
              ),
      );
      return;
    }

    const project = await this.store.findProjectByTurnId(turnId);
    const projectExecution = project?.currentExecution;
    if (project && projectExecution) {
      const matched = await this.workflow.lifecycle.record({
        type: "app_server.notification_matched",
        projectId: project.id,
        attemptId: projectExecution.attemptId,
        ...(projectExecution.threadId
          ? { threadId: projectExecution.threadId }
          : {}),
        turnId,
        result: params.turn?.status ?? "unknown",
        data: { scope: "project" },
      });
      await this.workflow.lifecycle.run(
        {
          source: "app_server",
          component: "workflow",
          causationId: matched.eventId,
        },
        () =>
          params.turn?.status === "completed"
            ? this.workflow.completeProjectTurn(
                project.id,
                projectExecution.attemptId,
                turnId,
              )
            : this.workflow.failProjectTurn(
                project.id,
                projectExecution.attemptId,
                {
                  turnId,
                  message:
                    params.turn?.error?.message ??
                    `Turn ${params.turn?.status ?? "failed"}`,
                  codexErrorInfo: params.turn?.error?.codexErrorInfo,
                },
              ),
      );
      return;
    }

    await this.workflow.lifecycle.record({
      type: "app_server.notification_ignored",
      turnId,
      decision: "ignore",
      reason: "no_current_execution",
      result: params.turn?.status ?? "unknown",
    });
  }

  private async recoverInterruptedProject(
    projectId: string,
    execution: ProjectExecution,
  ): Promise<void> {
    if (execution.status === "pending" || !execution.threadId || !execution.turnId) {
      const observed = await this.recordExecutionObservation({
        projectId,
        execution,
        decision: "resume_pending",
        result: execution.status,
      });
      await this.workflow.lifecycle.run(
        { source: "recovery", component: "recovery", causationId: observed.eventId },
        () => this.workflow.recoverProjectExecution(projectId, execution.attemptId),
      );
      return;
    }

    const observation = await this.readStatus(execution.threadId, execution.turnId);
    const decision = recoveryDecision(observation);
    const observed = await this.recordExecutionObservation({
      projectId,
      execution,
      decision,
      result: observation.status ?? (observation.error ? "read_failed" : "missing"),
      ...(observation.error ? { reason: observation.error } : {}),
    });
    await this.workflow.lifecycle.run(
      { source: "recovery", component: "recovery", causationId: observed.eventId },
      async () => {
        if (decision === "complete") {
          await this.workflow.completeProjectTurn(
            projectId,
            execution.attemptId,
            execution.turnId!,
          );
        } else if (decision === "keep_running" || decision === "defer") {
          await this.workflow.renewProjectLease(projectId, execution.attemptId);
        } else {
          await this.workflow.restartProjectAfterInterruption(
            projectId,
            execution.attemptId,
          );
        }
      },
    );
  }

  private async recoverInterruptedTask(
    projectId: string,
    taskId: string,
    execution: TaskExecution,
  ): Promise<void> {
    if (isDeferredTaskTurn(execution)) {
      const observed = await this.recordExecutionObservation({
        projectId,
        taskId,
        execution,
        decision: "resume_deferred",
        result: execution.status,
      });
      await this.workflow.lifecycle.run(
        { source: "recovery", component: "recovery", causationId: observed.eventId },
        () => this.workflow.recoverTask(taskId, execution.attemptId),
      );
      return;
    }

    const observation = await this.readStatus(execution.threadId, execution.turnId);
    const decision = recoveryDecision(observation);
    const observed = await this.recordExecutionObservation({
      projectId,
      taskId,
      execution,
      decision,
      result: observation.status ?? (observation.error ? "read_failed" : "missing"),
      ...(observation.error ? { reason: observation.error } : {}),
    });
    await this.workflow.lifecycle.run(
      { source: "recovery", component: "recovery", causationId: observed.eventId },
      async () => {
        if (decision === "complete") {
          await this.workflow.completeTurn(
            taskId,
            execution.attemptId,
            execution.turnId!,
          );
        } else if (decision === "keep_running" || decision === "defer") {
          await this.workflow.renewTaskLease(taskId, execution.attemptId);
        } else {
          await this.workflow.resumeTaskAfterInterruption(
            taskRecoveryTarget(projectId, taskId, execution),
          );
        }
      },
    );
  }

  private recordExecutionObservation({
    projectId,
    taskId,
    execution,
    decision,
    result,
    reason,
    diagnostics,
  }: {
    projectId: string;
    taskId?: string;
    execution: Pick<
      ProjectExecution | TaskExecution,
      "action" | "attemptId" | "status" | "threadId" | "turnId"
    >;
    decision: string;
    result: string;
    reason?: string;
    diagnostics?: Record<string, unknown>;
  }) {
    return this.workflow.lifecycle.record({
      type: "recovery.execution_observed",
      projectId,
      ...(taskId ? { taskId } : {}),
      attemptId: execution.attemptId,
      ...(execution.threadId ? { threadId: execution.threadId } : {}),
      ...(execution.turnId ? { turnId: execution.turnId } : {}),
      decision,
      result,
      ...(reason ? { reason } : {}),
      data: {
        action: execution.action,
        executionStatus: execution.status,
        ...diagnostics,
      },
    });
  }

  private async readStatus(
    threadId?: string,
    turnId?: string,
  ): Promise<TurnObservation> {
    if (!threadId || !turnId) return { status: null };
    try {
      return {
        status: await this.notifications.readTurnStatus(threadId, turnId),
      };
    } catch (error) {
      return {
        status: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async verifySilentTaskExecution(
    claim: ExecutionSilenceClaim,
    observedAt: Date,
  ): Promise<void> {
    const activityBridge = this.options.activityBridge!;
    const { snapshot, readError } = await this.readSilentTurn(claim);
    const observation = inspectSilentTurn(snapshot, claim.turnId, readError);
    try {
      if (this.stopped) return;
      const recorded = await this.recordSilentTurnObservation(
        claim,
        observation,
        snapshot,
      );
      await this.workflow.lifecycle.run(
        { source: "recovery", component: "recovery", causationId: recorded.eventId },
        () => this.applySilentTurnDecision(claim, observation),
      );
    } finally {
      activityBridge.finishSilenceCheck(
        claim,
        observation.decision === "keep_running"
          ? { observedAt }
          : { retryAt: new Date(observedAt.getTime() + this.scanIntervalMs) },
      );
    }
  }

  private async readSilentTurn(
    claim: ExecutionSilenceClaim,
  ): Promise<{ snapshot: CodexTurnSnapshot | null; readError?: string }> {
    try {
      return {
        snapshot: await this.notifications.readTurnSnapshot(
          claim.threadId,
          claim.turnId,
        ),
      };
    } catch (error) {
      return {
        snapshot: null,
        readError: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private recordSilentTurnObservation(
    claim: ExecutionSilenceClaim,
    observation: SilentTurnInspection,
    snapshot: CodexTurnSnapshot | null,
  ) {
    return this.recordExecutionObservation({
      projectId: claim.projectId,
      taskId: claim.taskId,
      execution: {
        action: claim.action,
        attemptId: claim.attemptId,
        status: claim.executionStatus,
        threadId: claim.threadId,
        turnId: claim.turnId,
      },
      decision: observation.decision,
      result: observation.result,
      ...(observation.reason ? { reason: observation.reason } : {}),
      ...(snapshot
        ? {
            diagnostics: {
              threadStatus: snapshot.threadStatus,
              activeTurnIds: snapshot.activeTurnIds,
              turnStatus: snapshot.turn?.status ?? null,
              itemStates: snapshot.turn?.items ?? [],
            },
          }
        : {}),
    });
  }

  private async applySilentTurnDecision(
    claim: ExecutionSilenceClaim,
    observation: SilentTurnInspection,
  ): Promise<void> {
    if (
      this.stopped ||
      !this.options.activityBridge!.isSilenceClaimCurrent(claim)
    ) {
      return;
    }
    if (observation.decision === "complete") {
      await this.workflow.completeTurn(
        claim.taskId,
        claim.attemptId,
        claim.turnId,
      );
    } else if (observation.decision === "recover") {
      await this.workflow.resumeTaskAfterInterruption(claim);
    }
  }
}

function isExpired(expiresAt: string | undefined, now: Date): boolean {
  return expiresAt !== undefined && Date.parse(expiresAt) <= now.getTime();
}

function isDeferredTaskTurn(execution: TaskExecution): boolean {
  return (
    execution.status === "pending" ||
    (execution.status === "awaiting_report" &&
      (execution.turnCompletedAt !== undefined || execution.turnId === undefined))
  );
}

function recoveryDecision(
  observation: TurnObservation,
): "complete" | "keep_running" | "defer" | "recover" {
  if (observation.status === "completed") return "complete";
  if (observation.status === "inProgress") return "keep_running";
  if (observation.error || observation.status === null) return "defer";
  return "recover";
}

function inspectSilentTurn(
  snapshot: CodexTurnSnapshot | null,
  turnId: string,
  readError?: string,
): SilentTurnInspection {
  if (readError) {
    return { decision: "defer", result: "read_failed", reason: readError };
  }
  if (!snapshot?.turn) {
    return { decision: "defer", result: "missing", reason: "exact_turn_missing" };
  }
  const turn = snapshot.turn;
  const coherentRunning =
    turn.id === turnId &&
    turn.status === "inProgress" &&
    snapshot.threadStatus === "active" &&
    snapshot.activeTurnIds.length === 1 &&
    snapshot.activeTurnIds[0] === turnId;
  if (turn.status === "inProgress") {
    return coherentRunning
      ? { decision: "keep_running", result: "inProgress" }
      : {
          decision: "defer",
          result: "inconsistent",
          reason: "thread_turn_state_conflict",
        };
  }
  const hasCoherentTerminalState =
    turn.id === turnId &&
    (snapshot.threadStatus === "idle" ||
      snapshot.threadStatus === "notLoaded") &&
    snapshot.activeTurnIds.length === 0;
  if (!hasCoherentTerminalState) {
    return {
      decision: "defer",
      result: "inconsistent",
      reason: "thread_turn_state_conflict",
    };
  }
  return turn.status === "completed"
    ? { decision: "complete", result: turn.status }
    : { decision: "recover", result: turn.status };
}

function taskRecoveryTarget(
  projectId: string,
  taskId: string,
  execution: TaskExecution,
): TaskExecutionIdentity {
  return {
    projectId,
    taskId,
    action: execution.action,
    attemptId: execution.attemptId,
    executionStatus: execution.status,
    threadId: execution.threadId!,
    turnId: execution.turnId!,
  };
}

function changesRetrySchedule(type: string): boolean {
  return retryScheduleEventTypes.has(type);
}
