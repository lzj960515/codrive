import type { WorkflowEngine } from "./workflow-engine.js";
import type { CodexTurnStatus } from "./codex-gateway.js";
import type { ProjectExecution, TaskExecution } from "../domain/types.js";
import type { ProjectStore } from "../infrastructure/project-store.js";
import type { JsonRpcNotification } from "../infrastructure/json-rpc-connection.js";

interface TurnObservation {
  status: CodexTurnStatus | null;
  error?: string;
}

export interface NotificationSource {
  onNotification(listener: (notification: JsonRpcNotification) => void): () => void;
  readTurnStatus(
    threadId: string,
    turnId: string,
  ): Promise<CodexTurnStatus | null>;
}

const retryScheduleEventTypes = new Set([
  "turn.retry_scheduled",
  "turn.started",
  "task.cancelled",
  "project.cancelled",
  "project.paused",
  "project.resumed",
]);
const workflowNotificationMethods = new Set([
  "transport/disconnected",
  "thread/status/changed",
  "turn/completed",
]);

export class RecoveryManager {
  private unsubscribe: (() => void) | null = null;
  private unsubscribeStore: (() => void) | null = null;
  private leaseTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private retryScheduleGeneration = 0;

  constructor(
    private readonly store: ProjectStore,
    private readonly workflow: WorkflowEngine,
    private readonly notifications: NotificationSource,
  ) {}

  async start(): Promise<void> {
    this.unsubscribe = this.notifications.onNotification((notification) => {
      void this.handleNotification(notification);
    });
    this.unsubscribeStore = this.store.subscribe((event) => {
      if (changesRetrySchedule(event.type)) void this.scheduleRetryWakeup();
    });
    await this.recoverInterruptedExecutions();
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
      await this.recoverUnattendedWork();
    }, 60_000);
    this.leaseTimer.unref();
  }

  stop(): void {
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
              await this.recoverInterruptedExecutions();
              return;
            }
            if (notification.method === "thread/status/changed") {
              const params = notification.params as {
                threadId?: string;
                status?: { type?: string };
              };
              if (params.threadId && params.status?.type === "idle") {
                await this.recoverDeferredTaskTurns(params.threadId);
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

  async recoverInterruptedExecutions(): Promise<void> {
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
          if (snapshot.project.status === "cancelled") continue;
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

  async recoverExpiredExecutions(now = new Date()): Promise<void> {
    const correlationId = this.workflow.lifecycle.id("recovery_scan");
    await this.workflow.lifecycle.run(
      { source: "recovery", component: "recovery", correlationId },
      async () => {
        const activeStatuses = new Set(["pending", "running", "awaiting_report"]);
        for (const snapshot of await this.store.listProjects()) {
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

          if (snapshot.project.status === "cancelled") continue;
          for (const task of snapshot.tasks) {
            const execution = task.currentExecution;
            if (
              !execution ||
              !activeStatuses.has(execution.status) ||
              isDeferredTaskTurn(execution) ||
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

  async recoverUnattendedWork(now = new Date()): Promise<void> {
    await this.recoverDeferredTaskTurns();
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

  private async scheduleRetryWakeup(now = new Date()): Promise<void> {
    const generation = ++this.retryScheduleGeneration;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const snapshots = await this.store.listProjects();
    if (generation !== this.retryScheduleGeneration) return;
    const nextRetryAt = Math.min(
      ...snapshots.flatMap(({ project, tasks }) => {
        if (project.scheduling !== "running" || project.status === "cancelled") {
          return [];
        }
        return [project.currentExecution, ...tasks.map((task) => task.currentExecution)]
          .filter((execution) => execution?.status === "retry_scheduled")
          .map((execution) => Date.parse(execution!.modelRouting.nextRetryAt!));
      }),
    );
    if (!Number.isFinite(nextRetryAt)) return;

    this.retryTimer = setTimeout(async () => {
      if (generation !== this.retryScheduleGeneration) return;
      this.retryTimer = null;
      await this.workflow.retryScheduledExecutions(new Date());
      if (generation === this.retryScheduleGeneration) {
        await this.scheduleRetryWakeup();
      }
    }, Math.max(0, nextRetryAt - now.getTime()));
    this.retryTimer.unref();
  }

  async recoverDeferredTaskTurns(threadId?: string): Promise<void> {
    const correlationId = this.workflow.lifecycle.id("recovery_scan");
    await this.workflow.lifecycle.run(
      { source: "recovery", component: "recovery", correlationId },
      async () => {
        for (const snapshot of await this.store.listProjects()) {
          if (snapshot.project.status === "cancelled") continue;
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
          await this.workflow.restartTaskAfterInterruption(
            taskId,
            execution.attemptId,
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
  }: {
    projectId: string;
    taskId?: string;
    execution: ProjectExecution | TaskExecution;
    decision: string;
    result: string;
    reason?: string;
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
      data: { action: execution.action, executionStatus: execution.status },
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
}

function isExpired(expiresAt: string | undefined, now: Date): boolean {
  return expiresAt !== undefined && Date.parse(expiresAt) <= now.getTime();
}

function isDeferredTaskTurn(execution: TaskExecution): boolean {
  return (
    execution.status === "pending" ||
    (execution.status === "awaiting_report" &&
      execution.turnCompletedAt !== undefined)
  );
}

function recoveryDecision(
  observation: TurnObservation,
): "complete" | "keep_running" | "defer" | "restart" {
  if (observation.status === "completed") return "complete";
  if (observation.status === "inProgress") return "keep_running";
  if (observation.error) return "defer";
  return "restart";
}

function changesRetrySchedule(type: string): boolean {
  return retryScheduleEventTypes.has(type);
}
