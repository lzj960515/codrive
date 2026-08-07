import { isDeepStrictEqual } from "node:util";

import { WorkflowConflictError } from "../domain/errors.js";
import type {
  CodriveEvent,
  Project,
  ProjectAction,
  ProjectReport,
  Task,
} from "../domain/types.js";
import type { ProjectStore } from "../infrastructure/project-store.js";
import { projectLifecycleState } from "./lifecycle-recorder.js";
import type { ProjectExecutor } from "./project-executor.js";

const activeStatuses = new Set(["pending", "running", "awaiting_report"]);

export interface ProjectExecutionCoordinatorOptions {
  now: () => string;
  createId: (prefix: string) => string;
  leaseExpiration: () => string;
  recordEvent: (
    event: Omit<CodriveEvent, "eventId" | "occurredAt">,
  ) => Promise<void>;
}

export class ProjectExecutionCoordinator {
  constructor(
    private readonly store: ProjectStore,
    private readonly executor: ProjectExecutor,
    private readonly options: ProjectExecutionCoordinatorOptions,
  ) {}

  async start(
    project: Project,
    tasks: Task[],
    action: ProjectAction,
    previous: Project = project,
  ): Promise<Project> {
    if (
      project.currentExecution &&
      activeStatuses.has(project.currentExecution.status)
    ) {
      await this.options.recordEvent({
        type: "workflow.invariant_violated",
        projectId: project.id,
        attemptId: project.currentExecution.attemptId,
        decision: "suppress_dispatch",
        reason: `Project ${project.id} already has an active execution`,
        before: projectLifecycleState(previous),
      });
      throw new WorkflowConflictError(
        `Project ${project.id} already has an active execution`,
      );
    }
    const now = this.options.now();
    const pending: Project = {
      ...project,
      status: action === "select_tasks" ? "selecting_tasks" : "evaluating",
      requestedAction: action,
      currentExecution: {
        attemptId: this.options.createId("project_attempt"),
        action,
        status: "pending",
        startedAt: now,
        leaseExpiresAt: this.options.leaseExpiration(),
        ...(action === "evaluate_product"
          ? { progressFingerprint: evaluationFingerprint(tasks) }
          : {}),
      },
      updatedAt: now,
    };
    await this.store.saveProject(pending);
    await this.options.recordEvent({
      type: `project.${action}_started`,
      projectId: project.id,
      attemptId: pending.currentExecution!.attemptId,
      before: projectLifecycleState(previous),
      after: projectLifecycleState(pending),
    });
    return this.dispatch(pending);
  }

  async submitReport(
    report: ProjectReport,
    validateBeforeSave: (project: Project, report: ProjectReport) => Promise<void>,
  ): Promise<Project> {
    const project = await this.requireProject(report.projectId);
    if (project.latestReport?.attemptId === report.attemptId) {
      if (isDeepStrictEqual(project.latestReport, report)) return project;
      throw new WorkflowConflictError(
        `Report conflicts with the recorded project execution for ${project.id}`,
      );
    }

    const execution = project.currentExecution;
    if (
      !execution ||
      execution.attemptId !== report.attemptId ||
      !activeStatuses.has(execution.status)
    ) {
      throw new WorkflowConflictError(
        `Report does not match the current project execution for ${project.id}`,
      );
    }
    validateProjectReport(execution.action, report);
    await validateBeforeSave(project, report);

    const reported: Project = {
      ...project,
      latestReport: report,
      currentExecution: { ...execution, report },
      updatedAt: this.options.now(),
    };
    await this.store.saveProject(reported);
    await this.options.recordEvent({
      type: "project.reported",
      projectId: project.id,
      attemptId: execution.attemptId,
      data: { action: execution.action, outcome: report.outcome },
    });
    return reported;
  }

