import type { Milestone, MilestoneActivity, MilestoneResolution } from "../domain/milestone.js";

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
      `Unsupported project lifecycle status ${String(project.status)} in schema v5`,
    );
  }
  if (!schedulingStatuses.has(project.scheduling)) {
    throw new Error(
      `Unsupported project scheduling status ${String(project.scheduling)} in schema v5`,
    );
  }
  if (
    project.requestedAction !== null &&
    project.requestedAction !== "select_tasks"
  ) {
    throw new Error(
      `Unsupported project lifecycle action ${String(project.requestedAction)} in schema v5`,
    );
  }
  if (project.currentExecution) {
    if (project.currentExecution.action !== "select_tasks") {
      throw new Error(
        `Unsupported project execution action ${String(project.currentExecution.action)} in schema v5`,
      );
    }
    assertExecutionStatus(project.currentExecution.status, "project execution");
    assertReportOpportunity(project.currentExecution.reportOpportunityId);
  }
  return project;
}

export function assertCurrentTask(task: Task): Task {
  if (task.taskDocumentPath !== undefined) {
    if (
      typeof task.taskDocumentPath !== "string" ||
      !task.taskDocumentPath.trim() ||
      task.description !== undefined ||
      task.acceptanceCriteria !== undefined
    ) {
      throw new Error(`Task ${task.id} has an invalid document definition`);
    }
  } else if (
    typeof task.description !== "string" ||
    !Array.isArray(task.acceptanceCriteria)
  ) {
    throw new Error(`Task ${task.id} has no valid definition`);
  }
  if (!taskStatuses.has(task.status)) {
    throw new Error(
      `Unsupported task lifecycle status ${String(task.status)} in schema v5`,
    );
  }
  if (task.requestedAction !== null && !taskActions.has(task.requestedAction)) {
    throw new Error(
      `Unsupported task lifecycle action ${String(task.requestedAction)} in schema v5`,
    );
  }
  if (
    task.origin &&
    task.origin.kind !== "semantic_atlas_maintenance"
  ) {
    throw new Error(`Task ${task.id} has an invalid origin in schema v5`);
  }

  const execution = task.currentExecution;
  const action = execution?.action;
  if (action && !taskActions.has(action)) {
    throw new Error(
      `Unsupported task execution action ${String(action)} in schema v5`,
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
      `Task ${task.id} has no work activity for ${String(task.requestedAction)} in schema v5`,
    );
  }
  if (["review", "integrate"].includes(action ?? "")) {
    if (!execution?.workActivityId) {
      throw new Error(
        `Task execution ${String(execution?.attemptId)} has no work activity in schema v5`,
      );
    }
    if (execution.workActivityId !== task.workActivityId) {
      throw new Error(
        `Task execution ${execution.attemptId} has a mismatched work activity in schema v5`,
      );
    }
  }
  if (action === "work" && execution?.workActivityId) {
    throw new Error(
      `Work execution ${execution.attemptId} cannot bind a prior work activity in schema v5`,
    );
  }
  return task;
}

export function assertCurrentEvent(event: CodriveEvent): CodriveEvent {
  if (event.type === "task.changes_requested") {
    throw new Error(
      `Unsupported event lifecycle type ${event.type} in schema v5`,
    );
  }
  assertCurrentLifecycleState(event.before, "event before");
  assertCurrentLifecycleState(event.after, "event after");
  if (event.state?.project) assertCurrentProject(event.state.project);
  if (event.state?.task) assertCurrentTask(event.state.task);
  if (event.state?.milestone) {
    const milestone = assertCurrentMilestone(event.state.milestone);
    if (milestone.projectId !== event.projectId || milestone.id !== event.milestoneId) {
      throw new Error("Milestone recovery snapshot does not match its event");
    }
  }
  if (event.data?.milestoneActivity !== undefined) {
    const activity = assertMilestoneActivity(event.data.milestoneActivity);
    if (activity.projectId !== event.projectId || activity.milestoneId !== event.milestoneId) {
      throw new Error("Milestone activity does not match its event");
    }
  }
  if (
    event.data &&
    "action" in event.data &&
    ["develop", "rework"].includes(String(event.data.action))
  ) {
    throw new Error(
      `Unsupported event data action lifecycle value ${String(event.data.action)} in schema v5`,
    );
  }
  const activity = event.data?.activity;
  if (isTaskActivity(activity)) assertCurrentActivity(activity);
  return event;
}

