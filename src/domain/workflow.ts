import type {
  ExecutionModelRouting,
  Task,
  TaskAction,
  TaskReport,
  TaskStatus,
} from "./types.js";
import { InvalidTaskReportError } from "./errors.js";

const occupiedExecutionStatuses = new Set([
  "pending",
  "running",
  "retry_scheduled",
  "awaiting_report",
  "waiting_for_input",
  "waiting_for_resume",
]);

export function startTaskExecution(
  task: Task,
  attemptId: string,
  reportOpportunityId: string,
  now: string,
  modelRouting: ExecutionModelRouting,
): Task {
  const action = task.requestedAction;
  if (!action) {
    throw new Error(`Task ${task.id} has no requested action`);
  }
  if (
    task.currentExecution &&
    occupiedExecutionStatuses.has(task.currentExecution.status)
  ) {
    throw new Error(`Task ${task.id} already has an active execution`);
  }

  const nextTask: Task = {
    ...task,
    status: statusForAction(action),
    currentExecution: {
      attemptId,
      reportOpportunityId,
      action,
      status: "pending",
      startedAt: now,
      modelRouting,
      ...(["review", "integrate"].includes(action)
        ? { workActivityId: requireWorkActivity(task) }
        : {}),
    },
    updatedAt: now,
  };

  return nextTask;
}

export function applyTaskReport(
  task: Task,
  report: TaskReport,
  now: string,
  reportSubmittedAt = now,
): Task {
  validateTaskReport(task, report, reportSubmittedAt);
  const execution = task.currentExecution!;
  if (report.outcome === "needs_input") {
    return suspendTaskForInput(task, report, now);
  }
  if (isScheduledBlocker(report)) {
    return suspendTaskForScheduledResume(task, report, now);
  }
  const transition = transitionForReport(execution.action, report.outcome);
  const { currentExecution: _completedExecution, ...taskWithoutExecution } = task;
  const nextTask: Task = {
    ...taskWithoutExecution,
    status: transition.status,
    requestedAction: transition.action,
    modelRouting: execution.modelRouting,
    ...(reportCreatesWorkResult(execution.action, report.outcome)
      ? { workActivityId: requireSubmittedActivity(execution) }
      : {}),
    updatedAt: now,
  };
  return nextTask;
}

function suspendTaskForScheduledResume(
  task: Task,
  report: TaskReport,
  now: string,
): Task {
  return {
    ...task,
    status: "blocked",
    currentExecution: {
      ...task.currentExecution!,
      status: "waiting_for_resume",
      scheduledResume: {
        reason: report.summary,
        resumeAt: report.resumeAt!,
        resumePrompt: report.resumePrompt!,
      },
    },
    updatedAt: now,
  };
}

function suspendTaskForInput(task: Task, report: TaskReport, now: string): Task {
  return {
    ...task,
    status: "waiting_for_input",
    currentExecution: {
      ...task.currentExecution!,
      status: "waiting_for_input",
    },
    updatedAt: now,
  };
}

export function validateTaskReport(
  task: Task,
  report: TaskReport,
  now: string,
): void {
  const execution = task.currentExecution;
  if (
    report.taskId !== task.id ||
    !execution ||
    execution.attemptId !== report.attemptId
  ) {
    throw new Error(`Report does not match the current execution for ${task.id}`);
  }

  validateReportArtifacts(execution.action, report, now);
  if (report.outcome !== "needs_input") {
    transitionForReport(execution.action, report.outcome);
  }
}

function validateReportArtifacts(
  action: TaskAction,
  report: TaskReport,
  now: string,
): void {
  validateScheduledBlocker(report, now);
  if (report.outcome === "needs_input") {
    requireReportFields(report, ["question"]);
  }
  if (
    action === "work" &&
    report.outcome === "completed" &&
    report.candidateCommit
  ) {
    requireReportFields(report, ["workspacePath"]);
  }
  if (
    action === "review" &&
    report.outcome === "changes_requested" &&
    !report.findings?.length
  ) {
    throw new InvalidTaskReportError(
      `Report ${report.attemptId} requires findings for changes_requested`,
    );
  }
  if (action === "integrate" && report.outcome === "needs_review") {
    requireReportFields(report, [
      "workspacePath",
      "candidateCommit",
    ]);
  }
}