  async completeTurn(
    projectId: string,
    attemptId: string,
    turnId: string,
  ): Promise<Project> {
    const project = await this.requireProject(projectId);
    const execution = project.currentExecution;
    if (!execution || execution.attemptId !== attemptId) {
      await this.options.recordEvent({
        type: "workflow.event_suppressed",
        projectId,
        attemptId,
        turnId,
        decision: "ignore",
        reason: "execution_changed",
        data: { currentAttemptId: execution?.attemptId ?? null, scope: "project" },
      });
      return project;
    }
    if (execution.turnId !== turnId) {
      await this.options.recordEvent({
        type: "workflow.event_suppressed",
        projectId,
        attemptId,
        turnId,
        decision: "ignore",
        reason: "turn_changed",
        data: { currentTurnId: execution.turnId ?? null, scope: "project" },
      });
      return project;
    }

    const now = this.options.now();
    if (execution.report) {
      const completed: Project = {
        ...project,
        currentExecution: { ...execution, turnCompletedAt: now },
        updatedAt: now,
      };
      await this.store.saveProject(completed);
      await this.options.recordEvent({
        type: "turn.completed",
        projectId,
        attemptId,
        ...(execution.threadId ? { threadId: execution.threadId } : {}),
        turnId,
        before: projectLifecycleState(project),
        after: projectLifecycleState(completed),
        data: { scope: "project" },
      });
      return completed;
    }

    const reportReminderCount = (execution.reportReminderCount ?? 0) + 1;
    if (reportReminderCount >= 3) {
      return this.fail(project, "missing_report", reportReminderCount);
    }

    const awaitingReport: Project = {
      ...project,
      currentExecution: {
        ...execution,
        status: "awaiting_report",
        reportReminderCount,
        turnCompletedAt: now,
      },
      updatedAt: now,
    };
    await this.store.saveProject(awaitingReport);
    await this.options.recordEvent({
      type: "turn.completed",
      projectId,
      attemptId,
      ...(execution.threadId ? { threadId: execution.threadId } : {}),
      turnId,
      before: projectLifecycleState(project),
      after: projectLifecycleState(awaitingReport),
      data: { scope: "project" },
    });
    const reminderTurnId = await this.executor.requestReport(
      awaitingReport,
      execution.threadId!,
    );
    const reminded: Project = {
      ...awaitingReport,
      currentExecution: {
        ...awaitingReport.currentExecution!,
        turnId: reminderTurnId,
        leaseExpiresAt: this.options.leaseExpiration(),
      },
    };
    delete reminded.currentExecution?.turnCompletedAt;
    await this.store.saveProject(reminded);
    await this.options.recordEvent({
      type: "turn.started",
      projectId,
      attemptId,
      ...(execution.threadId ? { threadId: execution.threadId } : {}),
      turnId: reminderTurnId,
      before: projectLifecycleState(awaitingReport),
      after: projectLifecycleState(reminded),
      data: {
        scope: "project",
      },
    });
    return reminded;
  }

  async resume(project: Project, expectedAttemptId: string): Promise<Project> {
    const execution = project.currentExecution;
    if (!execution || execution.attemptId !== expectedAttemptId) {
      await this.recordRecoverySuppressed(
        project,
        expectedAttemptId,
        "execution_changed",
      );
      return project;
    }
    if (execution.status === "pending") return this.dispatch(project);
    await this.recordRecoverySuppressed(
      project,
      expectedAttemptId,
      "execution_already_progressed",
    );
    return project;
  }

  async restart(
    project: Project,
    tasks: Task[],
    expectedAttemptId?: string,
  ): Promise<Project> {
    if (
      expectedAttemptId &&
      project.currentExecution?.attemptId !== expectedAttemptId
    ) {
      await this.recordRecoverySuppressed(
        project,
        expectedAttemptId,
        "execution_changed",
      );
      return project;
    }
    if (!project.requestedAction) return project;
    const execution = project.currentExecution;
    const restartable: Project =
      execution && activeStatuses.has(execution.status)
        ? {
            ...project,
            currentExecution: {
              ...execution,
              status: "interrupted",
              finishedAt: this.options.now(),
            },
          }
        : project;
    return this.start(restartable, tasks, project.requestedAction, project);
  }

  async renewLease(projectId: string, attemptId: string): Promise<Project> {
    const project = await this.requireProject(projectId);
    const execution = project.currentExecution;
    if (!execution || execution.attemptId !== attemptId) return project;
    const updated: Project = {
      ...project,
      currentExecution: {
        ...execution,
        leaseExpiresAt: this.options.leaseExpiration(),
      },
      updatedAt: this.options.now(),
    };
    await this.store.saveProject(updated);
    return updated;
  }

  async cancel(project: Project): Promise<Project> {
    const execution = project.currentExecution;
    if (!execution || !activeStatuses.has(execution.status)) return project;
    await this.executor.interrupt(project);
    return {
      ...project,
      currentExecution: {
        ...execution,
        status: "interrupted",
        finishedAt: this.options.now(),
      },
    };
  }

  async failTurn(
    projectId: string,
    attemptId: string,
    message: string,
  ): Promise<Project> {
    const project = await this.requireProject(projectId);
    if (project.currentExecution?.attemptId !== attemptId) return project;
    return this.fail(project, message);
  }

