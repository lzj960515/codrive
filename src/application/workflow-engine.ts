import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { WorkflowConflictError } from "../domain/errors.js";
import type {
  CodriveCommand,
  CodriveEvent,
  CreateProjectInput,
  CreateTaskInput,
  Project,
  ProjectReport,
  ProjectSnapshot,
  Task,
  TaskExecution,
  TaskReport,
} from "../domain/types.js";
import {
  applyTaskReport,
  startTaskExecution,
  validateTaskReport,
} from "../domain/workflow.js";
import type { ProjectStore } from "../infrastructure/project-store.js";
import { ProjectExecutionCoordinator } from "./project-execution-coordinator.js";
import type { ProjectExecutor } from "./project-executor.js";
import type { DispatchRequest, TaskDispatcher } from "./task-dispatcher.js";

export interface WorkflowEngineOptions {
  maxConcurrentTasks: number;
  executionLeaseMs?: number;
  now?: () => string;
  createId?: (prefix: string) => string;
}

interface ReconcileOptions {
  recoverProjectsWithoutActiveWork?: boolean;
}

const activeExecutionStatuses = new Set(["pending", "running", "awaiting_report"]);
const reportableExecutionStatuses = new Set([
  ...activeExecutionStatuses,
  "waiting_for_input",
]);
const integrationLeaseStatuses = new Set([
  ...activeExecutionStatuses,
  "waiting_for_input",
]);

