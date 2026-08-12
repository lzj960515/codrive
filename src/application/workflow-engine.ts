import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { WorkflowConflictError } from "../domain/errors.js";
import { advancePlanning, markPlanningEvaluated } from "../domain/planning.js";
import {
  createTaskLifecycleActivity,
  createTaskReportActivity,
  projectTaskActivities,
  taskActivityMatchesReport,
  taskReportFromActivity,
} from "../domain/task-activity.js";
import type {
  CancellationInput,
  CodriveCommand,
  CodriveEvent,
  CreateProjectInput,
  CreateTaskInput,
  Project,
  ProjectReport,
  ProjectSnapshot,
  Task,
  TaskActivity,
  TaskReport,
  LifecycleEventSource,
  ModelRoutingSettings,
} from "../domain/types.js";
import {
  applyTaskReport,
  startTaskExecution,
  validateTaskReport,
} from "../domain/workflow.js";
import type { ProjectStore } from "../infrastructure/project-store.js";
import {
  LifecycleRecorder,
  projectLifecycleState,
  taskLifecycleState,
} from "./lifecycle-recorder.js";
import { ProjectExecutionCoordinator } from "./project-execution-coordinator.js";
import type { ProjectExecutor } from "./project-executor.js";
import type { DispatchRequest, TaskDispatcher } from "./task-dispatcher.js";
import {
  type CodexTurnFailure,
  defaultModelCapacityRetryDelaysMs,
  initialModelRouting,
  isModelCapacityFailure,
  isRetryDue,
  markRetryStarted,
  planModelCapacityRecovery,
} from "./model-routing.js";

export interface WorkflowEngineOptions {
  maxConcurrentTasks: number;
  models: ModelRoutingSettings;
  modelCapacityRetryDelaysMs?: readonly number[];
  executionLeaseMs?: number;
  now?: () => string;
  createId?: (prefix: string) => string;
}

const activeExecutionStatuses = new Set([
  "pending",
  "running",
  "retry_scheduled",
  "awaiting_report",
]);
const inFlightExecutionStatuses = new Set(["running", "awaiting_report"]);
const reportableExecutionStatuses = new Set([
  ...activeExecutionStatuses,
  "waiting_for_input",
]);
const reportSubmissionStatuses = new Set([
  "pending",
  "running",
  "awaiting_report",
  "waiting_for_input",
]);
const integrationLeaseStatuses = new Set([
  ...activeExecutionStatuses,
  "waiting_for_input",
]);

