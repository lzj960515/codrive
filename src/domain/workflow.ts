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
]);

export function startTaskExecution(
  task: Task,
  attemptId: string,
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
      action,
      status: "pending",
      startedAt: now,
      modelRouting,
    },
    updatedAt: now,
  };

  if (action === "review") {
    nextTask.reviewAttempts = [
      ...task.reviewAttempts,
      { attemptId, createdAt: now },
    ];
  }

  return nextTask;
}

export function applyTaskReport(
  task: Task,
  report: TaskReport,
  now: string,
): Task {
  validateTaskReport(task, report);
  const execution = task.currentExecution!;
  if (report.outcome === "needs_input") {
    return suspendTaskForInput(task, report, now);
  }
  const transition = transitionForReport(execution.action, report.outcome);
  const nextTask: Task = {
    ...task,
    ...reportArtifacts(report),
    status: transition.status,
    requestedAction: transition.action,
    latestReport: report,
    currentExecution: {
      ...execution,
      status: "completed",
      finishedAt: now,
    },
    updatedAt: now,
  };

  if (execution.action === "review") {
    nextTask.reviewAttempts = task.reviewAttempts.map((attempt) =>
      attempt.attemptId === execution.attemptId
        ? { ...attempt, outcome: report.outcome, completedAt: now }
        : attempt,
    );
  }

  return nextTask;
}

function suspendTaskForInput(task: Task, report: TaskReport, now: string): Task {
  return {
    ...task,
    latestReport: report,
    status: "waiting_for_input",
    currentExecution: {
      ...task.currentExecution!,
      status: "waiting_for_input",
      report,
    },
    updatedAt: now,
  };
}

export function validateTaskReport(task: Task, report: TaskReport): void {
  const execution = task.currentExecution;
  if (
    report.taskId !== task.id ||
    !execution ||
    execution.attemptId !== report.attemptId
  ) {
    throw new Error(`Report does not match the current execution for ${task.id}`);
  }

  validateReportArtifacts(execution.action, report);
  if (report.outcome !== "needs_input") {
    transitionForReport(execution.action, report.outcome);
  }
}

function validateReportArtifacts(
  action: TaskAction,
  report: TaskReport,
): void {
  if (report.outcome === "needs_input") {
    requireReportFields(report, ["question"]);
  }
  if (action === "develop" && report.outcome === "completed") {
    requireReportFields(report, ["workspacePath", "candidateCommit"]);
  }
  if (action === "rework" && report.outcome === "completed") {
    requireReportFields(report, ["candidateCommit"]);
  }
  if (action === "review" && report.outcome === "approved") {
    requireReportFields(report, ["reviewedMainCommit"]);
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
    requireReportFields(report, ["candidateCommit"]);
  }
  if (action === "integrate" && report.outcome === "completed") {
    requireReportFields(report, ["mergedCommit"]);
  }
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
    case "develop":
    case "rework":
      return "developing";
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

  if ((action === "develop" || action === "rework") && outcome === "completed") {
    return { status: "reviewing", action: "review" };
  }
  if (action === "review" && outcome === "changes_requested") {
    return { status: "changes_requested", action: "rework" };
  }
  if (action === "review" && outcome === "approved") {
    return { status: "integrating", action: "integrate" };
  }
  if (action === "integrate" && outcome === "needs_review") {
    return { status: "reviewing", action: "review" };
  }
  if (action === "integrate" && outcome === "completed") {
    return { status: "done", action: null };
  }

  throw new Error(`Outcome ${outcome} is invalid for ${action}`);
}

function reportArtifacts(report: TaskReport): Partial<Task> {
  return Object.fromEntries(
    [
      "workspacePath",
      "baseCommit",
      "candidateCommit",
      "reviewedMainCommit",
      "mergedCommit",
    ]
      .map((key) => [key, report[key as keyof TaskReport]])
      .filter(([, value]) => value !== undefined),
  );
}
