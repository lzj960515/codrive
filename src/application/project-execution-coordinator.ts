import { isDeepStrictEqual } from "node:util";

import { WorkflowConflictError } from "../domain/errors.js";
import { markPlanningEvaluated } from "../domain/planning.js";
import type {
  CodriveEvent,
  Project,
  ProjectReport,
  ModelRoutingSettings,
} from "../domain/types.js";
import type { ProjectStore } from "../infrastructure/project-store.js";
import { projectLifecycleState } from "./lifecycle-recorder.js";
import type { ProjectExecutor } from "./project-executor.js";
import {
  type CodexTurnFailure,
  initialModelRouting,
  isModelCapacityFailure,
  isRetryDue,
  markRetryStarted,
  planModelCapacityRecovery,
  prepareModelRoutingForTurn,
  resetCapacityFailuresAfterStableTurn,
} from "./model-routing.js";

const activeStatuses = new Set([
  "pending",
  "running",
  "retry_scheduled",
  "awaiting_report",
]);
const inFlightStatuses = new Set(["running", "awaiting_report"]);
const reportSubmissionStatuses = new Set(["pending", "running", "awaiting_report"]);

export interface ProjectExecutionCoordinatorOptions {
  now: () => string;
  createId: (prefix: string) => string;
  leaseExpiration: () => string;
  modelSettings: () => ModelRoutingSettings;
  modelCapacityRetryDelaysMs: readonly number[];
  modelCapacityRetryResetAfterMs: number;
  modelPrimaryProbeAfterMs: number;
  recordEvent: (
    event: Omit<CodriveEvent, "eventId" | "occurredAt">,
  ) => Promise<void>;
}

export interface ProjectExecutionStartContext {
  planningRevision?: number;
  selectionCapacity?: number;
}

export class ProjectExecutionCoordinator {
  constructor(
    private readonly store: ProjectStore,
    private readonly executor: ProjectExecutor,
    private readonly options: ProjectExecutionCoordinatorOptions,
  ) {}