  private async dispatch(project: Project): Promise<Project> {
    const execution = project.currentExecution!;
    try {
      let withThread = project;
      let threadId = execution.threadId;
      if (!threadId) {
        threadId = await this.executor.openThread(project);
        withThread = {
          ...project,
          currentExecution: { ...execution, threadId },
          updatedAt: this.options.now(),
        };
        await this.store.saveProject(withThread);
        await this.options.recordEvent({
          type: "thread.created",
          projectId: project.id,
          attemptId: execution.attemptId,
          threadId,
          before: projectLifecycleState(project),
          after: projectLifecycleState(withThread),
          data: { ephemeral: true },
        });
      }

      const turnId = await this.executor.startTurn(withThread, threadId);
      const running: Project = {
        ...withThread,
        currentExecution: {
          ...withThread.currentExecution!,
          status: "running",
          turnId,
          leaseExpiresAt: this.options.leaseExpiration(),
        },
        updatedAt: this.options.now(),
      };
      await this.store.saveProject(running);
      await this.options.recordEvent({
        type: "turn.started",
        projectId: project.id,
        attemptId: execution.attemptId,
        threadId,
        turnId,
        before: projectLifecycleState(withThread),
        after: projectLifecycleState(running),
        data: { scope: "project" },
      });
      return running;
    } catch (error) {
      return this.fail(
        await this.requireProject(project.id),
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async fail(
    project: Project,
    reason: string,
    reportReminderCount?: number,
  ): Promise<Project> {
    const execution = project.currentExecution;
    if (!execution) throw new Error(`Project ${project.id} has no current execution`);
    const now = this.options.now();
    const blocked: Project = {
      ...project,
      status: "blocked",
      currentExecution: {
        ...execution,
        status: "failed",
        ...(reportReminderCount === undefined ? {} : { reportReminderCount }),
        finishedAt: now,
      },
      updatedAt: now,
    };
    await this.store.saveProject(blocked);
    await this.options.recordEvent({
      type: "project.execution_failed",
      projectId: project.id,
      attemptId: execution.attemptId,
      ...(execution.threadId ? { threadId: execution.threadId } : {}),
      ...(execution.turnId ? { turnId: execution.turnId } : {}),
      reason,
      before: projectLifecycleState(project),
      after: projectLifecycleState(blocked),
      data: { action: execution.action },
    });
    return blocked;
  }

  private async recordRecoverySuppressed(
    project: Project,
    expectedAttemptId: string,
    reason: string,
  ): Promise<void> {
    const execution = project.currentExecution;
    await this.options.recordEvent({
      type: "recovery.execution_suppressed",
      component: "recovery",
      projectId: project.id,
      attemptId: expectedAttemptId,
      ...(execution?.threadId ? { threadId: execution.threadId } : {}),
      ...(execution?.turnId ? { turnId: execution.turnId } : {}),
      decision: "keep_current",
      reason,
      data: {
        currentAttemptId: execution?.attemptId ?? null,
        currentExecutionStatus: execution?.status ?? null,
      },
    });
  }

  private async requireProject(projectId: string): Promise<Project> {
    const snapshot = await this.store.getProject(projectId);
    if (!snapshot) throw new Error(`Project ${projectId} was not found`);
    return snapshot.project;
  }
}

function validateProjectReport(action: ProjectAction, report: ProjectReport): void {
  const allowedOutcomes =
    action === "select_tasks"
      ? new Set(["selected", "wait_for_active_tasks", "needs_input", "blocked"])
      : new Set(["completed", "tasks_required", "needs_input", "blocked"]);
  if (!allowedOutcomes.has(report.outcome)) {
    throw new WorkflowConflictError(
      `Outcome ${report.outcome} is invalid for ${action}`,
    );
  }
  if (report.outcome === "selected" && !report.taskIds?.length) {
    throw new WorkflowConflictError(
      `Project execution ${report.attemptId} requires taskIds for selected`,
    );
  }
  if (report.outcome === "tasks_required" && !report.tasks?.length) {
    throw new WorkflowConflictError(
      `Project execution ${report.attemptId} requires tasks for tasks_required`,
    );
  }
  if (report.outcome === "needs_input" && !report.question) {
    throw new WorkflowConflictError(
      `Project execution ${report.attemptId} requires a question for needs_input`,
    );
  }
}

function evaluationFingerprint(tasks: Task[]): string {
  return tasks
    .filter(({ status }) => status === "done")
    .map(({ id, mergedCommit }) => `${id}:${mergedCommit ?? "no-commit"}`)
    .sort()
    .join("|");
}