export class WorkflowEngine {
  readonly lifecycle: LifecycleRecorder;
  private readonly now: () => string;
  private readonly createId: (prefix: string) => string;
  private readonly executionLeaseMs: number;
  private readonly modelCapacityRetryDelaysMs: readonly number[];
  private maxConcurrentTasks: number;
  private models: ModelRoutingSettings;
  private readonly projectExecutions: ProjectExecutionCoordinator | undefined;
  private operation: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly store: ProjectStore,
    private readonly dispatcher: TaskDispatcher,
    private readonly options: WorkflowEngineOptions,
    projectExecutor?: ProjectExecutor,
    lifecycle?: LifecycleRecorder,
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.createId = options.createId ?? ((prefix) => `${prefix}_${randomUUID()}`);
    this.executionLeaseMs = options.executionLeaseMs ?? 6 * 60 * 60 * 1000;
    this.modelCapacityRetryDelaysMs =
      options.modelCapacityRetryDelaysMs ?? defaultModelCapacityRetryDelaysMs;
    this.maxConcurrentTasks = options.maxConcurrentTasks;
    this.models = options.models;
    this.lifecycle =
      lifecycle ??
      new LifecycleRecorder(store, {
        now: this.now,
        createId: this.createId,
      });
    this.projectExecutions = projectExecutor
      ? new ProjectExecutionCoordinator(this.store, projectExecutor, {
          now: this.now,
          createId: this.createId,
          leaseExpiration: () => this.leaseExpiration(),
          modelSettings: () => this.models,
          modelCapacityRetryDelaysMs: this.modelCapacityRetryDelaysMs,
          recordEvent: async (event) => {
            await this.recordEvent(event);
          },
        })
      : undefined;
  }

  execute(
    command: CodriveCommand,
    source: LifecycleEventSource = "http",
  ): Promise<unknown> {
    const commandId = this.createId("command");
    const startedAt = Date.now();
    return this.lifecycle.run(
      {
        source,
        component: "http",
        commandId,
        correlationId: commandId,
      },
      async () => {
        let target = await this.commandTarget(command);
        const received = await this.lifecycle.record({
          type: "command.received",
          ...target,
          result: "received",
          data: commandSummary(command),
        });
        return this.lifecycle.run(
          {
            source,
            component: "workflow",
            commandId,
            correlationId: commandId,
            causationId: received.eventId,
          },
          async () => {
            try {
              const result = await this.dispatchCommand(command, source);
              target = target.projectId ? target : commandResultTarget(result);
              await this.lifecycle.record({
                type: "command.succeeded",
                ...target,
                result: "succeeded",
                durationMs: Date.now() - startedAt,
                data: commandSummary(command),
              });
              return result;
            } catch (error) {
              await this.lifecycle.record({
                type: "command.rejected",
                ...target,
                result: "rejected",
                reason: error instanceof Error ? error.message : String(error),
                durationMs: Date.now() - startedAt,
                data: commandSummary(command),
              });
              throw error;
            }
          },
        );
      },
    );
  }

  private dispatchCommand(
    command: CodriveCommand,
    source: LifecycleEventSource,
  ): Promise<unknown> {
    switch (command.type) {
      case "project.register":
        return this.registerProject(command.payload);
      case "project.add_work":
        return this.addProjectWork(
          command.payload.projectId,
          command.payload.tasks,
          command.payload.productDocument,
        );
      case "project.control":
        if (command.payload.action === "retry") {
          return this.retryProject(command.payload.projectId);
        }
        if (command.payload.action === "cancel") {
          return this.cancelProject(
            command.payload.projectId,
            cancellationInput(command.payload, source),
          );
        }
        return this.controlProject(
          command.payload.projectId,
          command.payload.action,
        );
      case "project.record_decision":
        return this.recordProjectDecision(
          command.payload.projectId,
          command.payload.decision,
          command.payload.productDocument,
        );
      case "task.control":
        return command.payload.action === "retry"
          ? this.retryTask(command.payload.taskId)
          : this.cancelTask(
              command.payload.taskId,
              cancellationInput(command.payload, source),
            );
      case "task.report":
        return this.submitReport(command.payload);
      case "project.report":
        return this.submitProjectReport(command.payload);
    }
  }

  reconcile(): Promise<void> {
    return this.enqueue(() => this.reconcileInternal());
  }

  recoverProjectsWithoutActiveWork(): Promise<void> {
    return this.enqueue(async () => {
      await this.reconcileInternal();
      await this.recordSuppressedPlanningRecovery();
    });
  }

  async availableTaskSlots(projectId: string): Promise<number> {
    const snapshot = await this.store.getProject(projectId);
    if (!snapshot) return 0;
    const execution = snapshot.project.currentExecution;
    if (
      execution?.action === "select_tasks" &&
      activeExecutionStatuses.has(execution.status) &&
      execution.selectionCapacity !== undefined
    ) {
      return execution.selectionCapacity;
    }
    return availableProjectPlanningCapacity(
      snapshot,
      projectConcurrencyLimit(snapshot.project, this.maxConcurrentTasks),
    );
  }

  updateRuntimeSettings(settings: {
    maxConcurrentTasks: number;
    models: ModelRoutingSettings;
  }): Promise<void> {
    return this.enqueue(async () => {
      this.maxConcurrentTasks = settings.maxConcurrentTasks;
      this.models = settings.models;
      await this.reconcileInternal();
    });
  }

  registerProject(input: CreateProjectInput): Promise<ProjectSnapshot> {
    return this.enqueue(async () => {
      const created = await this.store.createProject(input);
      await this.store.saveProject({
        ...created.project,
        planning: {
          ...created.project.planning,
          concurrencyLimit: this.maxConcurrentTasks,
        },
      });
      await this.reconcileInternal();
      return (await this.store.getProject(created.project.id))!;
    });
  }

  addProjectWork(
    projectId: string,
    tasks: CreateTaskInput[],
    productDocument?: string,
  ): Promise<ProjectSnapshot> {
    return this.enqueue(async () => {
      const snapshot = await this.requireSnapshot(projectId);
      if (snapshot.project.status === "cancelled") {
        throw new WorkflowConflictError(`Cancelled project ${projectId} cannot accept work`);
      }
      if (productDocument) {
        await this.store.saveProductDocument(projectId, productDocument);
      }
      await this.store.addTasks(projectId, tasks);
      const currentProject = hasActiveProjectExecution(snapshot.project)
        ? await this.requireProjectExecutions().cancel(snapshot.project)
        : snapshot.project;
      const project: Project = {
        ...currentProject,
        status: "active",
        requestedAction: null,
        planning: advancePlanning(
          currentProject.planning,
          "work_added",
          this.now(),
          this.maxConcurrentTasks,
        ),
        updatedAt: this.now(),
      };
      await this.store.saveProject(project);
      await this.recordEvent({
        type: "project.work_added",
        projectId,
        before: projectLifecycleState(snapshot.project),
        after: projectLifecycleState(project),
        data: { taskCount: tasks.length },
      });
      await this.recordPlanningRevision(project, snapshot.project.planning.revision);
      await this.reconcileInternal();
      return (await this.store.getProject(projectId))!;
    });
  }

  recordProjectDecision(
    projectId: string,
    decision: string,
    productDocument?: string,
  ): Promise<Project> {
    return this.enqueue(async () => {
      const snapshot = await this.requireSnapshot(projectId);
      if (snapshot.project.status === "cancelled") {
        throw new WorkflowConflictError(
          `Cancelled project ${projectId} cannot accept decisions`,
        );
      }
      if (productDocument) {
        await this.store.saveProductDocument(projectId, productDocument);
      }
      const currentProject = hasActiveProjectExecution(snapshot.project)
        ? await this.requireProjectExecutions().cancel(snapshot.project)
        : snapshot.project;
      const project: Project = {
        ...currentProject,
        contextNotes: [...(currentProject.contextNotes ?? []), decision],
        status: "active",
        requestedAction: null,
        planning: advancePlanning(
          currentProject.planning,
          "project_decision_recorded",
          this.now(),
          this.maxConcurrentTasks,
        ),
        updatedAt: this.now(),
      };
      await this.store.saveProject(project);
      await this.recordEvent({
        type: "project.decision_recorded",
        projectId,
        before: projectLifecycleState(snapshot.project),
        after: projectLifecycleState(project),
      });
      await this.recordPlanningRevision(project, snapshot.project.planning.revision);
      await this.reconcileInternal();
      return (await this.requireSnapshot(projectId)).project;
    });
  }

  submitReport(report: TaskReport): Promise<Task> {
    return this.enqueue(async () => {
      const found = await this.requireTask(report.taskId);
      const execution = found.task.currentExecution;
      const activities = await this.store.listTaskActivities(
        found.project.id,
        report.taskId,
      );
      const previousActivity = activities
        .filter(({ attemptId }) => attemptId === report.attemptId)
        .at(-1);
      if (previousActivity) {
        if (taskActivityMatchesReport(previousActivity, report)) return found.task;
        if (execution?.status !== "waiting_for_input") {
          throw new WorkflowConflictError(
            `Report conflicts with the recorded result for ${report.taskId}`,
          );
        }
      }
      if (
        !execution ||
        execution.attemptId !== report.attemptId ||
        !reportSubmissionStatuses.has(execution.status)
      ) {
        throw new WorkflowConflictError(
          `Report does not match the current execution for ${report.taskId}`,
        );
      }
      validateTaskReport(found.task, report);

      const activity = createTaskReportActivity({
        activityId: this.createId("activity"),
        projectId: found.project.id,
        action: execution.action,
        report,
        ...(execution.threadId ? { threadId: execution.threadId } : {}),
        occurredAt: this.now(),
      });
      const task: Task = {
        ...found.task,
        currentExecution: {
          ...execution,
          submittedActivityId: activity.id,
        },
        updatedAt: this.now(),
      };
      await this.store.saveTask(found.project.id, task);
      await this.recordEvent({
        type: "task.activity_recorded",
        projectId: found.project.id,
        taskId: task.id,
        attemptId: execution.attemptId,
        ...(execution.threadId ? { threadId: execution.threadId } : {}),
        data: { activity },
      });

      if (execution.turnCompletedAt || execution.status === "waiting_for_input") {
        const completed = await this.finalizeTaskReport(found.project, task, report);
        await this.reconcileInternal();
        return completed;
      }
      return task;
    });
  }

  submitProjectReport(report: ProjectReport): Promise<Project> {
    return this.enqueue(async () => {
      const reported = await this.requireProjectExecutions().submitReport(
        report,
        (project, currentReport) =>
          this.validateProjectReportBeforeSave(project, currentReport),
      );
      if (reported.currentExecution?.turnCompletedAt) {
        const completed = await this.finalizeProjectReport(reported, report);
        await this.reconcileInternal();
        return completed;
      }
      return reported;
    });
  }

  completeTurn(taskId: string, attemptId: string, turnId: string): Promise<Task> {
    return this.enqueue(async () => {
      const found = await this.requireTask(taskId);
      const execution = found.task.currentExecution;
      if (!execution || execution.attemptId !== attemptId) {
        await this.recordEvent({
          type: "workflow.event_suppressed",
          projectId: found.project.id,
          taskId,
          attemptId,
          turnId,
          decision: "ignore",
          reason: "execution_changed",
          data: { currentAttemptId: execution?.attemptId ?? null },
        });
        return found.task;
      }
      if (execution.turnId !== turnId) {
        await this.recordEvent({
          type: "workflow.event_suppressed",
          projectId: found.project.id,
          taskId,
          attemptId,
          turnId,
          decision: "ignore",
          reason: "turn_changed",
          data: { currentTurnId: execution.turnId ?? null },
        });
        return found.task;
      }
      if (!inFlightExecutionStatuses.has(execution.status)) {
        await this.recordEvent({
          type: "workflow.event_suppressed",
          projectId: found.project.id,
          taskId,
          attemptId,
          turnId,
          decision: "ignore",
          reason: "execution_not_in_flight",
          data: { executionStatus: execution.status },
        });
        return found.task;
      }

      const now = this.now();
      if (execution.submittedActivityId) {
        const activity = await this.requireTaskActivity(
          found.project.id,
          taskId,
          execution.submittedActivityId,
        );
        const taskWithCompletedTurn: Task = {
          ...found.task,
          currentExecution: { ...execution, turnCompletedAt: now },
          updatedAt: now,
        };
        await this.recordEvent({
          type: "turn.completed",
          projectId: found.project.id,
          taskId,
          attemptId,
          ...(execution.threadId ? { threadId: execution.threadId } : {}),
          turnId,
          before: taskLifecycleState(found.task),
          after: taskLifecycleState(taskWithCompletedTurn),
        });
        const completed = await this.finalizeTaskReport(
          found.project,
          taskWithCompletedTurn,
          taskReportFromActivity(activity),
        );
        await this.reconcileInternal();
        return completed;
      }

      const reportReminderCount = (execution.reportReminderCount ?? 0) + 1;
      if (reportReminderCount >= 3) {
        return this.blockTaskForMissingReport(found.project, found.task, reportReminderCount);
      }

      const awaitingReport: Task = {
        ...found.task,
        currentExecution: {
          ...execution,
          status: "awaiting_report",
          reportReminderCount,
          turnCompletedAt: now,
        },
        updatedAt: now,
      };
      await this.store.saveTask(found.project.id, awaitingReport);
      await this.recordEvent({
        type: "turn.completed",
        projectId: found.project.id,
        taskId,
        attemptId,
        ...(execution.threadId ? { threadId: execution.threadId } : {}),
        turnId,
        before: taskLifecycleState(found.task),
        after: taskLifecycleState(awaitingReport),
      });
      return this.continueTaskReportRequest(found.project, awaitingReport);
    });
  }

  completeProjectTurn(
    projectId: string,
    attemptId: string,
    turnId: string,
  ): Promise<Project> {
    return this.enqueue(async () => {
      const project = await this.requireProjectExecutions().completeTurn(
        projectId,
        attemptId,
        turnId,
      );
      if (project.currentExecution?.result) {
        const completed = await this.finalizeProjectReport(
          project,
          project.currentExecution.result,
        );
        await this.reconcileInternal();
        return completed;
      }
      return project;
    });
  }

  retryTask(taskId: string): Promise<Task> {
    return this.enqueue(async () => {
      const found = await this.requireTask(taskId);
      if (!found.task.requestedAction) {
        throw new WorkflowConflictError(`Task ${taskId} has no action to retry`);
      }
      if (
        found.task.currentExecution &&
        reportableExecutionStatuses.has(found.task.currentExecution.status)
      ) {
        throw new WorkflowConflictError(
          `Task ${taskId} is still active and cannot be retried`,
        );
      }
      return this.startReplacementTaskExecution(found.project, found.task);
    });
  }

  recoverTask(taskId: string, expectedAttemptId: string): Promise<Task> {
    return this.enqueue(async () => {
      const found = await this.requireTask(taskId);
      if (!found.task.requestedAction) return found.task;
      const execution = found.task.currentExecution;
      if (!execution || execution.attemptId !== expectedAttemptId) {
        await this.recordRecoverySuppressed(
          found.project.id,
          found.task,
          expectedAttemptId,
          "execution_changed",
        );
        return found.task;
      }
      if (execution.status === "pending") {
        return this.continueTaskDispatch(found.project, found.task);
      }
      if (
        execution.status === "awaiting_report" &&
        execution.turnCompletedAt
      ) {
        return this.continueTaskReportRequest(found.project, found.task);
      }
      await this.recordRecoverySuppressed(
        found.project.id,
        found.task,
        expectedAttemptId,
        "execution_already_progressed",
      );
      return found.task;
    });
  }

  restartTaskAfterInterruption(
    taskId: string,
    expectedAttemptId: string,
  ): Promise<Task> {
    return this.enqueue(async () => {
      const found = await this.requireTask(taskId);
      if (found.task.currentExecution?.attemptId !== expectedAttemptId) {
        await this.recordRecoverySuppressed(
          found.project.id,
          found.task,
          expectedAttemptId,
          "execution_changed",
        );
        return found.task;
      }
      return this.startReplacementTaskExecution(found.project, found.task);
    });
  }

  recoverProjectExecution(
    projectId: string,
    expectedAttemptId: string,
  ): Promise<Project> {
    return this.enqueue(async () => {
      const snapshot = await this.requireSnapshot(projectId);
      return this.requireProjectExecutions().resume(
        snapshot.project,
        expectedAttemptId,
      );
    });
  }

  restartProjectAfterInterruption(
    projectId: string,
    expectedAttemptId: string,
  ): Promise<Project> {
    return this.enqueue(async () => {
      const snapshot = await this.requireSnapshot(projectId);
      return this.requireProjectExecutions().restart(
        snapshot.project,
        expectedAttemptId,
      );
    });
  }

  renewTaskLease(taskId: string, attemptId: string): Promise<Task> {
    return this.enqueue(async () => {
      const found = await this.requireTask(taskId);
      const execution = found.task.currentExecution;
      if (!execution || execution.attemptId !== attemptId) return found.task;
      const task: Task = {
        ...found.task,
        currentExecution: {
          ...execution,
          leaseExpiresAt: this.leaseExpiration(),
        },
        updatedAt: this.now(),
      };
      await this.store.saveTask(found.project.id, task);
      return task;
    });
  }

  renewProjectLease(projectId: string, attemptId: string): Promise<Project> {
    return this.enqueue(() =>
      this.requireProjectExecutions().renewLease(projectId, attemptId),
    );
  }

  retryProject(projectId: string): Promise<Project> {
    return this.enqueue(async () => {
      const snapshot = await this.requireSnapshot(projectId);
      if (snapshot.project.status === "cancelled") {
        throw new WorkflowConflictError(`Cancelled project ${projectId} is terminal`);
      }
      if (!snapshot.project.requestedAction) {
        throw new WorkflowConflictError(
          `Project ${projectId} has no action to retry`,
        );
      }
      if (
        snapshot.project.currentExecution &&
        activeExecutionStatuses.has(snapshot.project.currentExecution.status)
      ) {
        throw new WorkflowConflictError(
          `Project ${projectId} is still active and cannot be retried`,
        );
      }
      return this.requireProjectExecutions().restart(
        snapshot.project,
        snapshot.project.currentExecution?.attemptId,
      );
    });
  }

  controlProject(
    projectId: string,
    action: "pause" | "resume" | "replan",
  ): Promise<Project> {
    return this.enqueue(async () => {
      const snapshot = await this.requireSnapshot(projectId);
      if (snapshot.project.status === "cancelled") {
        throw new WorkflowConflictError(`Cancelled project ${projectId} is terminal`);
      }

      if (action === "replan") {
        const project = await this.revisePlanning(projectId, "manual_replan");
        await this.reconcileInternal();
        return (await this.requireSnapshot(project.id)).project;
      }

      if (action === "pause" || action === "resume") {
        const scheduling = action === "pause" ? "paused" : "running";
        const project: Project = {
          ...snapshot.project,
          scheduling,
          updatedAt: this.now(),
        };
        await this.store.saveProject(project);
        await this.recordEvent({
          type: action === "pause" ? "project.paused" : "project.resumed",
          projectId,
          before: projectLifecycleState(snapshot.project),
          after: projectLifecycleState(project),
        });
        if (action === "resume") await this.reconcileInternal();
        return (await this.requireSnapshot(projectId)).project;
      }

      throw new WorkflowConflictError(
        `Unsupported project control action ${action}`,
      );
    });
  }

  cancelProject(
    projectId: string,
    cancellationInput: CancellationInput,
  ): Promise<Project> {
    return this.enqueue(async () => {
      const snapshot = await this.requireSnapshot(projectId);
      if (snapshot.project.status === "cancelled") {
        throw new WorkflowConflictError(`Cancelled project ${projectId} is terminal`);
      }
      const cancellation = {
        ...cancellationInput,
        reason: requireCancellationReason(cancellationInput.reason),
        cancelledAt: this.now(),
      };
      let project = await this.requireProjectExecutions().cancel(snapshot.project);
      project = {
        ...project,
        status: "cancelled",
        scheduling: "paused",
        requestedAction: null,
        cancellation,
        updatedAt: cancellation.cancelledAt,
      };
      await this.store.saveProject(project);
      await this.recordEvent({
        type: "project.cancelled",
        projectId,
        reason: cancellation.reason,
        before: projectLifecycleState(snapshot.project),
        after: projectLifecycleState(project),
        data: {
          cancelledBy: cancellation.cancelledBy,
          decisionBasis: cancellation.decisionBasis,
        },
      });
      for (const task of snapshot.tasks) {
        await this.cancelTaskInternal(project, task, cancellation);
      }
      return (await this.requireSnapshot(projectId)).project;
    });
  }

  cancelTask(taskId: string, cancellationInput: CancellationInput): Promise<Task> {
    return this.enqueue(async () => {
      const found = await this.requireTask(taskId);
      const cancellation = {
        ...cancellationInput,
        reason: requireCancellationReason(cancellationInput.reason),
        cancelledAt: this.now(),
      };
      const cancelled = await this.cancelTaskInternal(
        found.project,
        found.task,
        cancellation,
      );
      if (cancelled !== found.task) {
        await this.revisePlanning(found.project.id, "task_cancelled");
      }
      await this.reconcileInternal();
      return cancelled;
    });
  }

  failTurn(
    taskId: string,
    attemptId: string,
    failure: CodexTurnFailure,
  ): Promise<Task> {
    return this.enqueue(async () => {
      const found = await this.requireTask(taskId);
      const execution = found.task.currentExecution;
      if (
        !execution ||
        execution.attemptId !== attemptId ||
        execution.turnId !== failure.turnId ||
        !inFlightExecutionStatuses.has(execution.status)
      ) {
        return found.task;
      }
      let exhaustedModelRouting;
      if (isModelCapacityFailure(failure)) {
        const recovery = planModelCapacityRecovery(
          execution.modelRouting,
          failure,
          this.models,
          new Date(this.now()),
          this.modelCapacityRetryDelaysMs,
        );
        if (recovery.outcome === "retry_scheduled") {
          const scheduled: Task = {
            ...found.task,
            currentExecution: {
              ...execution,
              status: "retry_scheduled",
              modelRouting: recovery.routing,
            },
            updatedAt: this.now(),
          };
          await this.store.saveTask(found.project.id, scheduled);
          await this.recordEvent({
            type: "turn.retry_scheduled",
            projectId: found.project.id,
            taskId,
            attemptId,
            ...(execution.threadId ? { threadId: execution.threadId } : {}),
            turnId: failure.turnId,
            reason: failure.message,
            before: taskLifecycleState(found.task),
            after: taskLifecycleState(scheduled),
            data: {
              model: recovery.routing.model,
              modelRoute: recovery.routing.route,
              retryCount: recovery.routing.retryCount,
              nextRetryAt: recovery.routing.nextRetryAt,
            },
          });
          await this.reconcileInternal();
          return (await this.requireTask(taskId)).task;
        }
        exhaustedModelRouting = recovery.routing;
      }
      const now = this.now();
      const failed: Task = {
        ...found.task,
        status: "blocked",
        currentExecution: {
          ...execution,
          status: "failed",
          ...(exhaustedModelRouting
            ? { modelRouting: exhaustedModelRouting }
            : {}),
          finishedAt: now,
        },
        updatedAt: now,
      };
      await this.store.saveTask(found.project.id, failed);
      await this.recordEvent({
        type: "turn.failed",
        projectId: found.project.id,
        taskId,
        attemptId,
        ...(execution.threadId ? { threadId: execution.threadId } : {}),
        ...(execution.turnId ? { turnId: execution.turnId } : {}),
        reason: failure.message,
        before: taskLifecycleState(found.task),
        after: taskLifecycleState(failed),
      });
      await this.recordTaskLifecycleActivity(
        found.project,
        failed,
        "execution_failed",
        failure.message,
        now,
      );
      await this.reconcileInternal();
      return failed;
    });
  }

  failProjectTurn(
    projectId: string,
    attemptId: string,
    failure: CodexTurnFailure,
  ): Promise<Project> {
    return this.enqueue(async () => {
      const failed = await this.requireProjectExecutions().failTurn(
        projectId,
        attemptId,
        failure,
      );
      await this.reconcileInternal();
      return (await this.requireSnapshot(failed.id)).project;
    });
  }

  retryScheduledExecutions(now = new Date(this.now())): Promise<void> {
    return this.enqueue(() => this.dispatchScheduledModelRetries(now));
  }

  private async reconcileInternal(): Promise<void> {
    await this.alignPlanningConcurrency();
    await this.dispatchScheduledModelRetries(new Date(this.now()));
    await this.dispatchTaskContinuations();
    await this.startPendingTaskSelection();
    await this.markProjectsWithoutWorkIdle();
  }

  private async dispatchScheduledModelRetries(now: Date): Promise<void> {
    for (const snapshot of await this.store.listProjects()) {
      if (
        snapshot.project.scheduling !== "running" ||
        snapshot.project.status === "cancelled"
      ) {
        continue;
      }
      if (
        snapshot.project.currentExecution?.status === "retry_scheduled" &&
        isRetryDue(snapshot.project.currentExecution.modelRouting, now)
      ) {
        await this.requireProjectExecutions().retryScheduled(
          snapshot.project,
          now,
        );
      }
      for (const task of snapshot.tasks) {
        if (
          task.currentExecution?.status === "retry_scheduled" &&
          isRetryDue(task.currentExecution.modelRouting, now)
        ) {
          await this.startScheduledTaskRetry(snapshot.project, task);
        }
      }
    }
  }

  private async startScheduledTaskRetry(
    project: Project,
    task: Task,
  ): Promise<Task> {
    const current = (await this.requireTask(task.id)).task;
    const execution = current.currentExecution;
    if (!execution || execution.status !== "retry_scheduled") return current;

    const pending: Task = {
      ...current,
      currentExecution: {
        ...execution,
        status: execution.reportReminderCount ? "awaiting_report" : "pending",
        modelRouting: markRetryStarted(execution.modelRouting),
        leaseExpiresAt: this.leaseExpiration(),
      },
      updatedAt: this.now(),
    };
    await this.store.saveTask(project.id, pending);
    return execution.reportReminderCount
      ? this.continueTaskReportRequest(project, pending)
      : this.continueTaskDispatch(project, pending);
  }

  private async alignPlanningConcurrency(): Promise<void> {
    for (const { project } of await this.store.listProjects()) {
      if (project.status === "cancelled") continue;
      if (project.planning.concurrencyLimit === undefined) {
        await this.store.saveProject({
          ...project,
          planning: {
            ...project.planning,
            concurrencyLimit: this.maxConcurrentTasks,
          },
        });
        continue;
      }
      if (project.planning.concurrencyLimit !== this.maxConcurrentTasks) {
        await this.revisePlanning(project.id, "concurrency_changed");
      }
    }
  }

  private async dispatchTaskContinuations(): Promise<void> {
    const snapshots = await this.store.listProjects();
    const activeCountByProject = new Map(
      snapshots.map(({ project, tasks }) => [project.id, countActiveTasks(tasks)]),
    );
    const integrationLeases = activeIntegrationRepositories(snapshots);
    const candidates = snapshots
      .filter(({ project }) =>
        project.scheduling === "running" &&
        project.status === "active",
      )
      .flatMap(({ project, tasks }) =>
        tasks.filter(canDispatchTask).map((task) => ({ project, task })),
      )
      .sort(compareTaskDispatchCandidates);

    for (const candidate of candidates) {
      const concurrencyLimit = projectConcurrencyLimit(
        candidate.project,
        this.maxConcurrentTasks,
      );
      const activeCount = activeCountByProject.get(candidate.project.id) ?? 0;
      if (activeCount >= concurrencyLimit) continue;
      const current = await this.store.findTask(candidate.task.id);
      if (!current || !canDispatchTask(current.task)) continue;
      if (
        current.project.scheduling !== "running" ||
        current.project.status !== "active"
      ) {
        continue;
      }
      const repository = resolve(current.project.repositoryPath);
      if (
        current.task.requestedAction === "integrate" &&
        integrationLeases.has(repository)
      ) {
        continue;
      }
      const dispatched = await this.dispatchTask(current.project, current.task);
      if (!dispatched) continue;
      activeCountByProject.set(current.project.id, activeCount + 1);
      if (current.task.requestedAction === "integrate") {
        integrationLeases.add(repository);
      }
    }
  }

  private async startPendingTaskSelection(): Promise<void> {
    if (!this.projectExecutions) return;
    const candidates = (await this.store.listProjects())
      .filter(({ project, tasks }) =>
        project.status === "active" &&
        project.scheduling === "running" &&
        !hasActiveProjectExecution(project) &&
        project.planning.evaluatedRevision !== project.planning.revision &&
        tasks.some(
          ({ status, requestedAction }) =>
            status === "backlog" && !requestedAction,
        ),
      )
      .sort(comparePlanningCandidates);

    for (const candidate of candidates) {
      const capacity = availableProjectPlanningCapacity(
        candidate,
        projectConcurrencyLimit(
          candidate.project,
          this.maxConcurrentTasks,
        ),
      );
      if (capacity <= 0) continue;
      await this.projectExecutions.start(
        candidate.project,
        {
          planningRevision: candidate.project.planning.revision,
          selectionCapacity: capacity,
        },
      );
    }
  }

  private async markProjectsWithoutWorkIdle(): Promise<void> {
    for (const snapshot of await this.store.listProjects()) {
      const { project, tasks } = snapshot;
      if (
        project.status === "cancelled" ||
        project.status === "idle" ||
        hasActiveProjectExecution(project) ||
        !tasks.every(({ status }) => ["done", "cancelled"].includes(status))
      ) {
        continue;
      }
      const idle: Project = {
        ...project,
        status: "idle",
        requestedAction: null,
        planning: markPlanningEvaluated(project.planning),
        updatedAt: this.now(),
      };
      await this.store.saveProject(idle);
      await this.recordEvent({
        type: "project.idle",
        projectId: project.id,
        before: projectLifecycleState(project),
        after: projectLifecycleState(idle),
      });
    }
  }

  private async recordSuppressedPlanningRecovery(): Promise<void> {
    for (const { project, tasks } of await this.store.listProjects()) {
      const execution = project.currentExecution;
      const result =
        execution?.action === "select_tasks" &&
        execution.planningRevision === project.planning.revision
          ? execution.result
          : undefined;
      const hasUnevaluatedBacklog = tasks.some(
        ({ status, requestedAction }) => status === "backlog" && !requestedAction,
      );
      if (
        project.status !== "active" ||
        project.scheduling !== "running" ||
        hasActiveProjectExecution(project) ||
        tasks.some(hasActiveTaskExecution) ||
        !hasUnevaluatedBacklog ||
        project.planning.evaluatedRevision !== project.planning.revision
      ) {
        continue;
      }
      await this.recordEvent({
        type: "recovery.planning_suppressed",
        component: "recovery",
        projectId: project.id,
        decision: "keep_current",
        reason: "planning_revision_already_evaluated",
        data: {
          planningRevision: project.planning.revision,
          outcome: result?.outcome ?? "unknown",
        },
      });
    }
  }

  private async dispatchTask(
    project: Project,
    task: Task,
    previous: Task = task,
  ): Promise<boolean> {
    const attemptId = this.createId("attempt");
    let pending: Task;
    try {
      pending = startTaskExecution(
        task,
        attemptId,
        this.now(),
        initialModelRouting(this.models),
      );
    } catch (error) {
      await this.recordEvent({
        type: "workflow.invariant_violated",
        projectId: project.id,
        taskId: task.id,
        attemptId,
        decision: "suppress_dispatch",
        reason: error instanceof Error ? error.message : String(error),
        before: taskLifecycleState(previous),
      });
      throw error;
    }
    pending.currentExecution!.leaseExpiresAt = this.leaseExpiration();
    await this.store.saveTask(project.id, pending);
    await this.recordEvent({
      type: "task.execution_started",
      projectId: project.id,
      taskId: pending.id,
      attemptId,
      before: taskLifecycleState(previous),
      after: taskLifecycleState(pending),
      data: {
        action: pending.currentExecution?.action,
        previousAttemptId: task.currentExecution?.attemptId ?? null,
      },
    });
    const result = await this.continueTaskDispatch(project, pending);
    return hasActiveTaskExecution(result);
  }

  private async continueTaskDispatch(project: Project, task: Task): Promise<Task> {
    const execution = task.currentExecution!;
    const request = await this.taskDispatchRequest(project, task);
    const { activity } = request;
    try {
      let withThread = task;
      let threadId = execution.threadId;
      if (!threadId) {
        const createsThread =
          execution.action === "review" || !activity.developmentThreadId;
        const createdThreadId = await this.dispatcher.openThread(request);
        threadId = createdThreadId;
        withThread = {
          ...task,
          currentExecution: { ...execution, threadId: createdThreadId },
          updatedAt: this.now(),
        };
        await this.store.saveTask(project.id, withThread);
        if (createsThread) {
          await this.recordEvent({
            type: "thread.created",
            projectId: project.id,
            taskId: task.id,
            attemptId: execution.attemptId,
            threadId: createdThreadId,
            before: taskLifecycleState(task),
            after: taskLifecycleState(withThread),
          });
        }
      }

      const dispatch = await this.dispatcher.startTurn(
        { ...request, task: withThread },
        threadId,
      );
      if (dispatch.status === "conversation_active") return withThread;

      const turnId = dispatch.turnId;
      const running: Task = {
        ...withThread,
        currentExecution: {
          ...withThread.currentExecution!,
          status: "running",
          turnId,
          leaseExpiresAt: this.leaseExpiration(),
        },
        updatedAt: this.now(),
      };
      await this.store.saveTask(project.id, running);
      await this.recordEvent({
        type: "turn.started",
        projectId: project.id,
        taskId: task.id,
        attemptId: execution.attemptId,
        threadId,
        turnId,
        before: taskLifecycleState(withThread),
        after: taskLifecycleState(running),
      });
      return running;
    } catch (error) {
      const current = (await this.requireTask(task.id)).task;
      const now = this.now();
      const reason = error instanceof Error ? error.message : String(error);
      const failed: Task = {
        ...current,
        status: "blocked",
        currentExecution: {
          ...current.currentExecution!,
          status: "failed",
          finishedAt: now,
        },
        updatedAt: now,
      };
      await this.store.saveTask(project.id, failed);
      const failedExecution = failed.currentExecution!;
      await this.recordEvent({
        type: "turn.failed",
        projectId: project.id,
        taskId: task.id,
        attemptId: execution.attemptId,
        ...(failedExecution.threadId ? { threadId: failedExecution.threadId } : {}),
        ...(failedExecution.turnId ? { turnId: failedExecution.turnId } : {}),
        reason,
        before: taskLifecycleState(current),
        after: taskLifecycleState(failed),
      });
      await this.recordTaskLifecycleActivity(
        project,
        failed,
        "execution_failed",
        reason,
        now,
      );
      return failed;
    }
  }

  private async continueTaskReportRequest(
    project: Project,
    task: Task,
  ): Promise<Task> {
    const execution = task.currentExecution!;
    const dispatch = await this.dispatcher.requestReport(
      await this.taskDispatchRequest(project, task),
      execution.threadId!,
    );
    if (dispatch.status === "conversation_active") return task;

    const reminded: Task = {
      ...task,
      currentExecution: {
        ...execution,
        turnId: dispatch.turnId,
        leaseExpiresAt: this.leaseExpiration(),
      },
      updatedAt: this.now(),
    };
    delete reminded.currentExecution?.turnCompletedAt;
    await this.store.saveTask(project.id, reminded);
    await this.recordEvent({
      type: "turn.started",
      projectId: project.id,
      taskId: task.id,
      attemptId: execution.attemptId,
      ...(execution.threadId ? { threadId: execution.threadId } : {}),
      turnId: dispatch.turnId,
      before: taskLifecycleState(task),
      after: taskLifecycleState(reminded),
    });
    return reminded;
  }

  private async finalizeTaskReport(
    project: Project,
    task: Task,
    report: TaskReport,
  ): Promise<Task> {
    const completed = applyTaskReport(task, report, this.now());
    await this.store.saveTask(project.id, completed);
    await this.recordEvent({
      type: eventForTask(completed),
      projectId: project.id,
      taskId: task.id,
      attemptId: report.attemptId,
      ...(task.currentExecution?.threadId
        ? { threadId: task.currentExecution.threadId }
        : {}),
      ...(task.currentExecution?.turnId
        ? { turnId: task.currentExecution.turnId }
        : {}),
      before: taskLifecycleState(task),
      after: taskLifecycleState(completed),
    });
    if (completed.status === "done" && task.status !== "done") {
      await this.revisePlanning(project.id, "task_completed");
    }
    return completed;
  }

  private async finalizeProjectReport(
    project: Project,
    report: ProjectReport,
  ): Promise<Project> {
    return this.finalizeTaskSelection(project, report);
  }

  private async finalizeTaskSelection(
    project: Project,
    report: ProjectReport,
  ): Promise<Project> {
    const execution = project.currentExecution!;
    const planningRevision = execution.planningRevision ?? project.planning.revision;
    if (planningRevision !== project.planning.revision) {
      throw new WorkflowConflictError(
        `Task selection revision ${planningRevision} was superseded by ${project.planning.revision}`,
      );
    }
    const selected = await this.validateTaskSelectionReport(project.id, report);
    if (report.outcome === "selected") {
      for (const task of selected) {
        await this.store.saveTask(project.id, {
          ...task,
          requestedAction: "develop",
          updatedAt: this.now(),
        });
      }
    }

    const completed: Project = {
      ...project,
      status: "active",
      requestedAction: null,
      currentExecution: completedProjectExecution(project, this.now()),
      planning: markPlanningEvaluated(project.planning),
      updatedAt: this.now(),
    };
    await this.store.saveProject(completed);
    await this.recordEvent({
      type: `project.selection_${report.outcome}`,
      projectId: project.id,
      attemptId: report.attemptId,
      ...(execution.threadId ? { threadId: execution.threadId } : {}),
      ...(execution.turnId ? { turnId: execution.turnId } : {}),
      before: projectLifecycleState(project),
      after: projectLifecycleState(completed),
      data: { taskIds: report.taskIds ?? [] },
    });
    return completed;
  }

  private async validateProjectReportBeforeSave(
    project: Project,
    report: ProjectReport,
  ): Promise<void> {
    await this.validateTaskSelectionReport(project.id, report);
  }

  private async validateTaskSelectionReport(
    projectId: string,
    report: ProjectReport,
  ): Promise<Task[]> {
    const snapshot = await this.requireSnapshot(projectId);
    const execution = snapshot.project.currentExecution;
    if (
      execution?.planningRevision !== undefined &&
      execution.planningRevision !== snapshot.project.planning.revision
    ) {
      throw new WorkflowConflictError(
        `Task selection revision ${execution.planningRevision} was superseded by ${snapshot.project.planning.revision}`,
      );
    }
    if (report.outcome === "selected") {
      const taskIds = report.taskIds!;
      if (new Set(taskIds).size !== taskIds.length) {
        throw new WorkflowConflictError("Selected task IDs must be unique");
      }

      const availableTasks = snapshot.tasks.filter(
        ({ status, requestedAction }) => status === "backlog" && !requestedAction,
      );
      const availableTasksById = new Map(availableTasks.map((task) => [task.id, task]));
      const unavailableTaskIds = taskIds.filter(
        (taskId) => !availableTasksById.has(taskId),
      );
      if (unavailableTaskIds.length > 0) {
        const availableTaskIds = availableTasks.map(({ id }) => id).join(", ");
        throw new WorkflowConflictError(
          `Task IDs ${unavailableTaskIds.join(", ")} are not available for selection. ` +
            `Available task IDs: ${availableTaskIds || "none"}`,
        );
      }

      const selectionCapacity =
        execution?.selectionCapacity ??
        availableProjectPlanningCapacity(
          snapshot,
          projectConcurrencyLimit(
            snapshot.project,
            this.maxConcurrentTasks,
          ),
        );
      if (taskIds.length > selectionCapacity) {
        throw new WorkflowConflictError(
          `Selected ${taskIds.length} tasks but only ${selectionCapacity} slots are available to this selection`,
        );
      }
      return taskIds.map((taskId) => availableTasksById.get(taskId)!);
    }

    if (
      report.outcome === "wait_for_active_tasks" &&
      !snapshot.tasks.some(hasOngoingTaskExecution)
    ) {
      throw new WorkflowConflictError(
        "wait_for_active_tasks requires at least one ongoing task",
      );
    }
    return [];
  }

  private async blockTaskForMissingReport(
    project: Project,
    task: Task,
    reportReminderCount: number,
  ): Promise<Task> {
    const now = this.now();
    const blocked: Task = {
      ...task,
      status: "blocked",
      currentExecution: {
        ...task.currentExecution!,
        status: "failed",
        reportReminderCount,
        turnCompletedAt: now,
        finishedAt: now,
      },
      updatedAt: now,
    };
    await this.store.saveTask(project.id, blocked);
    await this.recordEvent({
      type: "turn.failed",
      projectId: project.id,
      taskId: task.id,
      attemptId: task.currentExecution!.attemptId,
      ...(task.currentExecution?.threadId
        ? { threadId: task.currentExecution.threadId }
        : {}),
      ...(task.currentExecution?.turnId
        ? { turnId: task.currentExecution.turnId }
        : {}),
      reason: "missing_report",
      before: taskLifecycleState(task),
      after: taskLifecycleState(blocked),
    });
    await this.recordTaskLifecycleActivity(
      project,
      blocked,
      "execution_failed",
      "任务对话结束后未提交有效汇报。",
      now,
    );
    return blocked;
  }

  private async startReplacementTaskExecution(
    project: Project,
    current: Task,
  ): Promise<Task> {
    const execution = current.currentExecution;
    const restartable: Task = execution
      ? {
          ...current,
          currentExecution: {
            ...execution,
            status: "interrupted",
            finishedAt: this.now(),
          },
        }
      : current;
    const dispatched = await this.dispatchTask(project, restartable, current);
    return dispatched ? (await this.requireTask(current.id)).task : current;
  }

  private async cancelTaskInternal(
    project: Project,
    task: Task,
    cancellation: NonNullable<Task["cancellation"]>,
  ): Promise<Task> {
    if (["done", "cancelled"].includes(task.status)) return task;
    const now = cancellation.cancelledAt;
    const execution = task.currentExecution;
    const wasActive = execution
      ? activeExecutionStatuses.has(execution.status)
      : false;
    const cancelled: Task = {
      ...task,
      status: "cancelled",
      requestedAction: null,
      cancellation,
      ...(execution
        ? {
            currentExecution: {
              ...execution,
              status: "interrupted" as const,
              finishedAt: now,
            },
          }
        : {}),
      updatedAt: cancellation.cancelledAt,
    };
    await this.store.saveTask(project.id, cancelled);
    await this.recordEvent({
      type: "task.cancelled",
      projectId: project.id,
      taskId: task.id,
      ...(execution ? { attemptId: execution.attemptId } : {}),
      ...(execution?.threadId ? { threadId: execution.threadId } : {}),
      ...(execution?.turnId ? { turnId: execution.turnId } : {}),
      reason: cancellation.reason,
      before: taskLifecycleState(task),
      after: taskLifecycleState(cancelled),
      data: {
        cancelledBy: cancellation.cancelledBy,
        decisionBasis: cancellation.decisionBasis,
      },
    });
    await this.recordTaskLifecycleActivity(
      project,
      cancelled,
      "cancelled",
      cancellation.reason,
      now,
      {
        reason: cancellation.reason,
        decisionBasis: cancellation.decisionBasis,
      },
    );
    if (wasActive && execution?.threadId && execution.turnId) {
      try {
        await this.dispatcher.interrupt(await this.taskDispatchRequest(project, task));
      } catch (error) {
        await this.recordEvent({
          type: "turn.interrupt_failed",
          projectId: project.id,
          taskId: task.id,
          attemptId: execution.attemptId,
          data: { message: error instanceof Error ? error.message : String(error) },
        });
      }
    }
    return cancelled;
  }

  private async taskDispatchRequest(
    project: Project,
    task: Task,
  ): Promise<DispatchRequest> {
    return {
      project,
      task,
      activity: projectTaskActivities(
        await this.store.listTaskActivities(project.id, task.id),
      ),
    };
  }

  private async recordTaskLifecycleActivity(
    project: Project,
    task: Task,
    type: "execution_failed" | "cancelled",
    summary: string,
    occurredAt: string,
    evidence?: NonNullable<TaskActivity["evidence"]>,
  ): Promise<void> {
    const execution = task.currentExecution;
    const activity = createTaskLifecycleActivity({
      activityId: this.createId("activity"),
      projectId: project.id,
      taskId: task.id,
      type,
      summary,
      occurredAt,
      ...(execution?.attemptId ? { attemptId: execution.attemptId } : {}),
      ...(execution?.action ? { action: execution.action } : {}),
      ...(execution?.threadId ? { threadId: execution.threadId } : {}),
      ...(evidence ? { evidence } : {}),
    });
    await this.recordEvent({
      type: "task.activity_recorded",
      projectId: project.id,
      taskId: task.id,
      ...(execution?.attemptId ? { attemptId: execution.attemptId } : {}),
      ...(execution?.threadId ? { threadId: execution.threadId } : {}),
      data: { activity },
    });
  }

  private async revisePlanning(
    projectId: string,
    reason:
      | "task_completed"
      | "task_cancelled"
      | "concurrency_changed"
      | "manual_replan",
  ): Promise<Project> {
    const snapshot = await this.requireSnapshot(projectId);
    let current = snapshot.project;
    const execution = current.currentExecution;
    if (
      execution?.action === "select_tasks" &&
      activeExecutionStatuses.has(execution.status)
    ) {
      current = await this.requireProjectExecutions().cancel(current);
      await this.recordEvent({
        type: "project.selection_superseded",
        projectId,
        attemptId: execution.attemptId,
        before: projectLifecycleState(snapshot.project),
        after: projectLifecycleState(current),
        data: {
          planningRevision: execution.planningRevision ?? current.planning.revision,
          reason,
        },
      });
    }

    const revised: Project = {
      ...current,
      status: current.status === "cancelled" ? "cancelled" : "active",
      requestedAction:
        current.currentExecution?.action === "select_tasks" ? null : current.requestedAction,
      planning: advancePlanning(
        current.planning,
        reason,
        this.now(),
        this.maxConcurrentTasks,
      ),
      updatedAt: this.now(),
    };
    await this.store.saveProject(revised);
    await this.recordPlanningRevision(revised, snapshot.project.planning.revision);
    return revised;
  }

  private recordPlanningRevision(
    project: Project,
    previousRevision: number,
  ): Promise<unknown> {
    return this.recordEvent({
      type: "project.planning_revision_advanced",
      projectId: project.id,
      before: { status: project.status },
      after: { status: project.status },
      data: {
        previousRevision,
        planningRevision: project.planning.revision,
        reason: project.planning.changeReason,
      },
    });
  }

  private async requireTask(taskId: string): Promise<{ project: Project; task: Task }> {
    const found = await this.store.findTask(taskId);
    if (!found) throw new Error(`Task ${taskId} was not found`);
    return found;
  }

  private async requireTaskActivity(
    projectId: string,
    taskId: string,
    activityId: string,
  ): Promise<TaskActivity> {
    const activity = (await this.store.listTaskActivities(projectId, taskId)).find(
      ({ id }) => id === activityId,
    );
    if (!activity) throw new Error(`Task activity ${activityId} was not found`);
    return activity;
  }

  private async requireSnapshot(projectId: string): Promise<ProjectSnapshot> {
    const snapshot = await this.store.getProject(projectId);
    if (!snapshot) throw new Error(`Project ${projectId} was not found`);
    return snapshot;
  }

  private async commandTarget(
    command: CodriveCommand,
  ): Promise<{ projectId?: string; taskId?: string }> {
    if ("projectId" in command.payload) {
      return (await this.store.getProject(command.payload.projectId))
        ? { projectId: command.payload.projectId }
        : {};
    }
    if ("taskId" in command.payload) {
      const found = await this.store.findTask(command.payload.taskId);
      return {
        ...(found ? { projectId: found.project.id } : {}),
        taskId: command.payload.taskId,
      };
    }
    return {};
  }

  private async recordRecoverySuppressed(
    projectId: string,
    task: Task,
    expectedAttemptId: string,
    reason: string,
  ): Promise<void> {
    const execution = task.currentExecution;
    await this.recordEvent({
      type: "recovery.execution_suppressed",
      component: "recovery",
      projectId,
      taskId: task.id,
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

  private requireProjectExecutions(): ProjectExecutionCoordinator {
    if (!this.projectExecutions) {
      throw new Error("Project execution is not configured");
    }
    return this.projectExecutions;
  }

  private recordEvent(
    event: Omit<CodriveEvent, "eventId" | "occurredAt">,
  ): Promise<unknown> {
    return this.lifecycle.record(event);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operation.then(operation, operation);
    this.operation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private leaseExpiration(): string {
    return new Date(Date.parse(this.now()) + this.executionLeaseMs).toISOString();
  }
}

function canDispatchTask(task: Task): boolean {
  if (!task.requestedAction) return false;
  if (task.status === "blocked") return false;
  if (!task.currentExecution) return true;
  return task.currentExecution.status === "completed";
}

function hasActiveTaskExecution(task: Task): boolean {
  return task.currentExecution
    ? activeExecutionStatuses.has(task.currentExecution.status)
    : false;
}

function hasOngoingTaskExecution(task: Task): boolean {
  return task.currentExecution
    ? reportableExecutionStatuses.has(task.currentExecution.status)
    : false;
}

function hasActiveProjectExecution(project: Project): boolean {
  return project.currentExecution
    ? activeExecutionStatuses.has(project.currentExecution.status)
    : false;
}

function countActiveTasks(tasks: Task[]): number {
  return tasks.filter(hasActiveTaskExecution).length;
}

function activeIntegrationRepositories(snapshots: ProjectSnapshot[]): Set<string> {
  return new Set(
    snapshots.flatMap(({ project, tasks }) =>
      tasks.some(
        ({ currentExecution }) =>
          currentExecution?.action === "integrate" &&
          integrationLeaseStatuses.has(currentExecution.status),
      )
        ? [resolve(project.repositoryPath)]
        : [],
    ),
  );
}

function availableProjectPlanningCapacity(
  snapshot: ProjectSnapshot,
  concurrencyLimit: number,
): number {
  const reservedDevelopTasks = snapshot.tasks
    .filter(
      ({ status, requestedAction }) =>
        status === "backlog" && requestedAction === "develop",
    ).length;
  return Math.max(
    0,
    concurrencyLimit - countActiveTasks(snapshot.tasks) - reservedDevelopTasks,
  );
}

function projectConcurrencyLimit(project: Project, fallback: number): number {
  return project.planning.concurrencyLimit ?? fallback;
}

function compareTaskDispatchCandidates(
  left: { project: Project; task: Task },
  right: { project: Project; task: Task },
): number {
  const actionPriority = (task: Task) => (task.requestedAction === "develop" ? 1 : 0);
  return (
    actionPriority(left.task) - actionPriority(right.task) ||
    left.task.updatedAt.localeCompare(right.task.updatedAt) ||
    left.project.id.localeCompare(right.project.id) ||
    left.task.order - right.task.order ||
    left.task.id.localeCompare(right.task.id)
  );
}

function comparePlanningCandidates(
  left: ProjectSnapshot,
  right: ProjectSnapshot,
): number {
  return (
    left.project.planning.changedAt.localeCompare(right.project.planning.changedAt) ||
    left.project.id.localeCompare(right.project.id)
  );
}

function completedProjectExecution(
  project: Project,
  now: string,
): NonNullable<Project["currentExecution"]> {
  return {
    ...project.currentExecution!,
    status: "completed",
    finishedAt: now,
  };
}

function eventForTask(task: Task): string {
  switch (task.status) {
    case "reviewing":
      return "task.review_requested";
    case "changes_requested":
      return "task.changes_requested";
    case "integrating":
      return "task.approved";
    case "done":
      return "task.completed";
    case "waiting_for_input":
      return "task.waiting_for_input";
    default:
      return "task.updated";
  }
}

function commandSummary(command: CodriveCommand): Record<string, unknown> {
  const summary: Record<string, unknown> = { commandType: command.type };
  if ("action" in command.payload) summary.action = command.payload.action;
  if ("decisionBasis" in command.payload) {
    summary.decisionBasis = command.payload.decisionBasis;
  }
  if ("outcome" in command.payload) summary.outcome = command.payload.outcome;
  if ("tasks" in command.payload) {
    summary.taskCount = command.payload.tasks.length;
  }
  if (command.type === "project.record_decision") {
    summary.updatesProductDocument = Boolean(command.payload.productDocument);
  }
  return summary;
}

function cancellationInput(
  payload: Pick<CancellationInput, "decisionBasis" | "reason">,
  source: LifecycleEventSource,
): CancellationInput {
  return {
    cancelledBy: source === "skill" ? "codex" : "user",
    decisionBasis: payload.decisionBasis,
    reason: requireCancellationReason(payload.reason),
  };
}

function requireCancellationReason(reason: string): string {
  const normalized = reason.trim();
  if (!normalized) {
    throw new WorkflowConflictError("Cancellation requires a reason");
  }
  return normalized;
}

function commandResultTarget(result: unknown): {
  projectId?: string;
  taskId?: string;
} {
  if (!result || typeof result !== "object") return {};
  if (
    "project" in result &&
    result.project &&
    typeof result.project === "object" &&
    "id" in result.project &&
    typeof result.project.id === "string"
  ) {
    return { projectId: result.project.id };
  }
  if ("projectId" in result && typeof result.projectId === "string") {
    return {
      projectId: result.projectId,
      ...( "id" in result && typeof result.id === "string"
        ? { taskId: result.id }
        : {}),
    };
  }
  if ("id" in result && typeof result.id === "string") {
    return { projectId: result.id };
  }
  return {};
}
