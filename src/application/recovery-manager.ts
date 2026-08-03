import type { WorkflowEngine } from "./workflow-engine.js";
import type { CodexTurnStatus } from "./codex-gateway.js";
import type { ProjectStore } from "../infrastructure/project-store.js";
import type { JsonRpcNotification } from "../infrastructure/json-rpc-connection.js";

export interface NotificationSource {
  onNotification(listener: (notification: JsonRpcNotification) => void): () => void;
  readTurnStatus(
    threadId: string,
    turnId: string,
  ): Promise<CodexTurnStatus | null>;
}

export class RecoveryManager {
  private unsubscribe: (() => void) | null = null;
  private leaseTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly store: ProjectStore,
    private readonly workflow: WorkflowEngine,
    private readonly notifications: NotificationSource,
  ) {}

  async start(): Promise<void> {
    this.unsubscribe = this.notifications.onNotification((notification) => {
      void this.handleNotification(notification);
    });
    await this.recoverInterruptedExecutions();
    await this.workflow.reconcile();
    this.leaseTimer = setInterval(() => {
      void this.recoverExpiredExecutions();
    }, 60_000);
    this.leaseTimer.unref();
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.leaseTimer) clearInterval(this.leaseTimer);
    this.leaseTimer = null;
  }

  async handleNotification(notification: JsonRpcNotification): Promise<void> {
    if (notification.method === "transport/disconnected") {
      await this.recoverInterruptedExecutions();
      return;
    }
    if (notification.method !== "turn/completed") {
      return;
    }
    const params = notification.params as {
      turn?: { id?: string; status?: string; error?: { message?: string } | null };
    };
    const turnId = params.turn?.id;
    if (!turnId) {
      return;
    }
    const found = await this.store.findTaskByTurnId(turnId);
    const taskExecution = found?.task.currentExecution;
    if (found && taskExecution) {
      if (params.turn?.status === "completed") {
        await this.workflow.completeTurn(
          found.task.id,
          taskExecution.attemptId,
          turnId,
        );
        return;
      }
      await this.workflow.failTurn(
        found.task.id,
        taskExecution.attemptId,
        params.turn?.error?.message ?? `Turn ${params.turn?.status ?? "failed"}`,
      );
      return;
    }

    const project = await this.store.findProjectByTurnId(turnId);
    const projectExecution = project?.currentExecution;
    if (!project || !projectExecution) return;
    if (params.turn?.status === "completed") {
      await this.workflow.completeProjectTurn(
        project.id,
        projectExecution.attemptId,
        turnId,
      );
      return;
    }
    await this.workflow.failProjectTurn(
      project.id,
      projectExecution.attemptId,
      params.turn?.error?.message ?? `Turn ${params.turn?.status ?? "failed"}`,
    );
  }

  async recoverInterruptedExecutions(): Promise<void> {
    const activeStatuses = new Set(["pending", "running", "awaiting_report"]);
    for (const snapshot of await this.store.listProjects()) {
      if (snapshot.project.status === "cancelled") continue;
      const projectExecution = snapshot.project.currentExecution;
      if (projectExecution && activeStatuses.has(projectExecution.status)) {
        if (projectExecution.threadId && projectExecution.turnId) {
          let turnStatus: CodexTurnStatus | null = null;
          try {
            turnStatus = await this.notifications.readTurnStatus(
              projectExecution.threadId,
              projectExecution.turnId,
            );
          } catch {
            turnStatus = null;
          }
          if (turnStatus === "completed") {
            await this.workflow.completeProjectTurn(
              snapshot.project.id,
              projectExecution.attemptId,
              projectExecution.turnId,
            );
          } else {
            await this.workflow.recoverProjectExecution(snapshot.project.id);
          }
        } else {
          await this.workflow.recoverProjectExecution(snapshot.project.id);
        }
      }
      for (const task of snapshot.tasks) {
        if (
          task.currentExecution &&
          activeStatuses.has(task.currentExecution.status) &&
          task.requestedAction
        ) {
          const { threadId, turnId, attemptId } = task.currentExecution;
          if (threadId && turnId) {
            let turnStatus: CodexTurnStatus | null = null;
            try {
              turnStatus = await this.notifications.readTurnStatus(threadId, turnId);
            } catch {
              turnStatus = null;
            }
            if (turnStatus === "completed") {
              await this.workflow.completeTurn(task.id, attemptId, turnId);
              continue;
            }
          }
          await this.workflow.recoverTask(task.id);
        }
      }
    }
  }

  async recoverExpiredExecutions(now = new Date()): Promise<void> {
    const activeStatuses = new Set(["pending", "running", "awaiting_report"]);
    for (const snapshot of await this.store.listProjects()) {
      const projectExecution = snapshot.project.currentExecution;
      if (
        projectExecution &&
        activeStatuses.has(projectExecution.status) &&
        isExpired(projectExecution.leaseExpiresAt, now)
      ) {
        const status = await this.readStatus(
          projectExecution.threadId,
          projectExecution.turnId,
        );
        if (status === "completed" && projectExecution.turnId) {
          await this.workflow.completeProjectTurn(
            snapshot.project.id,
            projectExecution.attemptId,
            projectExecution.turnId,
          );
        } else if (status === "inProgress") {
          await this.workflow.renewProjectLease(
            snapshot.project.id,
            projectExecution.attemptId,
          );
        } else {
          await this.workflow.recoverProjectExecution(snapshot.project.id);
        }
      }

      if (snapshot.project.status === "cancelled") continue;
      for (const task of snapshot.tasks) {
        const execution = task.currentExecution;
        if (
          !execution ||
          !activeStatuses.has(execution.status) ||
          !isExpired(execution.leaseExpiresAt, now)
        ) {
          continue;
        }
        const status = await this.readStatus(execution.threadId, execution.turnId);
        if (status === "completed" && execution.turnId) {
          await this.workflow.completeTurn(
            task.id,
            execution.attemptId,
            execution.turnId,
          );
        } else if (status === "inProgress") {
          await this.workflow.renewTaskLease(task.id, execution.attemptId);
        } else {
          await this.workflow.recoverTask(task.id);
        }
      }
    }
  }

  private async readStatus(
    threadId?: string,
    turnId?: string,
  ): Promise<CodexTurnStatus | null> {
    if (!threadId || !turnId) return null;
    try {
      return await this.notifications.readTurnStatus(threadId, turnId);
    } catch {
      return null;
    }
  }
}

function isExpired(expiresAt: string | undefined, now: Date): boolean {
  return expiresAt !== undefined && Date.parse(expiresAt) <= now.getTime();
}