function assertCurrentActivity(activity: TaskActivity): void {
  if (!taskActivityTypes.has(activity.type)) {
    throw new Error(
      `Unsupported task activity type ${String(activity.type)} in schema v5`,
    );
  }
  if (activity.action && !taskActions.has(activity.action)) {
    throw new Error(
      `Unsupported task activity action ${String(activity.action)} in schema v5`,
    );
  }
  if (
    activity.type === "work_completed" &&
    activity.workActivityId !== activity.id
  ) {
    throw new Error(
      `Work activity ${activity.id} does not own its schema v5 binding`,
    );
  }
  if (
    activity.outcome &&
    ["review", "integrate"].includes(activity.action ?? "") &&
    !activity.workActivityId
  ) {
    throw new Error(
      `Task activity ${activity.id} has no work activity binding in schema v5`,
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
      `Unsupported ${label} lifecycle status ${String(state.status)} in schema v5`,
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
      `Unsupported ${label} lifecycle value ${String(value)} in schema v5`,
    );
  }
}

function assertExecutionStatus(value: unknown, label: string): void {
  if (typeof value !== "string" || !executionStatuses.has(value)) {
    throw new Error(
      `Unsupported ${label} status ${String(value)} in schema v5`,
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


export function assertCurrentMilestone(milestone: Milestone): Milestone {
  if (!["active", "done"].includes(milestone.status)) {
    throw new Error(`Milestone ${milestone.id} has an invalid status`);
  }
  if (!nonemptyString(milestone.id) || !nonemptyString(milestone.projectId) ||
      !positiveInteger(milestone.definitionVersion)) {
    throw new Error("Milestone identity or definition version is invalid");
  }
  if (milestone.currentExecution) {
    if (milestone.currentExecution.action !== "assess_milestone") {
      throw new Error("Invalid milestone execution action");
    }
    assertExecutionStatus(milestone.currentExecution.status, "milestone execution");
    assertReportOpportunity(milestone.currentExecution.reportOpportunityId);
  }
  return milestone;
}

export function isMilestoneActivity(value: unknown): value is MilestoneActivity {
  if (!value || typeof value !== "object") return false;
  const activity = value as Partial<MilestoneActivity>;
  return nonemptyString(activity.id) && nonemptyString(activity.milestoneId) &&
    nonemptyString(activity.projectId) && nonemptyString(activity.occurredAt) &&
    nonemptyString(activity.summary) &&
    ["discovery", "assessment", "resolution"].includes(activity.type ?? "");
}

function assertMilestoneActivity(value: unknown): MilestoneActivity {
  if (!isMilestoneActivity(value)) throw new Error("Invalid milestone activity");
  if (value.type === "assessment") {
    const report = value.report;
    if (!report || report.milestoneId !== value.milestoneId ||
        !nonemptyString(report.attemptId) || !nonemptyString(report.summary) ||
        !positiveInteger(report.definitionVersion) || !positiveInteger(report.planningRevision) ||
        !["progress", "needs_input", "blocked", "completed"].includes(report.outcome) ||
        !stringArray(value.createdTaskIds) || !optionalStringArray(report.evidence)) {
      throw new Error("Invalid milestone assessment report");
    }
    assertReportOpportunity(report.reportOpportunityId);
    for (const resolution of report.plan?.resolutions ?? []) {
      assertMilestoneResolution(resolution);
    }
  }
  if (value.type === "discovery" &&
      (!nonemptyString(value.requestId) || !nonemptyString(value.taskId) ||
       !nonemptyString(value.attemptId) || !stringArray(value.evidence) ||
       !stringArray(value.affectedTaskIds))) {
    throw new Error("Invalid milestone discovery");
  }
  if (value.type === "resolution") {
    if (!nonemptyString(value.assessmentActivityId)) {
      throw new Error("Invalid milestone resolution identity");
    }
    assertMilestoneResolution(value.resolution);
  }
  return value;
}

function assertMilestoneResolution(resolution: MilestoneResolution): void {
  if (!resolution || !stringArray(resolution.sourceActivityIds) ||
      !nonemptyString(resolution.summary) ||
      (resolution.question !== undefined && !nonemptyString(resolution.question)) ||
      !optionalStringArray(resolution.affectedTaskIds) ||
      !optionalStringArray(resolution.waitForTaskIds)) {
    throw new Error("Invalid milestone resolution");
  }
}

function assertReportOpportunity(value: unknown): void {
  if (!nonemptyString(value)) {
    throw new Error("Planning execution requires a report opportunity");
  }
}

function nonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function positiveInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(nonemptyString);
}

function optionalStringArray(value: unknown): boolean {
  return value === undefined || stringArray(value);
}
