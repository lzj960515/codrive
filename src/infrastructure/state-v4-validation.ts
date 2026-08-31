import type {
  CodriveEvent,
  Project,
  Task,
  TaskActivity,
} from "../domain/types.js";

const projectStatuses = new Set<string>(["active", "idle", "cancelled"]);
const schedulingStatuses = new Set<string>(["running", "paused"]);
const taskStatuses = new Set<string>([
  "backlog",
  "working",
  "reviewing",
  "integrating",
  "waiting_for_input",
  "blocked",
  "done",
  "cancelled",
]);
const taskActions = new Set<string>(["work", "review", "integrate"]);
const executionStatuses = new Set<string>([
  "pending",
  "running",
  "retry_scheduled",
  "awaiting_report",
  "waiting_for_input",
  "waiting_for_resume",
  "completed",
  "failed",
  "interrupted",
]);
const taskActivityTypes = new Set<string>([
  "work_completed",
  "review_approved",
  "review_changes_requested",
  "integration_work_required",
  "integration_completed",
  "decision_requested",
  "blocked",
  "scheduled_resume_started",
  "scheduled_resume_rescheduled",
  "execution_recovered",
  "execution_failed",
  "cancelled",
]);

export function assertCurrentProject(project: Project): Project {
  if (!projectStatuses.has(project.status)) {
    throw new Error(
      `Unsupported project lifecycle status ${String(project.status)} in schema v4`,
    );
  }
  if (!schedulingStatuses.has(project.scheduling)) {
    throw new Error(
      `Unsupported project scheduling status ${String(project.scheduling)} in schema v4`,
    );
  }
  if (
    project.requestedAction !== null &&
    project.requestedAction !== "select_tasks"
  ) {
    throw new Error(
      `Unsupported project lifecycle action ${String(project.requestedAction)} in schema v4`,
    );
  }
  if (project.currentExecution) {
    if (project.currentExecution.action !== "select_tasks") {
      throw new Error(
        `Unsupported project execution action ${String(project.currentExecution.action)} in schema v4`,
      );
    }
    assertExecutionStatus(project.currentExecution.status, "project execution");
  }
  return project;
}

export function assertCurrentTask(task: Task): Task {
  if (!taskStatuses.has(task.status)) {
    throw new Error(
      `Unsupported task lifecycle status ${String(task.status)} in schema v4`,
    );
  }
  if (task.requestedAction !== null && !taskActions.has(task.requestedAction)) {
    throw new Error(
      `Unsupported task lifecycle action ${String(task.requestedAction)} in schema v4`,
    );
  }
  if (
    task.origin &&
    task.origin.kind !== "semantic_atlas_maintenance"
  ) {
    throw new Error(`Task ${task.id} has an invalid origin in schema v4`);
  }

  const execution = task.currentExecution;
  const action = execution?.action;
  if (action && !taskActions.has(action)) {
    throw new Error(
      `Unsupported task execution action ${String(action)} in schema v4`,
    );
  }
  if (execution) {
    assertExecutionStatus(execution.status, "task execution");
  }
  if (
    ["review", "integrate"].includes(task.requestedAction ?? "") &&
    !task.workActivityId
  ) {
    throw new Error(
      `Task ${task.id} has no work activity for ${String(task.requestedAction)} in schema v4`,
    );
  }
  if (["review", "integrate"].includes(action ?? "")) {
    if (!execution?.workActivityId) {
      throw new Error(
        `Task execution ${String(execution?.attemptId)} has no work activity in schema v4`,
      );
    }
    if (execution.workActivityId !== task.workActivityId) {
      throw new Error(
        `Task execution ${execution.attemptId} has a mismatched work activity in schema v4`,
      );
    }
  }
  if (action === "work" && execution?.workActivityId) {
    throw new Error(
      `Work execution ${execution.attemptId} cannot bind a prior work activity in schema v4`,
    );
  }
  return task;
}

export function assertCurrentEvent(event: CodriveEvent): CodriveEvent {
  if (event.type === "task.changes_requested") {
    throw new Error(
      `Unsupported event lifecycle type ${event.type} in schema v4`,
    );
  }
  assertCurrentLifecycleState(event.before, "event before");
  assertCurrentLifecycleState(event.after, "event after");
  if (event.state?.task) assertCurrentTask(event.state.task);
  if (
    event.data &&
    "action" in event.data &&
    ["develop", "rework"].includes(String(event.data.action))
  ) {
    throw new Error(
      `Unsupported event data action lifecycle value ${String(event.data.action)} in schema v4`,
    );
  }
  const activity = event.data?.activity;
  if (isTaskActivity(activity)) assertCurrentActivity(activity);
  return event;
}

function assertCurrentActivity(activity: TaskActivity): void {
  if (!taskActivityTypes.has(activity.type)) {
    throw new Error(
      `Unsupported task activity type ${String(activity.type)} in schema v4`,
    );
  }
  if (activity.action && !taskActions.has(activity.action)) {
    throw new Error(
      `Unsupported task activity action ${String(activity.action)} in schema v4`,
    );
  }
  if (
    activity.type === "work_completed" &&
    activity.workActivityId !== activity.id
  ) {
    throw new Error(
      `Work activity ${activity.id} does not own its schema v4 binding`,
    );
  }
  if (
    activity.outcome &&
    ["review", "integrate"].includes(activity.action ?? "") &&
    !activity.workActivityId
  ) {
    throw new Error(
      `Task activity ${activity.id} has no work activity binding in schema v4`,
    );
  }
}

function assertCurrentLifecycleState(
  state: CodriveEvent["before"] | CodriveEvent["after"],
  label: string,
): void {
  if (!state) return;
  if (["developing", "changes_requested"].includes(state.status)) {
    throw new Error(
      `Unsupported ${label} lifecycle status ${String(state.status)} in schema v4`,
    );
  }
  if (state.requestedAction !== undefined && state.requestedAction !== null) {
    assertNoLegacyTaskAction(state.requestedAction, `${label} requested action`);
  }
  if (state.action !== undefined) {
    assertNoLegacyTaskAction(state.action, `${label} action`);
  }
  if (state.executionStatus !== undefined) {
    assertExecutionStatus(state.executionStatus, `${label} execution`);
  }
}

function assertNoLegacyTaskAction(value: unknown, label: string): void {
  if (["develop", "rework"].includes(String(value))) {
    throw new Error(
      `Unsupported ${label} lifecycle value ${String(value)} in schema v4`,
    );
  }
}

function assertExecutionStatus(value: unknown, label: string): void {
  if (typeof value !== "string" || !executionStatuses.has(value)) {
    throw new Error(
      `Unsupported ${label} status ${String(value)} in schema v4`,
    );
  }
}

export function isTaskActivity(value: unknown): value is TaskActivity {
  return Boolean(
    value &&
      typeof value === "object" &&
      "id" in value &&
      "taskId" in value &&
      "type" in value &&
      "occurredAt" in value,
  );
}