const rfc3339AbsoluteTime =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function validateScheduledBlocker(report: TaskReport, now: string): void {
  const hasResumeAt = report.resumeAt !== undefined;
  const hasResumePrompt = report.resumePrompt !== undefined;
  if (hasResumeAt !== hasResumePrompt) {
    throw new InvalidTaskReportError(
      `Report ${report.attemptId} requires resumeAt and resumePrompt together`,
    );
  }
  if (!hasResumeAt) return;
  if (report.outcome !== "blocked") {
    throw new InvalidTaskReportError(
      `Report ${report.attemptId} can only schedule resume for blocked`,
    );
  }
  if (!report.resumePrompt?.trim()) {
    throw new InvalidTaskReportError(
      `Report ${report.attemptId} requires a non-empty resumePrompt`,
    );
  }
  if (
    !rfc3339AbsoluteTime.test(report.resumeAt!) ||
    !Number.isFinite(Date.parse(report.resumeAt!))
  ) {
    throw new InvalidTaskReportError(
      `Report ${report.attemptId} resumeAt must be an RFC 3339 absolute time`,
    );
  }
  if (Date.parse(report.resumeAt!) <= Date.parse(now)) {
    throw new InvalidTaskReportError(
      `Report ${report.attemptId} resumeAt must be in the future`,
    );
  }
}

function isScheduledBlocker(report: TaskReport): boolean {
  return report.outcome === "blocked" && report.resumeAt !== undefined;
}

function requireReportFields(
  report: TaskReport,
  fields: Array<keyof TaskReport>,
): void {
  const missing = fields.filter((field) => !report[field]);
  if (missing.length > 0) {
    throw new InvalidTaskReportError(
      `Report ${report.attemptId} requires ${missing.join(", ")} for ${report.outcome}`,
    );
  }
}

function statusForAction(action: TaskAction): TaskStatus {
  switch (action) {
    case "work":
      return "working";
    case "review":
      return "reviewing";
    case "integrate":
      return "integrating";
  }
}

function transitionForReport(
  action: TaskAction,
  outcome: TaskReport["outcome"],
): { status: TaskStatus; action: TaskAction | null } {
  if (outcome === "blocked") {
    return { status: "blocked", action };
  }

  if (action === "work" && outcome === "completed") {
    return { status: "reviewing", action: "review" };
  }
  if (action === "review" && outcome === "changes_requested") {
    return { status: "working", action: "work" };
  }
  if (action === "review" && outcome === "approved") {
    return { status: "integrating", action: "integrate" };
  }
  if (action === "integrate" && outcome === "needs_review") {
    return { status: "reviewing", action: "review" };
  }
  if (action === "integrate" && outcome === "work_required") {
    return { status: "working", action: "work" };
  }
  if (action === "integrate" && outcome === "completed") {
    return { status: "done", action: null };
  }

  throw new Error(`Outcome ${outcome} is invalid for ${action}`);
}

function requireWorkActivity(task: Task): string {
  if (!task.workActivityId) {
    throw new Error(`Task ${task.id} has no work activity for review or integration`);
  }
  return task.workActivityId;
}

function requireSubmittedActivity(
  execution: NonNullable<Task["currentExecution"]>,
): string {
  if (!execution.submittedActivityId) {
    throw new Error(`Task execution ${execution.attemptId} has no submitted activity`);
  }
  return execution.submittedActivityId;
}

function reportCreatesWorkResult(
  action: TaskAction,
  outcome: TaskReport["outcome"],
): boolean {
  return (
    (action === "work" && outcome === "completed") ||
    (action === "integrate" && outcome === "needs_review")
  );
}
