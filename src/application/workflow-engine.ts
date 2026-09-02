import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  InvalidTaskReportError,
  WorkflowConflictError,
} from "../domain/errors.js";
import {
  findProjectArchiveBlocker,
  isProjectArchived,
  projectCanSchedule,
  type ProjectArchiveBlocker,
} from "../domain/project.js";
import { advancePlanning, markPlanningEvaluated } from "../domain/planning.js";
import { hasProductFacts } from "../domain/product-facts.js";
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
  ExecutionStatus,
  Project,
  ProjectControlAction,
  ProductDocumentChange,
  ProjectReport,
  ProjectSnapshot,
  Task,
  TaskActivity,
  TaskDefinitionChanges,
  TaskExecutionIdentity,
  TaskReport,
  UpdateTaskDefinitionInput,
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
import {
  activeIntegrationRepositories,
  findCompetingIntegrationLease,
} from "./integration-lease.js";
import { ProjectExecutionCoordinator } from "./project-execution-coordinator.js";
import type { ProjectExecutor } from "./project-executor.js";
import type { RepositoryPathResolver } from "./repository-path-resolver.js";
import type { DispatchRequest, TaskDispatcher } from "./task-dispatcher.js";
import {
  type CodexTurnFailure,
  defaultModelCapacityRetryDelaysMs,
  defaultModelCapacityRetryResetAfterMs,
  defaultModelPrimaryProbeAfterMs,
  initialModelRouting,
  isModelCapacityFailure,
  isRetryDue,
  markRetryStarted,
  planModelCapacityRecovery,
  prepareModelRoutingForTurn,
  resetCapacityFailuresAfterStableTurn,
} from "./model-routing.js";

export interface WorkflowEngineOptions {
  maxConcurrentTasks: number;
  models: ModelRoutingSettings;
  modelCapacityRetryDelaysMs?: readonly number[];
  modelCapacityRetryResetAfterMs?: number;
  modelPrimaryProbeAfterMs?: number;
  executionLeaseMs?: number;
  now?: () => string;
  createId?: (prefix: string) => string;
}

interface TaskTurnRecovery {
  resumePersistedThread: true;
  recoveredTurnId?: string;
  previousTask?: Task;
}

interface AcceptedProductDocumentChange {
  decisionSummary: string;
  digest: string;
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
  "waiting_for_resume",
]);
const reportSubmissionStatuses = new Set([
  "pending",
  "running",
  "awaiting_report",
  "waiting_for_input",
]);
export class WorkflowEngine {
  readonly lifecycle: LifecycleRecorder;
  private readonly now: () => string;
  private readonly createId: (prefix: string) => string;
  private readonly executionLeaseMs: number;
  private readonly modelCapacityRetryDelaysMs: readonly number[];
  private readonly modelCapacityRetryResetAfterMs: number;
  private readonly modelPrimaryProbeAfterMs: number;
  private maxConcurrentTasks: number;
  private models: ModelRoutingSettings;
  private readonly projectExecutions: ProjectExecutionCoordinator | undefined;
  private operation: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly store: ProjectStore,
    private readonly dispatcher: TaskDispatcher,
    private readonly options: WorkflowEngineOptions,
    private readonly repositoryPaths: RepositoryPathResolver,
    projectExecutor?: ProjectExecutor,
    lifecycle?: LifecycleRecorder,
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.createId = options.createId ?? ((prefix) => `${prefix}_${randomUUID()}`);
    this.executionLeaseMs = options.executionLeaseMs ?? 6 * 60 * 60 * 1000;
    this.modelCapacityRetryDelaysMs =
      options.modelCapacityRetryDelaysMs ?? defaultModelCapacityRetryDelaysMs;
    this.modelCapacityRetryResetAfterMs =
      options.modelCapacityRetryResetAfterMs ??
      defaultModelCapacityRetryResetAfterMs;
    this.modelPrimaryProbeAfterMs =
      options.modelPrimaryProbeAfterMs ?? defaultModelPrimaryProbeAfterMs;
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
          modelSettings: (project) => this.modelSettingsFor(project),
          modelCapacityRetryDelaysMs: this.modelCapacityRetryDelaysMs,
          modelCapacityRetryResetAfterMs: this.modelCapacityRetryResetAfterMs,
          modelPrimaryProbeAfterMs: this.modelPrimaryProbeAfterMs,
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
          command.payload.productDocumentChange,
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
      case "project.update_product_document":
        return this.updateProductDocument(
          command.payload.projectId,
          command.payload,
        );
      case "task.update_definition":
        return this.updateTaskDefinition(command.payload);
      case "task.control":
        switch (command.payload.action) {
          case "retry":
            return this.retryTask(command.payload.taskId);
          case "continue":
            return this.continueTaskNow(command.payload.taskId);
          case "reschedule":
            return this.rescheduleTaskResume(
              command.payload.taskId,
              command.payload.resumeAt,
            );
          case "cancel":
            return this.cancelTask(
              command.payload.taskId,
              cancellationInput(command.payload, source),
            );
        }
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
    if (
      !snapshot ||
      !projectCanSchedule(snapshot.project) ||
      !(await this.productDocumentIsCurrent(snapshot.project))
    ) {
      return 0;
    }
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

  async readProjectModelConfig(
    projectId: string,
  ): Promise<ModelRoutingSettings | null> {
    const snapshot = await this.requireSnapshot(projectId);
    return snapshot.project.modelConfig ?? null;
  }