export class WorkflowEngine {
  private readonly now: () => string;
  private readonly createId: (prefix: string) => string;
  private readonly executionLeaseMs: number;
  private readonly projectExecutions: ProjectExecutionCoordinator | undefined;
  private operation: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly store: ProjectStore,
    private readonly dispatcher: TaskDispatcher,
    private readonly options: WorkflowEngineOptions,
    projectExecutor?: ProjectExecutor,
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.createId = options.createId ?? ((prefix) => `${prefix}_${randomUUID()}`);
    this.executionLeaseMs = options.executionLeaseMs ?? 6 * 60 * 60 * 1000;
    this.projectExecutions = projectExecutor
      ? new ProjectExecutionCoordinator(this.store, projectExecutor, {
          now: this.now,
          createId: this.createId,
          leaseExpiration: () => this.leaseExpiration(),
          recordEvent: (event) => this.recordEvent(event),
        })
      : undefined;
  }

  execute(command: CodriveCommand): Promise<unknown> {
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
        return this.controlProject(command.payload.projectId, command.payload.action);
      case "project.record_decision":
        return this.recordProjectDecision(
          command.payload.projectId,
          command.payload.decision,
          command.payload.productDocument,
        );
      case "task.control":
        return command.payload.action === "retry"
          ? this.retryTask(command.payload.taskId)
          : this.cancelTask(command.payload.taskId);
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
    return this.enqueue(() =>
      this.reconcileInternal({ recoverProjectsWithoutActiveWork: true }),
    );
  }

  async availableTaskSlots(): Promise<number> {
    const activeTasks = countActiveTasks(await this.store.listProjects());
    return Math.max(0, this.options.maxConcurrentTasks - activeTasks);
  }

  registerProject(input: CreateProjectInput): Promise<ProjectSnapshot> {
    return this.enqueue(async () => {
      const created = await this.store.createProject(input);
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
        updatedAt: this.now(),
      };
      delete project.lastSelectionFingerprint;
      await this.store.saveProject(project);
      await this.recordEvent({
        type: "project.work_added",
        projectId,
        data: { taskCount: tasks.length },
      });
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
      const refreshesActiveWork = [
        "active",
        "selecting_tasks",
        "evaluating",
        "waiting_for_input",
      ].includes(snapshot.project.status);
      const currentProject = hasActiveProjectExecution(snapshot.project)
        ? await this.requireProjectExecutions().cancel(snapshot.project)
        : snapshot.project;
      const project: Project = {
        ...currentProject,
        contextNotes: [...(currentProject.contextNotes ?? []), decision],
        ...(refreshesActiveWork
          ? { status: "active", requestedAction: null }
          : {}),
        updatedAt: this.now(),
      };
      if (refreshesActiveWork) {
        delete project.latestReport;
        delete project.lastSelectionFingerprint;
      }
      await this.store.saveProject(project);
      await this.recordEvent({ type: "project.decision_recorded", projectId });
      if (refreshesActiveWork) await this.reconcileInternal();
      return (await this.requireSnapshot(projectId)).project;
    });
  }

  submitReport(report: TaskReport): Promise<Task> {
    return this.enqueue(async () => {
      const found = await this.requireTask(report.taskId);
      const execution = found.task.currentExecution;
      if (found.task.latestReport?.attemptId === report.attemptId) {
        if (isDeepStrictEqual(found.task.latestReport, report)) return found.task;
        if (execution?.status !== "waiting_for_input") {
          throw new WorkflowConflictError(
            `Report conflicts with the recorded result for ${report.taskId}`,
          );
        }
      }
      if (
        !execution ||
        execution.attemptId !== report.attemptId ||
        !reportableExecutionStatuses.has(execution.status)
      ) {
        throw new WorkflowConflictError(
          `Report does not match the current execution for ${report.taskId}`,
        );
      }
      validateTaskReport(found.task, report);

      const task: Task = {
        ...found.task,
        latestReport: report,
        currentExecution: { ...execution, report },
        updatedAt: this.now(),
      };
      await this.store.saveTask(found.project.id, task);
      await this.recordEvent({
        type: "task.reported",
        projectId: found.project.id,
        taskId: task.id,
        attemptId: execution.attemptId,
        data: { outcome: report.outcome },
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
      const reported = await this.requireProjectExecutions().submitReport(report);
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
        throw new Error(`Turn does not match the current execution for ${taskId}`);
      }
      if (execution.turnId !== turnId) return found.task;

      const now = this.now();
      await this.recordEvent({
        type: "turn.completed",
        projectId: found.project.id,
        taskId,
        attemptId,
        data: { turnId },
      });
      if (execution.report) {
        const taskWithCompletedTurn: Task = {
          ...found.task,
          currentExecution: { ...execution, turnCompletedAt: now },
          updatedAt: now,
        };
        const completed = await this.finalizeTaskReport(
          found.project,
          taskWithCompletedTurn,
          execution.report,
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
      const reminderTurnId = await this.dispatcher.requestReport(
        { project: found.project, task: awaitingReport },
        execution.threadId!,
      );
      const reminded: Task = {
        ...awaitingReport,
        currentExecution: {
          ...awaitingReport.currentExecution!,
          turnId: reminderTurnId,
          leaseExpiresAt: this.leaseExpiration(),
        },
      };
      delete reminded.currentExecution?.turnCompletedAt;
      await this.store.saveTask(found.project.id, reminded);
      await this.recordEvent({
        type: "turn.started",
        projectId: found.project.id,
        taskId,
        attemptId,
        data: { threadId: execution.threadId, turnId: reminderTurnId },
      });
      return reminded;
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
      if (project.currentExecution?.report) {
        const completed = await this.finalizeProjectReport(
          project,
          project.currentExecution.report,
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
        activeExecutionStatuses.has(found.task.currentExecution.status)
      ) {
        throw new WorkflowConflictError(
          `Task ${taskId} is still active and cannot be retried`,
        );
      }
      return this.restartTaskExecution(found.project, found.task);
    });
  }

  recoverTask(taskId: string): Promise<Task> {
    return this.enqueue(async () => {
      const found = await this.requireTask(taskId);
      if (!found.task.requestedAction) return found.task;
      if (found.task.currentExecution?.status === "pending") {
        return this.continueTaskDispatch(found.project, found.task);
      }
      return this.restartTaskExecution(found.project, found.task);
    });
  }

  recoverProjectExecution(projectId: string): Promise<Project> {
    return this.enqueue(async () => {
      const snapshot = await this.requireSnapshot(projectId);
      return this.requireProjectExecutions().recover(projectId, snapshot.tasks);
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

  controlProject(
    projectId: string,
    action: "pause" | "resume" | "cancel",
  ): Promise<Project> {
    return this.enqueue(async () => {
      const snapshot = await this.requireSnapshot(projectId);
      if (snapshot.project.status === "cancelled") {
        throw new WorkflowConflictError(`Cancelled project ${projectId} is terminal`);
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
        });
        if (action === "resume") await this.reconcileInternal();
        return (await this.requireSnapshot(projectId)).project;
      }

      let project = await this.requireProjectExecutions().cancel(snapshot.project);
      project = {
        ...project,
        status: "cancelled",
        scheduling: "paused",
        requestedAction: null,
        updatedAt: this.now(),
      };
      await this.store.saveProject(project);
      await this.recordEvent({ type: "project.cancelled", projectId });
      for (const task of snapshot.tasks) {
        await this.cancelTaskInternal(project, task);
      }
      return (await this.requireSnapshot(projectId)).project;
    });
  }

  cancelTask(taskId: string): Promise<Task> {
    return this.enqueue(async () => {
      const found = await this.requireTask(taskId);
      const cancelled = await this.cancelTaskInternal(found.project, found.task);
      await this.reconcileInternal();
      return cancelled;
    });
  }

  failTurn(taskId: string, attemptId: string, message: string): Promise<Task> {
    return this.enqueue(async () => {
      const found = await this.requireTask(taskId);
      const execution = found.task.currentExecution;
      if (!execution || execution.attemptId !== attemptId) return found.task;
      const now = this.now();
      const failed: Task = {
        ...found.task,
        status: "blocked",
        currentExecution: {
          ...execution,
          status: "failed",
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
        data: { message },
      });
      await this.reconcileInternal();
      return failed;
    });
  }

  failProjectTurn(
    projectId: string,
    attemptId: string,
    message: string,
  ): Promise<Project> {
    return this.enqueue(() =>
      this.requireProjectExecutions().failTurn(projectId, attemptId, message),
    );
  }

  private async reconcileInternal(options: ReconcileOptions = {}): Promise<void> {
    const snapshots = await this.store.listProjects();
    let activeCount = countActiveTasks(snapshots);
    const integrationLeases = activeIntegrationRepositories(snapshots);

    for (const initialSnapshot of snapshots) {
      let snapshot = (await this.store.getProject(initialSnapshot.project.id))!;
      snapshot = await this.resumeAfterTaskSelectionChanges(snapshot);
      if (
        snapshot.project.status !== "active" ||
        snapshot.project.scheduling !== "running"
      ) {
        continue;
      }
      if (hasActiveProjectExecution(snapshot.project)) continue;

      for (const task of snapshot.tasks) {
        if (activeCount >= this.options.maxConcurrentTasks) break;
        if (!canDispatchTask(task)) continue;
        const repository = resolve(snapshot.project.repositoryPath);
        if (task.requestedAction === "integrate" && integrationLeases.has(repository)) {
          continue;
        }
        const dispatched = await this.dispatchTask(snapshot.project, task);
        if (dispatched) {
          activeCount += 1;
          if (task.requestedAction === "integrate") integrationLeases.add(repository);
        }
      }

      snapshot = (await this.store.getProject(snapshot.project.id))!;
      if (snapshot.tasks.every(({ status }) => ["done", "cancelled"].includes(status))) {
        if (this.projectExecutions) {
          await this.projectExecutions.start(
            snapshot.project,
            snapshot.tasks,
            "evaluate_product",
          );
        }
        continue;
      }

      const hasBacklog = snapshot.tasks.some(
        ({ status, requestedAction }) => status === "backlog" && !requestedAction,
      );
      const hasReservedWork = snapshot.tasks.some(
        ({ status, requestedAction }) =>
          status === "backlog" && requestedAction === "develop",
      );
      if (!hasBacklog || hasReservedWork) {
        await this.rememberSelectionState(snapshot);
        continue;
      }
      if (activeCount >= this.options.maxConcurrentTasks) continue;

      const fingerprint = selectionFingerprint(
        snapshot.tasks,
        this.options.maxConcurrentTasks,
      );
      const projectHasOngoingTask = snapshot.tasks.some(hasOngoingTaskExecution);
      const shouldRecoverProject =
        options.recoverProjectsWithoutActiveWork && !projectHasOngoingTask;
      if (
        this.projectExecutions &&
        (snapshot.project.lastSelectionFingerprint !== fingerprint ||
          shouldRecoverProject)
      ) {
        await this.projectExecutions.start(
          snapshot.project,
          snapshot.tasks,
          "select_tasks",
        );
      }
    }
  }

  private async resumeAfterTaskSelectionChanges(
    snapshot: ProjectSnapshot,
  ): Promise<ProjectSnapshot> {
    const { project, tasks } = snapshot;
    const waitingForTaskSelection =
      project.status === "waiting_for_input" &&
      project.currentExecution?.action === "select_tasks";
    if (
      !waitingForTaskSelection ||
      project.lastSelectionFingerprint ===
        selectionFingerprint(tasks, this.options.maxConcurrentTasks)
    ) {
      return snapshot;
    }

    const resumed: Project = {
      ...project,
      status: "active",
      requestedAction: null,
      updatedAt: this.now(),
    };
    delete resumed.latestReport;
    delete resumed.lastSelectionFingerprint;
    await this.store.saveProject(resumed);
    await this.recordEvent({
      type: "project.selection_invalidated",
      projectId: project.id,
      attemptId: project.currentExecution!.attemptId,
    });
    return { project: resumed, tasks };
  }

  private async dispatchTask(project: Project, task: Task): Promise<boolean> {
    const attemptId = this.createId("attempt");
    const pending = startTaskExecution(task, attemptId, this.now());
    pending.currentExecution!.leaseExpiresAt = this.leaseExpiration();
    await this.store.saveTask(project.id, pending);
    await this.recordEvent({
      type: "task.execution_started",
      projectId: project.id,
      taskId: pending.id,
      attemptId,
      data: { action: pending.currentExecution?.action },
    });
    const result = await this.continueTaskDispatch(project, pending);
    return result.currentExecution?.status === "running";
  }

  private async continueTaskDispatch(project: Project, task: Task): Promise<Task> {
    const execution = task.currentExecution!;
    const request: DispatchRequest = { project, task };
    try {
      let withThread = task;
      let threadId = execution.threadId;
      if (!threadId) {
        const createsThread =
          execution.action === "review" || !task.developmentThreadId;
        const createdThreadId = await this.dispatcher.openThread(request);
        threadId = createdThreadId;
        withThread = {
          ...task,
          currentExecution: { ...execution, threadId: createdThreadId },
          updatedAt: this.now(),
        };
        if (execution.action === "review") {
          withThread.reviewAttempts = withThread.reviewAttempts.map((review) =>
            review.attemptId === execution.attemptId
              ? { ...review, threadId: createdThreadId }
              : review,
          );
        } else if (!withThread.developmentThreadId) {
          withThread.developmentThreadId = createdThreadId;
        }
        await this.store.saveTask(project.id, withThread);
        if (createsThread) {
          await this.recordEvent({
            type: "thread.created",
            projectId: project.id,
            taskId: task.id,
            attemptId: execution.attemptId,
            data: { threadId: createdThreadId },
          });
        }
      }

      const turnId = await this.dispatcher.startTurn(
        { project, task: withThread },
        threadId,
      );
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
        data: { threadId, turnId },
      });
      return running;
    } catch (error) {
      const current = (await this.requireTask(task.id)).task;
      const failed: Task = {
        ...current,
        status: "blocked",
        currentExecution: {
          ...current.currentExecution!,
          status: "failed",
          finishedAt: this.now(),
        },
        updatedAt: this.now(),
      };
      await this.store.saveTask(project.id, failed);
      await this.recordEvent({
        type: "turn.failed",
        projectId: project.id,
        taskId: task.id,
        attemptId: execution.attemptId,
        data: { message: error instanceof Error ? error.message : String(error) },
      });
      return failed;
    }
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
    });
    return completed;
  }

  private async finalizeProjectReport(
    project: Project,
    report: ProjectReport,
  ): Promise<Project> {
    const execution = project.currentExecution!;
    if (execution.action === "select_tasks") {
      return this.finalizeTaskSelection(project, report);
    }
    return this.finalizeProductEvaluation(project, report);
  }

  private async finalizeTaskSelection(
    project: Project,
    report: ProjectReport,
  ): Promise<Project> {
    const snapshot = await this.requireSnapshot(project.id);
    if (report.outcome === "selected") {
      const taskIds = report.taskIds!;
      if (new Set(taskIds).size !== taskIds.length) {
        throw new WorkflowConflictError("Selected task IDs must be unique");
      }
      const selected = taskIds.map((taskId) => {
        const task = snapshot.tasks.find(({ id }) => id === taskId);
        if (!task || task.status !== "backlog" || task.requestedAction) {
          throw new WorkflowConflictError(`Task ${taskId} is not available for selection`);
        }
        return task;
      });
      const availableSlots = Math.max(
        0,
        this.options.maxConcurrentTasks - countActiveTasks(await this.store.listProjects()),
      );
      if (selected.length > availableSlots) {
        throw new WorkflowConflictError(
          `Selected ${selected.length} tasks but only ${availableSlots} slots are available`,
        );
      }
      for (const task of selected) {
        await this.store.saveTask(project.id, {
          ...task,
          requestedAction: "develop",
          updatedAt: this.now(),
        });
      }
    } else if (report.outcome === "wait_for_active_tasks") {
      if (!snapshot.tasks.some(hasOngoingTaskExecution)) {
        throw new WorkflowConflictError(
          "wait_for_active_tasks requires at least one ongoing task",
        );
      }
    }

    const status =
      report.outcome === "needs_input"
        ? "waiting_for_input"
        : report.outcome === "blocked"
          ? "blocked"
          : "active";
    const tasks = (await this.requireSnapshot(project.id)).tasks;
    const completed: Project = {
      ...project,
      status,
      requestedAction: null,
      currentExecution: completedProjectExecution(project, this.now()),
      lastSelectionFingerprint: selectionFingerprint(
        tasks,
        this.options.maxConcurrentTasks,
      ),
      updatedAt: this.now(),
    };
    await this.store.saveProject(completed);
    await this.recordEvent({
      type: `project.selection_${report.outcome}`,
      projectId: project.id,
      attemptId: report.attemptId,
      data: { taskIds: report.taskIds ?? [] },
    });
    return completed;
  }

  private async finalizeProductEvaluation(
    project: Project,
    report: ProjectReport,
  ): Promise<Project> {
    const execution = project.currentExecution!;
    const now = this.now();
    if (report.outcome === "tasks_required") {
      const stagnantRounds =
        project.lastEvaluationFingerprint === undefined ||
        project.lastEvaluationFingerprint !== execution.progressFingerprint
          ? 0
          : (project.stagnantEvaluationRounds ?? 0) + 1;
      if (stagnantRounds >= 3) {
        const stalled: Project = {
          ...project,
          status: "stalled",
          requestedAction: null,
          currentExecution: completedProjectExecution(project, now),
          stagnantEvaluationRounds: stagnantRounds,
          ...(execution.progressFingerprint
            ? { lastEvaluationFingerprint: execution.progressFingerprint }
            : {}),
          updatedAt: now,
        };
        await this.store.saveProject(stalled);
        await this.recordEvent({
          type: "project.stalled",
          projectId: project.id,
          attemptId: report.attemptId,
        });
        return stalled;
      }
      if (report.productDocument) {
        await this.store.saveProductDocument(project.id, report.productDocument);
      }
      await this.store.addTasks(project.id, report.tasks!);
      const active: Project = {
        ...project,
        status: "active",
        requestedAction: null,
        currentExecution: completedProjectExecution(project, now),
        stagnantEvaluationRounds: stagnantRounds,
        ...(execution.progressFingerprint
          ? { lastEvaluationFingerprint: execution.progressFingerprint }
          : {}),
        updatedAt: now,
      };
      delete active.lastSelectionFingerprint;
      await this.store.saveProject(active);
      await this.recordEvent({
        type: "project.evaluation_tasks_created",
        projectId: project.id,
        attemptId: report.attemptId,
        data: { taskCount: report.tasks!.length },
      });
      return active;
    }

    const status =
      report.outcome === "completed"
        ? "completed"
        : report.outcome === "needs_input"
          ? "waiting_for_input"
          : "blocked";
    const completed: Project = {
      ...project,
      status,
      requestedAction: null,
      currentExecution: completedProjectExecution(project, now),
      ...(execution.progressFingerprint
        ? { lastEvaluationFingerprint: execution.progressFingerprint }
        : {}),
      stagnantEvaluationRounds: 0,
      updatedAt: now,
    };
    await this.store.saveProject(completed);
    await this.recordEvent({
      type: `project.${status}`,
      projectId: project.id,
      attemptId: report.attemptId,
    });
    return completed;
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
      data: { reason: "missing_report" },
    });
    return blocked;
  }

  private async restartTaskExecution(project: Project, current: Task): Promise<Task> {
    const { currentExecution: _execution, ...retryableTask } = current;
    const task: Task = {
      ...retryableTask,
      status: statusBeforeExecution(current.requestedAction!),
      updatedAt: this.now(),
    };
    await this.store.saveTask(project.id, task);
    const dispatched = await this.dispatchTask(project, task);
    return dispatched ? (await this.requireTask(task.id)).task : task;
  }

  private async cancelTaskInternal(project: Project, task: Task): Promise<Task> {
    if (["done", "cancelled"].includes(task.status)) return task;
    const now = this.now();
    const execution = task.currentExecution;
    const wasActive = execution
      ? activeExecutionStatuses.has(execution.status)
      : false;
    const cancelled: Task = {
      ...task,
      status: "cancelled",
      requestedAction: null,
      ...(execution
        ? {
            currentExecution: {
              ...execution,
              status: "interrupted" as const,
              finishedAt: now,
            },
          }
        : {}),
      updatedAt: now,
    };
    await this.store.saveTask(project.id, cancelled);
    await this.recordEvent({
      type: "task.cancelled",
      projectId: project.id,
      taskId: task.id,
      ...(execution ? { attemptId: execution.attemptId } : {}),
    });
    if (wasActive && execution?.threadId && execution.turnId) {
      try {
        await this.dispatcher.interrupt({ project, task });
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

  private async rememberSelectionState(snapshot: ProjectSnapshot): Promise<void> {
    const fingerprint = selectionFingerprint(
      snapshot.tasks,
      this.options.maxConcurrentTasks,
    );
    if (snapshot.project.lastSelectionFingerprint === fingerprint) return;
    const project = {
      ...snapshot.project,
      lastSelectionFingerprint: fingerprint,
      updatedAt: this.now(),
    };
    await this.store.saveProject(project);
  }

  private async requireTask(taskId: string): Promise<{ project: Project; task: Task }> {
    const found = await this.store.findTask(taskId);
    if (!found) throw new Error(`Task ${taskId} was not found`);
    return found;
  }

  private async requireSnapshot(projectId: string): Promise<ProjectSnapshot> {
    const snapshot = await this.store.getProject(projectId);
    if (!snapshot) throw new Error(`Project ${projectId} was not found`);
    return snapshot;
  }

  private requireProjectExecutions(): ProjectExecutionCoordinator {
    if (!this.projectExecutions) {
      throw new Error("Project execution is not configured");
    }
    return this.projectExecutions;
  }

  private recordEvent(
    event: Omit<CodriveEvent, "eventId" | "occurredAt">,
  ): Promise<void> {
    return this.store.appendEvent({
      ...event,
      eventId: this.createId("event"),
      occurredAt: this.now(),
    });
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

function countActiveTasks(snapshots: ProjectSnapshot[]): number {
  return snapshots
    .flatMap(({ tasks }) => tasks)
    .filter(hasActiveTaskExecution).length;
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

function selectionFingerprint(tasks: Task[], maxConcurrentTasks: number): string {
  const taskStates = tasks
    .map((task) => `${task.id}:${selectionState(task)}`)
    .sort()
    .join("|");
  return `maxConcurrentTasks:${maxConcurrentTasks}|${taskStates}`;
}

function selectionState(task: Task): string {
  if (task.status === "backlog") {
    return task.requestedAction === "develop" ? "selected" : "backlog";
  }
  if (["developing", "reviewing", "changes_requested", "integrating"].includes(task.status)) {
    return "active";
  }
  return task.status;
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

function statusBeforeExecution(action: TaskExecution["action"]): Task["status"] {
  switch (action) {
    case "develop":
      return "backlog";
    case "rework":
      return "changes_requested";
    case "review":
      return "reviewing";
    case "integrate":
      return "integrating";
  }
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