  async start(
    project: Project,
    context: ProjectExecutionStartContext = {},
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
      status: "active",
      requestedAction: "select_tasks",
      currentExecution: {
        attemptId: this.options.createId("project_attempt"),
        action: "select_tasks",
        status: "pending",
        startedAt: now,
        modelRouting:
          project.modelRouting ?? initialModelRouting(this.options.modelSettings()),
        leaseExpiresAt: this.options.leaseExpiration(),
        ...context,
      },
      updatedAt: now,
    };
    await this.store.saveProject(pending);
    await this.options.recordEvent({
      type: "project.select_tasks_started",
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
    if (project.currentExecution?.result?.attemptId === report.attemptId) {
      if (isDeepStrictEqual(project.currentExecution.result, report)) return project;
      throw new WorkflowConflictError(
        `Report conflicts with the recorded project execution for ${project.id}`,
      );
    }

    const execution = project.currentExecution;
    if (
      !execution ||
      execution.attemptId !== report.attemptId ||
      !reportSubmissionStatuses.has(execution.status)
    ) {
      throw new WorkflowConflictError(
        `Report does not match the current project execution for ${project.id}`,
      );
    }
    validateProjectReport(report);
    await validateBeforeSave(project, report);

    const reported: Project = {
      ...project,
      currentExecution: { ...execution, result: report },
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
    if (!inFlightStatuses.has(execution.status)) {
      await this.options.recordEvent({
        type: "workflow.event_suppressed",
        projectId,
        attemptId,
        turnId,
        decision: "ignore",
        reason: "execution_not_active",
        data: { executionStatus: execution.status, scope: "project" },
      });
      return project;
    }

    const now = this.options.now();
    if (execution.result) {
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
    const reminderRouting = prepareModelRoutingForTurn(
      awaitingReport.currentExecution!.modelRouting,
      this.options.modelSettings(),
      new Date(this.options.now()),
      this.options.modelPrimaryProbeAfterMs,
    );
    const projectForReminder =
      reminderRouting === awaitingReport.currentExecution!.modelRouting
        ? awaitingReport
        : {
            ...awaitingReport,
            currentExecution: {
              ...awaitingReport.currentExecution!,
              modelRouting: reminderRouting,
            },
            updatedAt: this.options.now(),
          };
    const reminderTurnId = await this.executor.requestReport(
      projectForReminder,
      execution.threadId!,
    );
    const turnStartedAt = this.options.now();
    const reminded: Project = {
      ...projectForReminder,
      currentExecution: {
        ...projectForReminder.currentExecution!,
        turnId: reminderTurnId,
        turnStartedAt,
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
      before: projectLifecycleState(projectForReminder),
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
    return this.start(restartable, {
      ...(execution?.planningRevision === undefined
        ? {}
        : { planningRevision: execution.planningRevision }),
      ...(execution?.selectionCapacity === undefined
        ? {}
        : { selectionCapacity: execution.selectionCapacity }),
    }, project);
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
    if (inFlightStatuses.has(execution.status)) {
      await this.executor.interrupt(project);
    }
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
    failure: CodexTurnFailure,
  ): Promise<Project> {
    const project = await this.requireProject(projectId);
    const execution = project.currentExecution;
    if (
      !execution ||
      execution.attemptId !== attemptId ||
      execution.turnId !== failure.turnId ||
      !inFlightStatuses.has(execution.status)
    ) {
      return project;
    }
    if (!isModelCapacityFailure(failure)) {
      return this.fail(project, failure.message);
    }

    const failureTime = new Date(this.options.now());
    const currentRouting = resetCapacityFailuresAfterStableTurn(
      execution.modelRouting,
      execution.turnStartedAt,
      failureTime,
      this.options.modelCapacityRetryResetAfterMs,
    );
    const recovery = planModelCapacityRecovery(
      currentRouting,
      failure,
      this.options.modelSettings(),
      failureTime,
      this.options.modelCapacityRetryDelaysMs,
      this.options.modelPrimaryProbeAfterMs,
    );
    if (recovery.outcome === "exhausted") {
      return this.fail(project, failure.message, undefined, recovery.routing);
    }

    const scheduled: Project = {
      ...project,
      currentExecution: {
        ...execution,
        status: "retry_scheduled",
        modelRouting: recovery.routing,
      },
      updatedAt: this.options.now(),
    };
    await this.store.saveProject(scheduled);
    await this.options.recordEvent({
      type: "turn.retry_scheduled",
      projectId: project.id,
      attemptId,
      ...(execution.threadId ? { threadId: execution.threadId } : {}),
      turnId: failure.turnId,
      reason: failure.message,
      before: projectLifecycleState(project),
      after: projectLifecycleState(scheduled),
      data: {
        scope: "project",
        model: recovery.routing.model,
        modelRoute: recovery.routing.route,
        retryCount: recovery.routing.retryCount,
        nextRetryAt: recovery.routing.nextRetryAt,
      },
    });
    return scheduled;
  }

  async retryScheduled(project: Project, now: Date): Promise<Project> {
    const execution = project.currentExecution;
    if (
      !execution ||
      execution.status !== "retry_scheduled" ||
      !isRetryDue(execution.modelRouting, now)
    ) {
      return project;
    }
    const pending: Project = {
      ...project,
      currentExecution: {
        ...execution,
        status: execution.reportReminderCount ? "awaiting_report" : "pending",
        modelRouting: markRetryStarted(execution.modelRouting),
        leaseExpiresAt: this.options.leaseExpiration(),
      },
      updatedAt: this.options.now(),
    };
    await this.store.saveProject(pending);
    return this.dispatch(pending);
  }

  private async dispatch(project: Project): Promise<Project> {
    const execution = project.currentExecution!;
    const modelRouting = prepareModelRoutingForTurn(
      execution.modelRouting,
      this.options.modelSettings(),
      new Date(this.options.now()),
      this.options.modelPrimaryProbeAfterMs,
    );
    const projectForTurn =
      modelRouting === execution.modelRouting
        ? project
        : {
            ...project,
            currentExecution: { ...execution, modelRouting },
            updatedAt: this.options.now(),
          };
    try {
      let withThread = projectForTurn;
      let threadId = execution.threadId;
      if (!threadId) {
        threadId = await this.executor.openThread(projectForTurn);
        withThread = {
          ...projectForTurn,
          currentExecution: {
            ...projectForTurn.currentExecution!,
            threadId,
          },
          updatedAt: this.options.now(),
        };
        await this.store.saveProject(withThread);
        await this.options.recordEvent({
          type: "thread.created",
          projectId: project.id,
          attemptId: execution.attemptId,
          threadId,
          before: projectLifecycleState(projectForTurn),
          after: projectLifecycleState(withThread),
          data: { ephemeral: true },
        });
      }

      const turnId = execution.reportReminderCount
        ? await this.executor.requestReport(withThread, threadId)
        : await this.executor.startTurn(withThread, threadId);
      const running: Project = {
        ...withThread,
        currentExecution: {
          ...withThread.currentExecution!,
          status: execution.reportReminderCount ? "awaiting_report" : "running",
          turnId,
          turnStartedAt: this.options.now(),
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
    modelRouting = project.currentExecution?.modelRouting,
  ): Promise<Project> {
    const execution = project.currentExecution;
    if (!execution) throw new Error(`Project ${project.id} has no current execution`);
    const now = this.options.now();
    const result: ProjectReport = {
      projectId: project.id,
      attemptId: execution.attemptId,
      outcome: "blocked",
      summary: reason,
    };
    const failed: Project = {
      ...project,
      status: "active",
      planning: markPlanningEvaluated(project.planning),
      currentExecution: {
        ...execution,
        status: "failed",
        result,
        ...(reportReminderCount === undefined ? {} : { reportReminderCount }),
        ...(modelRouting ? { modelRouting } : {}),
        finishedAt: now,
      },
      updatedAt: now,
    };
    await this.store.saveProject(failed);
    await this.options.recordEvent({
      type: "project.execution_failed",
      projectId: project.id,
      attemptId: execution.attemptId,
      ...(execution.threadId ? { threadId: execution.threadId } : {}),
      ...(execution.turnId ? { turnId: execution.turnId } : {}),
      reason,
      before: projectLifecycleState(project),
      after: projectLifecycleState(failed),
      data: { action: execution.action },
    });
    return failed;
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

function validateProjectReport(report: ProjectReport): void {
  const allowedOutcomes = new Set([
    "selected",
    "wait_for_active_tasks",
    "needs_input",
    "blocked",
  ]);
  if (!allowedOutcomes.has(report.outcome)) {
    throw new WorkflowConflictError(
      `Outcome ${report.outcome} is invalid for select_tasks`,
    );
  }
  if (report.outcome === "selected" && !report.taskIds?.length) {
    throw new WorkflowConflictError(
      `Project execution ${report.attemptId} requires taskIds for selected`,
    );
  }
  if (report.outcome === "needs_input" && !report.question) {
    throw new WorkflowConflictError(
      `Project execution ${report.attemptId} requires a question for needs_input`,
    );
  }
}