  updateProjectModelConfig(
    projectId: string,
    modelConfig: ModelRoutingSettings | null,
  ): Promise<Project> {
    return this.enqueue(async () => {
      const snapshot = await this.requireSnapshot(projectId);
      const current = snapshot.project.modelConfig ?? null;
      if (
        current?.primary === modelConfig?.primary &&
        current?.fallback === modelConfig?.fallback
      ) {
        return snapshot.project;
      }

      const updated: Project = {
        ...snapshot.project,
        ...(modelConfig ? { modelConfig } : {}),
        updatedAt: this.now(),
      };
      if (!modelConfig) delete updated.modelConfig;
      await this.store.saveProject(updated);
      await this.recordEvent({
        type: "project.model_config_updated",
        projectId,
        before: projectLifecycleState(snapshot.project),
        after: projectLifecycleState(updated),
        data: {
          source: modelConfig ? "project" : "global",
          ...(modelConfig
            ? {
                primaryModel: modelConfig.primary,
                fallbackModel: modelConfig.fallback,
              }
            : {}),
        },
      });
      return updated;
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
    productDocumentChange: ProductDocumentChange,
  ): Promise<ProjectSnapshot> {
    return this.enqueue(async () => {
      const snapshot = await this.requireSnapshot(projectId);
      if (snapshot.project.status === "cancelled") {
        throw new WorkflowConflictError(`Cancelled project ${projectId} cannot accept work`);
      }
      const acceptedDocument = await this.acceptProductDocumentChange(
        snapshot.project,
        productDocumentChange,
      );
      await this.store.addTasks(projectId, tasks);
      const currentProject = hasActiveProjectExecution(snapshot.project)
        ? await this.requireProjectExecutions().cancel(snapshot.project)
        : snapshot.project;
      const changedAt = this.now();
      const project: Project = {
        ...currentProject,
        productFacts: {
          revision: currentProject.productFacts.revision + 1,
          digest: acceptedDocument.digest,
          changedAt,
        },
        status: "active",
        requestedAction: null,
        planning: advancePlanning(
          currentProject.planning,
          "work_added",
          changedAt,
          this.maxConcurrentTasks,
        ),
        updatedAt: changedAt,
      };
      await this.store.saveProject(project);
      await this.recordProductDocumentChange(
        snapshot.project,
        project,
        acceptedDocument,
      );
      await this.recordSupersededSelection(snapshot.project, project, "work_added");
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

  ensureSemanticAtlasMaintenanceTask(
    projectId: string,
    repositoryPath: string,
  ): Promise<Task> {
    return this.enqueue(async () => {
      const snapshot = await this.requireSnapshot(projectId);
      const targetRepositoryPath = resolve(repositoryPath);
      const openTask = snapshot.tasks.find((task) =>
        task.origin?.kind === "semantic_atlas_maintenance" &&
        resolve(
          task.origin.repositoryPath ?? snapshot.project.repositoryPath,
        ) === targetRepositoryPath &&
        !["done", "cancelled"].includes(task.status)
      );
      if (openTask) return openTask;
      if (snapshot.project.status === "cancelled") {
        throw new WorkflowConflictError(
          `Cancelled project ${projectId} cannot accept Semantic Atlas maintenance`,
        );
      }

      const createdTasks = await this.store.addTasks(projectId, [{
        title: "维护业务地图",
        description:
          `使用 $semantic-atlas-maintenance 处理目标仓库 ${targetRepositoryPath} 的可行动候选。` +
          "工作阶段选择一个业务域并准备地图改动或证据结论，独立审查后在合入阶段记录维护结果。",
        acceptanceCriteria: [
          "只在目标仓库中选择一个业务域并核实当前证据。",
          "地图改动至多涉及一个 owning YAML，并通过完整验证与独立审查。",
          "合入阶段收到 Semantic Atlas recorded 或 idempotent 回执后才能完成。",
        ],
        origin: {
          kind: "semantic_atlas_maintenance" as const,
          repositoryPath: targetRepositoryPath,
        },
      }]);
      const createdTask = createdTasks[0]!;
      const currentProject = hasActiveProjectExecution(snapshot.project)
        ? await this.requireProjectExecutions().cancel(snapshot.project)
        : snapshot.project;
      const changedAt = this.now();
      const project: Project = {
        ...currentProject,
        status: "active",
        requestedAction: null,
        planning: advancePlanning(
          currentProject.planning,
          "system_work_added",
          changedAt,
          this.maxConcurrentTasks,
        ),
        updatedAt: changedAt,
      };
      await this.store.saveProject(project);
      await this.recordSupersededSelection(
        snapshot.project,
        project,
        "system_work_added",
      );
      await this.recordEvent({
        type: "project.system_work_added",
        projectId,
        taskId: createdTask.id,
        before: projectLifecycleState(snapshot.project),
        after: projectLifecycleState(project),
        data: { source: "semantic_atlas" },
      });
      await this.recordPlanningRevision(project, snapshot.project.planning.revision);
      await this.reconcileInternal();
      return createdTask;
    });
  }

  updateProductDocument(
    projectId: string,
    change: ProductDocumentChange,
  ): Promise<Project> {
    return this.enqueue(async () => {
      const snapshot = await this.requireSnapshot(projectId);
      if (snapshot.project.status === "cancelled") {
        throw new WorkflowConflictError(
          `Cancelled project ${projectId} cannot update product facts`,
        );
      }
      const acceptedDocument = await this.acceptProductDocumentChange(
        snapshot.project,
        change,
      );
      const currentProject = hasActiveProjectExecution(snapshot.project)
        ? await this.requireProjectExecutions().cancel(snapshot.project)
        : snapshot.project;
      const changedAt = this.now();
      const project: Project = {
        ...currentProject,
        productFacts: {
          revision: currentProject.productFacts.revision + 1,
          digest: acceptedDocument.digest,
          changedAt,
        },
        status: "active",
        requestedAction: null,
        planning: advancePlanning(
          currentProject.planning,
          "product_document_updated",
          changedAt,
          this.maxConcurrentTasks,
        ),
        updatedAt: changedAt,
      };
      await this.store.saveProject(project);
      await this.recordProductDocumentChange(
        snapshot.project,
        project,
        acceptedDocument,
      );
      await this.recordSupersededSelection(
        snapshot.project,
        project,
        project.planning.changeReason,
      );
      await this.recordPlanningRevision(project, snapshot.project.planning.revision);
      await this.reconcileInternal();
      return (await this.requireSnapshot(projectId)).project;
    });
  }

  updateTaskDefinition(
    input: UpdateTaskDefinitionInput,
  ): Promise<ProjectSnapshot> {
    return this.enqueue(async () => {
      const found = await this.requireTask(input.taskId);
      const { project, task } = found;
      const { decisionSummary, changedFields } = validateTaskDefinitionUpdate(
        project,
        task,
        input,
      );
      const acceptedDocument = await this.acceptTaskDefinitionProductFacts(
        project,
        input,
        decisionSummary,
      );

      const currentProject = hasActiveProjectExecution(project)
        ? await this.requireProjectExecutions().cancel(project)
        : project;
      const changedAt = this.now();
      const updatedTask = applyTaskDefinitionChanges(task, input.changes, changedAt);
      const updatedProject: Project = {
        ...currentProject,
        ...(acceptedDocument
          ? {
              productFacts: {
                revision: currentProject.productFacts.revision + 1,
                digest: acceptedDocument.digest,
                changedAt,
              },
            }
          : {}),
        status: "active",
        requestedAction: null,
        planning: advancePlanning(
          currentProject.planning,
          "task_definition_updated",
          changedAt,
          this.maxConcurrentTasks,
        ),
        updatedAt: changedAt,
      };

      await this.store.saveTask(project.id, updatedTask);
      await this.store.saveProject(updatedProject);
      if (acceptedDocument) {
        await this.recordProductDocumentChange(
          project,
          updatedProject,
          acceptedDocument,
        );
      }
      await this.recordEvent({
        type: "task.definition_updated",
        projectId: project.id,
        taskId: task.id,
        decision: decisionSummary,
        before: taskLifecycleState(task),
        after: taskLifecycleState(updatedTask),
        data: {
          changedFields,
          previousUpdatedAt: task.updatedAt,
          updatedAt: updatedTask.updatedAt,
          ...(acceptedDocument
            ? { productDocumentRevision: updatedProject.productFacts.revision }
            : {}),
        },
      });
      await this.recordSupersededSelection(
        project,
        updatedProject,
        updatedProject.planning.changeReason,
      );
      await this.recordPlanningRevision(
        updatedProject,
        project.planning.revision,
      );
      await this.reconcileInternal();
      return this.requireSnapshot(project.id);
    });
  }

  private async acceptTaskDefinitionProductFacts(
    project: Project,
    input: UpdateTaskDefinitionInput,
    decisionSummary: string,
  ): Promise<AcceptedProductDocumentChange | undefined> {
    if (input.productDocumentChange) {
      return this.acceptProductDocumentChange(project, {
        decisionSummary,
        ...input.productDocumentChange,
      });
    }
    if (await this.productDocumentIsCurrent(project)) return undefined;
    throw new WorkflowConflictError(
      "PROJECT.md has unrecorded changes; include productDocumentChange with the task definition update",
    );
  }

  submitReport(report: TaskReport): Promise<Task> {
    return this.enqueue(async () => {
      const found = await this.requireTask(report.taskId);
      const execution = found.task.currentExecution;
      const activities = await this.store.listTaskActivities(
        found.project.id,
        report.taskId,
      );
      if (
        execution?.attemptId === report.attemptId &&
        (!execution.reportOpportunityId ||
          !report.reportOpportunityId ||
          execution.reportOpportunityId !== report.reportOpportunityId)
      ) {
        throw new WorkflowConflictError(
          `Report opportunity does not match the current execution for ${report.taskId}`,
        );
      }
      const previousActivity = reportActivityForIdempotency(activities, report);
      if (previousActivity) {
        if (taskActivityMatchesReport(previousActivity, report)) return found.task;
        throw new WorkflowConflictError(
          `Report conflicts with the recorded result for ${report.taskId}`,
        );
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
      validateTaskReport(found.task, report, this.now());
      validateBoundWorkReport(execution, activities, report);

      const repositoryPath = await this.repositoryPathForReport(
        found.task,
        execution,
        activities,
        report,
      );

      const activity = createTaskReportActivity({
        activityId: this.createId("activity"),
        projectId: found.project.id,
        action: execution.action,
        report,
        ...(execution.workActivityId
          ? { workActivityId: execution.workActivityId }
          : {}),
        ...(execution.threadId ? { threadId: execution.threadId } : {}),
        ...(repositoryPath ? { repositoryPath } : {}),
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
        const completed = await this.finalizeTaskReport(
          found.project,
          task,
          report,
          activity.occurredAt,
        );
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
        return this.finalizeSubmittedTaskReport(found.project, found.task);
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
      if (!projectCanSchedule(found.project)) {
        throw new WorkflowConflictError(
          `Project ${found.project.id} must be restored and resumed before task ${taskId} can retry`,
        );
      }
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

  continueTaskNow(taskId: string): Promise<Task> {
    return this.enqueue(async () => {
      const found = await this.requireScheduledTaskResume(taskId);
      const now = this.now();
      const schedule = resetScheduledWakeAttempt(
        found.task.currentExecution!.scheduledResume!,
        now,
      );
      const task = {
        ...found.task,
        currentExecution: {
          ...found.task.currentExecution!,
          scheduledResume: schedule,
        },
        updatedAt: now,
      };
      await this.store.saveTask(found.project.id, task);
      await this.recordEvent({
        type: "task.scheduled_resume_requested",
        projectId: found.project.id,
        taskId,
        attemptId: task.currentExecution!.attemptId,
        ...(task.currentExecution!.threadId
          ? { threadId: task.currentExecution!.threadId }
          : {}),
        before: taskLifecycleState(found.task),
        after: taskLifecycleState(task),
        data: { resumeAt: now, trigger: "manual" },
      });
      await this.reconcileInternal();
      return (await this.requireTask(taskId)).task;
    });
  }

  rescheduleTaskResume(taskId: string, resumeAt: string): Promise<Task> {
    return this.enqueue(async () => {
      const found = await this.requireScheduledTaskResume(taskId);
      const normalizedResumeAt = requireFutureRfc3339(resumeAt, this.now());
      const execution = found.task.currentExecution!;
      const previousResumeAt = execution.scheduledResume!.resumeAt;
      const schedule = resetScheduledWakeAttempt(
        execution.scheduledResume!,
        normalizedResumeAt,
      );
      const task: Task = {
        ...found.task,
        currentExecution: {
          ...execution,
          scheduledResume: schedule,
        },
        updatedAt: this.now(),
      };
      await this.store.saveTask(found.project.id, task);
      await this.recordEvent({
        type: "task.scheduled_resume_rescheduled",
        projectId: found.project.id,
        taskId,
        attemptId: execution.attemptId,
        ...(execution.threadId ? { threadId: execution.threadId } : {}),
        before: taskLifecycleState(found.task),
        after: taskLifecycleState(task),
        data: { previousResumeAt, resumeAt: normalizedResumeAt },
      });
      await this.recordTaskLifecycleActivity(
        found.project,
        task,
        "scheduled_resume_rescheduled",
        "计划恢复时间已重新安排。",
        this.now(),
        { resumeAt: normalizedResumeAt },
      );
      return task;
    });
  }

  recoverTask(taskId: string, expectedAttemptId: string): Promise<Task> {
    return this.enqueue(async () => {
      const found = await this.requireTask(taskId);
      if (!found.task.requestedAction) return found.task;
      if (!projectCanSchedule(found.project)) {
        await this.recordRecoverySuppressed(
          found.project.id,
          found.task,
          expectedAttemptId,
          isProjectArchived(found.project)
            ? "project_archived"
            : found.project.scheduling !== "running"
              ? "project_paused"
              : "project_not_active",
        );
        return found.task;
      }
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
        if (execution.reportReminderCount) {
          return this.continueTaskReportRequest(
            found.project,
            found.task,
            execution.threadId ? { resumePersistedThread: true } : undefined,
          );
        }
        return this.continueTaskDispatch(
          found.project,
          found.task,
          execution.threadId ? { resumePersistedThread: true } : undefined,
        );
      }
      if (
        execution.status === "awaiting_report" &&
        (execution.turnCompletedAt || !execution.turnId)
      ) {
        return this.continueTaskReportRequest(
          found.project,
          found.task,
          execution.threadId ? { resumePersistedThread: true } : undefined,
        );
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

  resumeTaskAfterInterruption(target: TaskExecutionIdentity): Promise<Task> {
    return this.enqueue(async () => {
      const found = await this.requireTask(target.taskId);
      const execution = found.task.currentExecution;
      if (!matchesRecoveryTarget(found.project.id, found.task, target)) {
        await this.recordRecoverySuppressed(
          found.project.id,
          found.task,
          target.attemptId,
          "execution_changed",
        );
        return found.task;
      }
      if (execution?.submittedActivityId) {
        // A report is the turn's final side effect, so its persisted result wins over a later interruption.
        return this.finalizeSubmittedTaskReport(found.project, found.task);
      }
      if (
        !projectCanSchedule(found.project) ||
        found.task.status === "blocked" ||
        !found.task.requestedAction
      ) {
        await this.recordRecoverySuppressed(
          found.project.id,
          found.task,
          target.attemptId,
          isProjectArchived(found.project)
            ? "project_archived"
            : found.project.scheduling !== "running"
              ? "project_paused"
              : "task_no_longer_active",
        );
        return found.task;
      }
      const snapshots = await this.store.listProjects();
      const snapshot = snapshots.find(
        ({ project }) => project.id === found.project.id,
      );
      if (
        !snapshot ||
        countActiveTasks(snapshot.tasks) >
          projectConcurrencyLimit(found.project, this.maxConcurrentTasks)
      ) {
        await this.recordRecoverySuppressed(
          found.project.id,
          found.task,
          target.attemptId,
          "project_capacity_unavailable",
        );
        return found.task;
      }
      if (
        execution!.action === "integrate" &&
        findCompetingIntegrationLease(snapshots, found.project, found.task.id)
      ) {
        await this.recordRecoverySuppressed(
          found.project.id,
          found.task,
          target.attemptId,
          "repository_integration_unavailable",
        );
        return found.task;
      }
      if (!execution?.threadId) {
        return this.blockTaskAfterRecoveryFailure(
          found.project,
          found.task,
          "任务执行中断后缺少可恢复的原对话。",
        );
      }

      const now = this.now();
      const modelRouting = resetCapacityFailuresAfterStableTurn(
        execution.modelRouting,
        execution.turnStartedAt,
        new Date(now),
        this.modelCapacityRetryResetAfterMs,
      );
      const pending: Task = {
        ...found.task,
        currentExecution: {
          ...execution,
          status: execution.reportReminderCount ? "awaiting_report" : "pending",
          modelRouting,
          leaseExpiresAt: this.leaseExpiration(),
        },
        updatedAt: now,
      };
      delete pending.currentExecution?.turnId;
      delete pending.currentExecution?.turnStartedAt;
      delete pending.currentExecution?.turnCompletedAt;
      delete pending.currentExecution?.finishedAt;
      const recovery = {
        resumePersistedThread: true,
        ...(execution.turnId ? { recoveredTurnId: execution.turnId } : {}),
        previousTask: found.task,
      } as const;
      return execution.reportReminderCount
        ? this.continueTaskReportRequest(found.project, pending, recovery)
        : this.continueTaskDispatch(found.project, pending, recovery);
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
      if (!projectCanSchedule(snapshot.project)) {
        throw new WorkflowConflictError(
          `Project ${projectId} must be active, restored, and resumed before its execution can retry`,
        );
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
    action: Exclude<ProjectControlAction, "retry">,
  ): Promise<Project> {
    return this.enqueue(async () => {
      const snapshot = await this.requireSnapshot(projectId);

      if (action === "archive") {
        if (isProjectArchived(snapshot.project)) return snapshot.project;
        const blocker = findProjectArchiveBlocker(snapshot);
        if (blocker) {
          throw new WorkflowConflictError(projectArchiveConflict(blocker));
        }
        const archivedAt = this.now();
        const project: Project = {
          ...snapshot.project,
          scheduling: "paused",
          archivedAt,
          updatedAt: archivedAt,
        };
        await this.store.saveProject(project);
        await this.recordEvent({
          type: "project.archived",
          projectId,
          before: projectLifecycleState(snapshot.project),
          after: projectLifecycleState(project),
        });
        return project;
      }

      if (action === "unarchive") {
        if (!isProjectArchived(snapshot.project)) return snapshot.project;
        const { archivedAt, ...projectWithoutArchive } = snapshot.project;
        const project: Project = {
          ...projectWithoutArchive,
          scheduling: "paused",
          updatedAt: this.now(),
        };
        await this.store.saveProject(project);
        await this.recordEvent({
          type: "project.unarchived",
          projectId,
          before: projectLifecycleState(snapshot.project),
          after: projectLifecycleState(project),
          data: { archivedAt },
        });
        return project;
      }

      if (snapshot.project.status === "cancelled") {
        throw new WorkflowConflictError(`Cancelled project ${projectId} is terminal`);
      }

      if (action === "replan") {
        const project = await this.revisePlanning(projectId, "manual_replan");
        await this.reconcileInternal();
        return (await this.requireSnapshot(project.id)).project;
      }

      if (action === "pause" || action === "resume") {
        if (action === "resume" && isProjectArchived(snapshot.project)) {
          throw new WorkflowConflictError(
            `Project ${projectId} must be restored before scheduling can resume`,
          );
        }
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
        const failureTime = new Date(this.now());
        const currentRouting = resetCapacityFailuresAfterStableTurn(
          execution.modelRouting,
          execution.turnStartedAt,
          failureTime,
          this.modelCapacityRetryResetAfterMs,
        );
        const recovery = planModelCapacityRecovery(
          currentRouting,
          failure,
          this.modelSettingsFor(found.project),
          failureTime,
          this.modelCapacityRetryDelaysMs,
          this.modelPrimaryProbeAfterMs,
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

  resumeScheduledTasks(
    now = new Date(this.now()),
    threadId?: string,
    includeDeferred = false,
  ): Promise<void> {
    return this.enqueue(() =>
      this.dispatchScheduledTaskResumes(now, threadId, includeDeferred),
    );
  }

  resetStableModelCapacityFailures(now = new Date(this.now())): Promise<void> {
    return this.enqueue(async () => {
      for (const snapshot of await this.store.listProjects()) {
        const projectExecution = snapshot.project.currentExecution;
        if (
          projectExecution &&
          inFlightExecutionStatuses.has(projectExecution.status)
        ) {
          const modelRouting = resetCapacityFailuresAfterStableTurn(
            projectExecution.modelRouting,
            projectExecution.turnStartedAt,
            now,
            this.modelCapacityRetryResetAfterMs,
          );
          if (modelRouting !== projectExecution.modelRouting) {
            const project: Project = {
              ...snapshot.project,
              currentExecution: { ...projectExecution, modelRouting },
              updatedAt: now.toISOString(),
            };
            await this.store.saveProject(project);
            await this.recordEvent({
              type: "turn.capacity_failures_reset",
              projectId: project.id,
              attemptId: projectExecution.attemptId,
              ...(projectExecution.threadId
                ? { threadId: projectExecution.threadId }
                : {}),
              ...(projectExecution.turnId ? { turnId: projectExecution.turnId } : {}),
              before: projectLifecycleState(snapshot.project),
              after: projectLifecycleState(project),
              data: { scope: "project", modelRoute: modelRouting.route },
            });
          }
        }

        for (const task of snapshot.tasks) {
          const execution = task.currentExecution;
          if (!execution || !inFlightExecutionStatuses.has(execution.status)) {
            continue;
          }
          const modelRouting = resetCapacityFailuresAfterStableTurn(
            execution.modelRouting,
            execution.turnStartedAt,
            now,
            this.modelCapacityRetryResetAfterMs,
          );
          if (modelRouting === execution.modelRouting) continue;
          const current = (await this.requireTask(task.id)).task;
          if (current.currentExecution?.attemptId !== execution.attemptId) continue;
          const reset: Task = {
            ...current,
            currentExecution: { ...current.currentExecution, modelRouting },
            updatedAt: now.toISOString(),
          };
          await this.store.saveTask(snapshot.project.id, reset);
          await this.recordEvent({
            type: "turn.capacity_failures_reset",
            projectId: snapshot.project.id,
            taskId: task.id,
            attemptId: execution.attemptId,
            ...(execution.threadId ? { threadId: execution.threadId } : {}),
            ...(execution.turnId ? { turnId: execution.turnId } : {}),
            before: taskLifecycleState(current),
            after: taskLifecycleState(reset),
            data: { modelRoute: modelRouting.route },
          });
        }
      }
    });
  }

  private async reconcileInternal(): Promise<void> {
    await this.alignPlanningConcurrency();
    await this.dispatchScheduledModelRetries(new Date(this.now()));
    await this.dispatchScheduledTaskResumes(new Date(this.now()));
    await this.dispatchTaskContinuations();
    await this.startPendingTaskSelection();
    await this.markProjectsWithoutWorkIdle();
  }

  private async dispatchScheduledTaskResumes(
    now: Date,
    threadId?: string,
    includeDeferred = false,
  ): Promise<void> {
    const snapshots = await this.store.listProjects();
    const activeCountByProject = new Map(
      snapshots.map(({ project, tasks }) => [project.id, countActiveTasks(tasks)]),
    );
    const integrationLeases = activeIntegrationRepositories(snapshots);
    const candidates = snapshots
      .filter(
        ({ project }) =>
          projectCanSchedule(project),
      )
      .flatMap(({ project, tasks }) =>
        tasks
          .filter((task) =>
            isScheduledTaskResumeDue(task, now, threadId, includeDeferred),
          )
          .map((task) => ({ project, task })),
      )
      .sort(compareScheduledTaskResumes);

    for (const candidate of candidates) {
      const concurrencyLimit = projectConcurrencyLimit(
        candidate.project,
        this.maxConcurrentTasks,
      );
      const activeCount = activeCountByProject.get(candidate.project.id) ?? 0;
      if (activeCount >= concurrencyLimit) continue;

      const current = await this.store.findTask(candidate.task.id);
      if (
        !current ||
        !projectCanSchedule(current.project) ||
        !isScheduledTaskResumeDue(current.task, now, threadId, includeDeferred)
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

      const resumed = await this.startScheduledTaskResume(
        current.project,
        current.task,
      );
      if (!hasActiveTaskExecution(resumed)) continue;
      activeCountByProject.set(current.project.id, activeCount + 1);
      if (current.task.requestedAction === "integrate") {
        integrationLeases.add(repository);
      }
    }
  }

  private async startScheduledTaskResume(
    project: Project,
    task: Task,
  ): Promise<Task> {
    const waitingExecution = task.currentExecution!;
    const schedule = waitingExecution.scheduledResume!;
    if (!waitingExecution.threadId) {
      return this.blockTaskAfterRecoveryFailure(
        project,
        task,
        "计划恢复缺少可继续的原任务对话。",
      );
    }
    const threadId = waitingExecution.threadId;

    try {
      const taskForTurn = this.prepareTaskForTurn(project, task, {
        rotateReportOpportunity: true,
      });
      const execution = taskForTurn.currentExecution!;
      if (taskForTurn !== task) {
        await this.store.saveTask(project.id, taskForTurn);
      }
      const request = await this.taskDispatchRequest(project, taskForTurn);
      await this.dispatcher.resumeThread(request, threadId);
      const dispatch = await this.dispatcher.resumeScheduledTurn(
        request,
        threadId,
        schedule.resumePrompt,
      );
      if (dispatch.status === "conversation_active") {
        const deferred: Task = {
          ...taskForTurn,
          currentExecution: {
            ...execution,
            scheduledResume: { ...schedule, wakeAttemptedAt: this.now() },
          },
          updatedAt: this.now(),
        };
        await this.store.saveTask(project.id, deferred);
        await this.recordEvent({
          type: "task.scheduled_resume_deferred",
          projectId: project.id,
          taskId: task.id,
          attemptId: execution.attemptId,
          threadId,
          decision: "wait_for_conversation_idle",
          before: taskLifecycleState(task),
          after: taskLifecycleState(deferred),
        });
        return deferred;
      }

      const turnStartedAt = this.now();
      const running: Task = {
        ...taskForTurn,
        status: statusForTaskAction(execution.action),
        currentExecution: executionWithoutScheduledResume({
          ...execution,
          status: "running",
          turnId: dispatch.turnId,
          turnStartedAt,
          leaseExpiresAt: this.leaseExpiration(),
        }),
        updatedAt: turnStartedAt,
      };
      delete running.currentExecution?.turnCompletedAt;
      delete running.currentExecution?.finishedAt;
      await this.store.saveTask(project.id, running);
      await this.recordEvent({
        type: "task.scheduled_resume_started",
        projectId: project.id,
        taskId: task.id,
        attemptId: execution.attemptId,
        threadId,
        turnId: dispatch.turnId,
        before: taskLifecycleState(task),
        after: taskLifecycleState(running),
        data: { resumeAt: schedule.resumeAt, trigger: "deadline_or_manual" },
      });
      await this.recordTaskLifecycleActivity(
        project,
        running,
        "scheduled_resume_started",
        "计划等待结束，已在原任务对话中继续执行。",
        turnStartedAt,
        { resumeAt: schedule.resumeAt },
      );
      return running;
    } catch (error) {
      const current = (await this.requireTask(task.id)).task;
      const reason = error instanceof Error ? error.message : String(error);
      return this.blockTaskAfterRecoveryFailure(
        project,
        current,
        `计划恢复失败：${reason}`,
      );
    }
  }

  private async dispatchScheduledModelRetries(now: Date): Promise<void> {
    for (const snapshot of await this.store.listProjects()) {
      if (
        !projectCanSchedule(snapshot.project)
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
      .filter(({ project }) => projectCanSchedule(project))
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
        !projectCanSchedule(current.project)
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
        projectCanSchedule(project) &&
        !hasActiveProjectExecution(project) &&
        project.planning.evaluatedRevision !== project.planning.revision &&
        tasks.some(
          ({ status, requestedAction }) =>
            status === "backlog" && !requestedAction,
        ),
      )
      .sort(comparePlanningCandidates);

    for (const candidate of candidates) {
      const current = await this.requireSnapshot(candidate.project.id);
      if (!(await this.productDocumentIsCurrent(current.project))) continue;
      const capacity = availableProjectPlanningCapacity(
        current,
        projectConcurrencyLimit(
          current.project,
          this.maxConcurrentTasks,
        ),
      );
      if (capacity <= 0) continue;
      await this.projectExecutions.start(
        current.project,
        {
          planningRevision: current.project.planning.revision,
          selectionCapacity: capacity,
        },
      );
    }
  }

  private async markProjectsWithoutWorkIdle(): Promise<void> {
    for (const snapshot of await this.store.listProjects()) {
      const { project, tasks } = snapshot;
      if (
        isProjectArchived(project) ||
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
        !projectCanSchedule(project) ||
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
      if (["review", "integrate"].includes(task.requestedAction ?? "")) {
        const activities = await this.store.listTaskActivities(project.id, task.id);
        const boundWork = activities.find(
          ({ id, type }) => id === task.workActivityId && type === "work_completed",
        );
        if (!boundWork) {
          throw new Error(
            `Task ${task.id} cannot ${task.requestedAction} without its bound work activity`,
          );
        }
      }
      pending = startTaskExecution(
        task,
        attemptId,
        this.createId("report_opportunity"),
        this.now(),
        task.modelRouting ?? initialModelRouting(this.modelSettingsFor(project)),
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

  private async continueTaskDispatch(
    project: Project,
    task: Task,
    recovery?: TaskTurnRecovery,
  ): Promise<Task> {
    const execution = task.currentExecution!;
    const taskForTurn = this.prepareTaskForTurn(project, task);
    if (taskForTurn !== task) {
      await this.store.saveTask(project.id, taskForTurn);
    }
    const request = await this.taskDispatchRequest(project, taskForTurn);
    try {
      let withThread = taskForTurn;
      let threadId = execution.threadId;
      if (!threadId) {
        const conversation = await this.dispatcher.attachConversation(request);
        threadId = conversation.threadId;
        withThread = {
          ...taskForTurn,
          currentExecution: {
            ...taskForTurn.currentExecution!,
            threadId,
          },
          updatedAt: this.now(),
        };
        await this.store.saveTask(project.id, withThread);
        if (conversation.disposition === "created") {
          await this.recordEvent({
            type: "thread.created",
            projectId: project.id,
            taskId: task.id,
            attemptId: execution.attemptId,
            threadId,
            before: taskLifecycleState(taskForTurn),
            after: taskLifecycleState(withThread),
          });
        }
      } else if (recovery?.resumePersistedThread) {
        await this.dispatcher.resumeThread(request, threadId);
      }

      const dispatch = await this.dispatcher.startTurn(
        { ...request, task: withThread },
        threadId,
      );
      if (dispatch.status === "conversation_active") {
        return recovery?.previousTask
          ? this.restoreTaskAfterRecoveryRace(project, recovery.previousTask)
          : withThread;
      }

      const turnId = dispatch.turnId;
      const turnStartedAt = this.now();
      const running: Task = {
        ...withThread,
        currentExecution: {
          ...withThread.currentExecution!,
          status: "running",
          turnId,
          turnStartedAt,
          leaseExpiresAt: this.leaseExpiration(),
        },
        updatedAt: turnStartedAt,
      };
      await this.store.saveTask(project.id, running);
      if (recovery?.previousTask) {
        await this.recordTaskRecoveryStarted(project, recovery.previousTask, running);
      }
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
      if (recovery) {
        await this.recordTaskRecovery(
          project,
          running,
          turnId,
          turnStartedAt,
          recovery.recoveredTurnId,
        );
      }
      return running;
    } catch (error) {
      const current = (await this.requireTask(task.id)).task;
      const now = this.now();
      const reason = error instanceof Error ? error.message : String(error);
      if (recovery) {
        return this.blockTaskAfterRecoveryFailure(
          project,
          current,
          `任务执行恢复失败：${reason}`,
        );
      }
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
    recovery?: TaskTurnRecovery,
  ): Promise<Task> {
    const execution = task.currentExecution!;
    try {
      const taskForTurn = this.prepareTaskForTurn(project, task);
      if (taskForTurn !== task) {
        await this.store.saveTask(project.id, taskForTurn);
      }
      const request = await this.taskDispatchRequest(project, taskForTurn);
      if (recovery?.resumePersistedThread) {
        await this.dispatcher.resumeThread(request, execution.threadId!);
      }
      const dispatch = await this.dispatcher.requestReport(
        request,
        execution.threadId!,
      );
      if (dispatch.status === "conversation_active") {
        return recovery?.previousTask
          ? this.restoreTaskAfterRecoveryRace(project, recovery.previousTask)
          : taskForTurn;
      }

      const turnStartedAt = this.now();
      const reminded: Task = {
        ...taskForTurn,
        currentExecution: {
          ...taskForTurn.currentExecution!,
          status: "awaiting_report",
          turnId: dispatch.turnId,
          turnStartedAt,
          leaseExpiresAt: this.leaseExpiration(),
        },
        updatedAt: turnStartedAt,
      };
      delete reminded.currentExecution?.turnCompletedAt;
      await this.store.saveTask(project.id, reminded);
      if (recovery?.previousTask) {
        await this.recordTaskRecoveryStarted(project, recovery.previousTask, reminded);
      }
      await this.recordEvent({
        type: "turn.started",
        projectId: project.id,
        taskId: task.id,
        attemptId: execution.attemptId,
        ...(execution.threadId ? { threadId: execution.threadId } : {}),
        turnId: dispatch.turnId,
        before: taskLifecycleState(taskForTurn),
        after: taskLifecycleState(reminded),
      });
      if (recovery) {
        await this.recordTaskRecovery(
          project,
          reminded,
          dispatch.turnId,
          turnStartedAt,
          recovery.recoveredTurnId,
        );
      }
      return reminded;
    } catch (error) {
      if (!recovery) throw error;
      const current = (await this.requireTask(task.id)).task;
      const reason = error instanceof Error ? error.message : String(error);
      return this.blockTaskAfterRecoveryFailure(
        project,
        current,
        `任务执行恢复失败：${reason}`,
      );
    }
  }

  private async recordTaskRecovery(
    project: Project,
    task: Task,
    turnId: string,
    occurredAt: string,
    recoveredTurnId?: string,
  ): Promise<void> {
    const execution = task.currentExecution!;
    await this.recordEvent({
      type: "task.execution_recovered",
      projectId: project.id,
      taskId: task.id,
      attemptId: execution.attemptId,
      ...(execution.threadId ? { threadId: execution.threadId } : {}),
      turnId,
      decision: "resume_current_execution",
      result: "turn_started",
      data: { recoveredTurnId: recoveredTurnId ?? null },
    });
    await this.recordTaskLifecycleActivity(
      project,
      task,
      "execution_recovered",
      "服务中断后已在原任务对话中恢复执行。",
      occurredAt,
    );
  }

  private async recordTaskRecoveryStarted(
    project: Project,
    previousTask: Task,
    recoveredTask: Task,
  ): Promise<void> {
    const execution = previousTask.currentExecution!;
    await this.recordEvent({
      type: "task.execution_recovery_started",
      projectId: project.id,
      taskId: previousTask.id,
      attemptId: execution.attemptId,
      ...(execution.threadId ? { threadId: execution.threadId } : {}),
      ...(execution.turnId ? { turnId: execution.turnId } : {}),
      before: taskLifecycleState(previousTask),
      after: taskLifecycleState(recoveredTask),
      data: { action: execution.action },
    });
  }

  private async restoreTaskAfterRecoveryRace(
    project: Project,
    previousTask: Task,
  ): Promise<Task> {
    await this.store.saveTask(project.id, previousTask);
    await this.recordRecoverySuppressed(
      project.id,
      previousTask,
      previousTask.currentExecution!.attemptId,
      "conversation_became_active",
    );
    return previousTask;
  }

  private async repositoryPathForReport(
    task: Task,
    execution: NonNullable<Task["currentExecution"]>,
    activities: readonly TaskActivity[],
    report: TaskReport,
  ): Promise<string | undefined> {
    const createsWork =
      (execution.action === "work" && report.outcome === "completed") ||
      (execution.action === "integrate" && report.outcome === "needs_review");
    if (createsWork && report.workspacePath) {
      const repositoryPath = await this.repositoryPaths.resolveWorkspaceRepository(
        report.workspacePath,
      );
      const maintenanceRepository = task.origin?.repositoryPath;
      if (
        task.origin?.kind === "semantic_atlas_maintenance" &&
        maintenanceRepository &&
        resolve(repositoryPath) !== resolve(maintenanceRepository)
      ) {
        throw new InvalidTaskReportError(
          `Semantic Atlas maintenance for ${maintenanceRepository} cannot report work from ${repositoryPath}`,
        );
      }
      return repositoryPath;
    }

    const boundWork = execution.workActivityId
      ? activities.find(({ id }) => id === execution.workActivityId)
      : undefined;
    return boundWork?.evidence?.repositoryPath ?? task.origin?.repositoryPath;
  }

  private async finalizeTaskReport(
    project: Project,
    task: Task,
    report: TaskReport,
    reportSubmittedAt: string,
  ): Promise<Task> {
    let completed = applyTaskReport(
      task,
      report,
      this.now(),
      reportSubmittedAt,
    );
    if (completed.currentExecution?.status === "waiting_for_input") {
      completed = this.rotateReportOpportunity(completed);
    }
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

  private async finalizeSubmittedTaskReport(
    project: Project,
    task: Task,
  ): Promise<Task> {
    const execution = task.currentExecution;
    if (!execution?.submittedActivityId || !execution.turnId) {
      throw new Error(`Task ${task.id} has no submitted report to finalize`);
    }
    const activity = await this.requireTaskActivity(
      project.id,
      task.id,
      execution.submittedActivityId,
    );
    const now = this.now();
    const taskWithCompletedTurn: Task = {
      ...task,
      currentExecution: { ...execution, turnCompletedAt: now },
      updatedAt: now,
    };
    await this.recordEvent({
      type: "turn.completed",
      projectId: project.id,
      taskId: task.id,
      attemptId: execution.attemptId,
      ...(execution.threadId ? { threadId: execution.threadId } : {}),
      turnId: execution.turnId,
      before: taskLifecycleState(task),
      after: taskLifecycleState(taskWithCompletedTurn),
    });
    const completed = await this.finalizeTaskReport(
      project,
      taskWithCompletedTurn,
      taskReportFromActivity(activity),
      activity.occurredAt,
    );
    await this.reconcileInternal();
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
    if (!(await this.productDocumentIsCurrent(project))) {
      throw new WorkflowConflictError(
        "PROJECT.md has unrecorded changes; task selection was superseded",
      );
    }
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
          requestedAction: "work",
          updatedAt: this.now(),
        });
      }
    }

    const completed: Project = {
      ...project,
      status: "active",
      requestedAction: null,
      currentExecution: completedProjectExecution(project, this.now()),
      modelRouting: execution.modelRouting,
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
    if (!(await this.productDocumentIsCurrent(project))) {
      throw new WorkflowConflictError(
        "PROJECT.md has unrecorded changes; update product facts before task selection",
      );
    }
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

  private async blockTaskAfterRecoveryFailure(
    project: Project,
    task: Task,
    reason: string,
  ): Promise<Task> {
    const now = this.now();
    const blocked: Task = {
      ...task,
      status: "blocked",
      currentExecution: executionWithoutScheduledResume({
        ...task.currentExecution!,
        status: "failed",
        finishedAt: now,
      }),
      updatedAt: now,
    };
    await this.store.saveTask(project.id, blocked);
    await this.recordEvent({
      type: "task.execution_recovery_failed",
      projectId: project.id,
      taskId: task.id,
      attemptId: task.currentExecution!.attemptId,
      reason,
      before: taskLifecycleState(task),
      after: taskLifecycleState(blocked),
    });
    await this.recordTaskLifecycleActivity(
      project,
      blocked,
      "execution_failed",
      reason,
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
          currentExecution: executionWithoutScheduledResume({
            ...execution,
            status: "interrupted",
            finishedAt: this.now(),
          }),
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
            currentExecution: executionWithoutScheduledResume({
              ...execution,
              status: "interrupted" as const,
              finishedAt: now,
            }),
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
        task.currentExecution?.workActivityId ?? task.workActivityId,
      ),
    };
  }

  private prepareTaskForTurn(
    project: Project,
    task: Task,
    options: { rotateReportOpportunity?: boolean } = {},
  ): Task {
    const execution = task.currentExecution!;
    const now = this.now();
    const modelRouting = prepareModelRoutingForTurn(
      execution.modelRouting,
      this.modelSettingsFor(project),
      new Date(now),
      this.modelPrimaryProbeAfterMs,
    );
    if (!options.rotateReportOpportunity && modelRouting === execution.modelRouting) {
      return task;
    }
    const prepared: Task = {
      ...task,
      currentExecution: {
        ...execution,
        modelRouting,
        ...(options.rotateReportOpportunity
          ? { reportOpportunityId: this.createId("report_opportunity") }
          : {}),
      },
      updatedAt: now,
    };
    if (options.rotateReportOpportunity) {
      delete prepared.currentExecution?.submittedActivityId;
    }
    return prepared;
  }

  private modelSettingsFor(project: Project): ModelRoutingSettings {
    return project.modelConfig ?? this.models;
  }

  private async productDocumentIsCurrent(project: Project): Promise<boolean> {
    const document = await this.store.readProductDocumentSnapshot(project.id);
    return (
      hasProductFacts(document.document) &&
      document.digest === project.productFacts.digest
    );
  }

  private async acceptProductDocumentChange(
    project: Project,
    change: ProductDocumentChange,
  ): Promise<AcceptedProductDocumentChange> {
    const decisionSummary = change.decisionSummary.trim();
    if (!decisionSummary) {
      throw new WorkflowConflictError(
        "Product document changes require a decision summary",
      );
    }
    if (
      change.expectedRevision !== project.productFacts.revision ||
      change.expectedDigest !== project.productFacts.digest
    ) {
      throw new WorkflowConflictError(
        `Product document revision ${change.expectedRevision} is stale; ` +
          `current revision is ${project.productFacts.revision}`,
      );
    }

    const document = await this.store.readProductDocumentSnapshot(project.id);
    if (!hasProductFacts(document.document)) {
      throw new WorkflowConflictError("PROJECT.md must not be empty");
    }
    if (document.digest !== change.documentDigest) {
      throw new WorkflowConflictError(
        "PROJECT.md changed after the notification was prepared",
      );
    }
    if (document.digest === project.productFacts.digest) {
      throw new WorkflowConflictError("PROJECT.md has no unrecorded changes");
    }
    return { decisionSummary, digest: document.digest };
  }

  private recordProductDocumentChange(
    previous: Project,
    project: Project,
    change: AcceptedProductDocumentChange,
  ): Promise<unknown> {
    return this.recordEvent({
      type: "project.product_document_updated",
      projectId: project.id,
      decision: change.decisionSummary,
      before: projectLifecycleState(previous),
      after: projectLifecycleState(project),
      data: {
        previousDocumentRevision: previous.productFacts.revision,
        documentRevision: project.productFacts.revision,
        previousDocumentDigest: previous.productFacts.digest,
        documentDigest: project.productFacts.digest,
      },
    });
  }

  private recordSupersededSelection(
    previous: Project,
    project: Project,
    reason: string,
  ): Promise<unknown> {
    const execution = previous.currentExecution;
    if (!execution || !hasActiveProjectExecution(previous)) {
      return Promise.resolve();
    }
    return this.recordEvent({
      type: "project.selection_superseded",
      projectId: project.id,
      attemptId: execution.attemptId,
      ...(execution.threadId ? { threadId: execution.threadId } : {}),
      ...(execution.turnId ? { turnId: execution.turnId } : {}),
      before: projectLifecycleState(previous),
      after: projectLifecycleState(project),
      data: {
        planningRevision:
          execution.planningRevision ?? previous.planning.revision,
        reason,
      },
    });
  }

  private rotateReportOpportunity(task: Task): Task {
    return {
      ...task,
      currentExecution: {
        ...task.currentExecution!,
        reportOpportunityId: this.createId("report_opportunity"),
      },
    };
  }

  private async recordTaskLifecycleActivity(
    project: Project,
    task: Task,
    type:
      | "scheduled_resume_started"
      | "scheduled_resume_rescheduled"
      | "execution_recovered"
      | "execution_failed"
      | "cancelled",
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

  private async requireScheduledTaskResume(
    taskId: string,
  ): Promise<{ project: Project; task: Task }> {
    const found = await this.requireTask(taskId);
    if (
      found.task.currentExecution?.status !== "waiting_for_resume" ||
      !found.task.currentExecution.scheduledResume
    ) {
      throw new WorkflowConflictError(
        `Task ${taskId} is not waiting for a scheduled resume`,
      );
    }
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
    event: Omit<CodriveEvent, "schemaVersion" | "eventId" | "occurredAt">,
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

function matchesRecoveryTarget(
  projectId: string,
  task: Task,
  target: TaskExecutionIdentity,
): boolean {
  const execution = task.currentExecution;
  return Boolean(
    projectId === target.projectId &&
      task.id === target.taskId &&
      task.requestedAction === target.action &&
      execution?.action === target.action &&
      execution.attemptId === target.attemptId &&
      execution.status === target.executionStatus &&
      execution.threadId === target.threadId &&
      execution.turnId === target.turnId &&
      inFlightExecutionStatuses.has(execution.status),
  );
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

function availableProjectPlanningCapacity(
  snapshot: ProjectSnapshot,
  concurrencyLimit: number,
): number {
  const reservedWorkTasks = snapshot.tasks
    .filter(
      ({ status, requestedAction }) =>
        status === "backlog" && requestedAction === "work",
    ).length;
  return Math.max(
    0,
    concurrencyLimit - countActiveTasks(snapshot.tasks) - reservedWorkTasks,
  );
}

function projectConcurrencyLimit(project: Project, fallback: number): number {
  return project.planning.concurrencyLimit ?? fallback;
}

function projectArchiveConflict(
  blocker: ProjectArchiveBlocker,
): string {
  const status = archiveExecutionStatusLabel(blocker.status);
  if (blocker.scope === "project") {
    return `项目规划执行仍处于“${status}”，请先完成或取消该执行后再归档。`;
  }
  return `任务“${blocker.taskTitle}”的执行仍处于“${status}”，请先完成或取消该执行后再归档。`;
}

function archiveExecutionStatusLabel(status: ExecutionStatus): string {
  switch (status) {
    case "pending":
      return "正在启动";
    case "running":
      return "正在运行";
    case "retry_scheduled":
      return "等待重试";
    case "awaiting_report":
      return "等待汇报";
    case "waiting_for_input":
      return "等待输入";
    case "waiting_for_resume":
      return "计划等待";
    default:
      return status;
  }
}

function compareTaskDispatchCandidates(
  left: { project: Project; task: Task },
  right: { project: Project; task: Task },
): number {
  const actionPriority = (task: Task) => (task.requestedAction === "work" ? 1 : 0);
  return (
    actionPriority(left.task) - actionPriority(right.task) ||
    left.task.updatedAt.localeCompare(right.task.updatedAt) ||
    left.project.id.localeCompare(right.project.id) ||
    left.task.order - right.task.order ||
    left.task.id.localeCompare(right.task.id)
  );
}

function compareScheduledTaskResumes(
  left: { project: Project; task: Task },
  right: { project: Project; task: Task },
): number {
  return (
    Date.parse(left.task.currentExecution!.scheduledResume!.resumeAt) -
      Date.parse(right.task.currentExecution!.scheduledResume!.resumeAt) ||
    left.project.id.localeCompare(right.project.id) ||
    left.task.order - right.task.order ||
    left.task.id.localeCompare(right.task.id)
  );
}

function isScheduledTaskResumeDue(
  task: Task,
  now: Date,
  threadId?: string,
  includeDeferred = false,
): boolean {
  const execution = task.currentExecution;
  return Boolean(
    task.requestedAction &&
      execution?.status === "waiting_for_resume" &&
      execution.scheduledResume &&
      (!threadId
        ? includeDeferred || !execution.scheduledResume.wakeAttemptedAt
        : execution.threadId === threadId) &&
      Date.parse(execution.scheduledResume.resumeAt) <= now.getTime(),
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

function statusForTaskAction(action: NonNullable<Task["requestedAction"]>): Task["status"] {
  if (action === "review") return "reviewing";
  if (action === "integrate") return "integrating";
  return "working";
}

function eventForTask(task: Task): string {
  if (task.currentExecution?.status === "waiting_for_resume") {
    return "task.scheduled_resume_waiting";
  }
  switch (task.status) {
    case "reviewing":
      return "task.review_requested";
    case "working":
      return "task.work_requested";
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

function validateBoundWorkReport(
  execution: NonNullable<Task["currentExecution"]>,
  activities: readonly TaskActivity[],
  report: TaskReport,
): void {
  if (!["review", "integrate"].includes(execution.action)) return;
  const work = activities.find(
    ({ id, type }) => id === execution.workActivityId && type === "work_completed",
  );
  if (!work) {
    throw new WorkflowConflictError(
      `Task execution ${execution.attemptId} is not bound to a work activity`,
    );
  }
  if (!work.evidence?.candidateCommit) return;
  if (execution.action === "review" && report.outcome === "approved") {
    requireGitEvidence(report, "reviewedMainCommit");
  }
  if (
    execution.action === "integrate" &&
    ["completed", "work_required"].includes(report.outcome)
  ) {
    requireGitEvidence(report, "mergedCommit");
  }
}

function requireGitEvidence(
  report: TaskReport,
  field: "reviewedMainCommit" | "mergedCommit",
): void {
  if (!report[field]) {
    throw new InvalidTaskReportError(
      `Report ${report.attemptId} requires ${field} for code-backed work`,
    );
  }
}

function reportActivityForIdempotency(
  activities: readonly TaskActivity[],
  report: TaskReport,
): TaskActivity | undefined {
  return activities.find(
    ({ attemptId, outcome, reportOpportunityId }) =>
      attemptId === report.attemptId &&
      outcome !== undefined &&
      reportOpportunityId === report.reportOpportunityId,
  );
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
  if (command.type === "project.update_product_document") {
    summary.expectedDocumentRevision = command.payload.expectedRevision;
  }
  if (command.type === "task.update_definition") {
    summary.changedFields = Object.keys(command.payload.changes);
    summary.updatesProductDocument = Boolean(
      command.payload.productDocumentChange,
    );
  }
  return summary;
}

function changedTaskDefinitionFields(
  task: Task,
  changes: TaskDefinitionChanges,
): Array<keyof TaskDefinitionChanges> {
  return (["title", "description", "acceptanceCriteria"] as const).filter(
    (field) =>
      changes[field] !== undefined &&
      !isDeepStrictEqual(task[field], changes[field]),
  );
}

function validateTaskDefinitionUpdate(
  project: Project,
  task: Task,
  input: UpdateTaskDefinitionInput,
): {
  decisionSummary: string;
  changedFields: Array<keyof TaskDefinitionChanges>;
} {
  if (project.status === "cancelled") {
    throw new WorkflowConflictError(
      `Cancelled project ${project.id} cannot update task definitions`,
    );
  }
  if (isProjectArchived(project)) {
    throw new WorkflowConflictError(
      `Archived project ${project.id} cannot update task definitions`,
    );
  }
  if (task.origin) {
    throw new WorkflowConflictError(
      `System-generated task ${task.id} cannot update its definition`,
    );
  }
  if (
    task.status !== "backlog" ||
    task.requestedAction !== null ||
    task.currentExecution
  ) {
    throw new WorkflowConflictError(
      `Task ${task.id} must remain an unstarted backlog task before its definition can change`,
    );
  }
  if (task.updatedAt !== input.expectedUpdatedAt) {
    throw new WorkflowConflictError(
      `Task ${task.id} definition is stale; current updatedAt is ${task.updatedAt}`,
    );
  }

  const decisionSummary = input.decisionSummary.trim();
  if (!decisionSummary) {
    throw new WorkflowConflictError(
      "Task definition changes require a decision summary",
    );
  }
  if (input.changes.title !== undefined && input.changes.title.length === 0) {
    throw new WorkflowConflictError("Task definition title must not be empty");
  }
  const changedFields = changedTaskDefinitionFields(task, input.changes);
  if (changedFields.length === 0) {
    throw new WorkflowConflictError(
      `Task ${task.id} definition update does not change any fields`,
    );
  }
  return { decisionSummary, changedFields };
}

function applyTaskDefinitionChanges(
  task: Task,
  changes: TaskDefinitionChanges,
  updatedAt: string,
): Task {
  return {
    ...task,
    ...(changes.title === undefined ? {} : { title: changes.title }),
    ...(changes.description === undefined
      ? {}
      : { description: changes.description }),
    ...(changes.acceptanceCriteria === undefined
      ? {}
      : { acceptanceCriteria: changes.acceptanceCriteria }),
    updatedAt,
  };
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

const rfc3339AbsoluteTime =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function requireFutureRfc3339(value: string, now: string): string {
  if (!rfc3339AbsoluteTime.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new WorkflowConflictError("resumeAt must be an RFC 3339 absolute time");
  }
  if (Date.parse(value) <= Date.parse(now)) {
    throw new WorkflowConflictError("resumeAt must be in the future");
  }
  return new Date(value).toISOString();
}

function resetScheduledWakeAttempt(
  schedule: NonNullable<Task["currentExecution"]>["scheduledResume"] & {},
  resumeAt: string,
) {
  const { wakeAttemptedAt: _wakeAttemptedAt, ...waiting } = schedule;
  return { ...waiting, resumeAt };
}

function executionWithoutScheduledResume(
  execution: NonNullable<Task["currentExecution"]>,
): NonNullable<Task["currentExecution"]> {
  const { scheduledResume: _scheduledResume, ...withoutSchedule } = execution;
  return withoutSchedule;
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
