import { isDeepStrictEqual } from "node:util";

import type {
  TaskAction,
  TaskActivity,
  TaskActivityEvidence,
  TaskActivityType,
  TaskReport,
} from "./types.js";

const reportEvidenceFields = [
  "workspacePath",
  "baseCommit",
  "candidateCommit",
  "reviewedMainCommit",
  "mergedCommit",
  "tests",
  "findings",
  "question",
  "resumeAt",
  "resumePrompt",
] as const satisfies ReadonlyArray<keyof TaskReport>;

export interface CreateTaskReportActivityInput {
  activityId: string;
  projectId: string;
  action: TaskAction;
  report: TaskReport;
  workActivityId?: string;
  threadId?: string;
  occurredAt: string;
}

export interface CreateTaskLifecycleActivityInput {
  activityId: string;
  projectId: string;
  taskId: string;
  type:
    | "scheduled_resume_started"
    | "scheduled_resume_rescheduled"
    | "execution_recovered"
    | "execution_failed"
    | "cancelled";
  summary: string;
  occurredAt: string;
  attemptId?: string;
  action?: TaskAction;
  threadId?: string;
  evidence?: TaskActivityEvidence;
}

export interface TaskDeliveryProjection {
  workspacePath?: string;
  baseCommit?: string;
  candidateCommit?: string;
  reviewedMainCommit?: string;
  mergedCommit?: string;
}

export interface TaskConversationProjection {
  workThreadId?: string;
  reviewThreadId?: string;
  reviewCount: number;
}

export interface TaskActivityProjection {
  delivery: TaskDeliveryProjection;
  conversations: TaskConversationProjection;
  latestDecisionRequest: TaskActivity | null;
}

export function createTaskReportActivity({
  activityId,
  projectId,
  action,
  report,
  workActivityId,
  threadId,
  occurredAt,
}: CreateTaskReportActivityInput): TaskActivity {
  const evidence = reportEvidence(report);
  const type = activityType(action, report.outcome);
  return {
    id: activityId,
    projectId,
    taskId: report.taskId,
    type,
    action,
    outcome: report.outcome,
    attemptId: report.attemptId,
    reportOpportunityId: report.reportOpportunityId,
    ...(type === "work_completed"
      ? { workActivityId: activityId }
      : workActivityId
        ? { workActivityId }
        : {}),
    summary: report.summary,
    occurredAt,
    ...(threadId ? { threadId } : {}),
    ...(evidence ? { evidence } : {}),
  };
}

export function createTaskLifecycleActivity({
  activityId,
  projectId,
  taskId,
  type,
  summary,
  occurredAt,
  attemptId,
  action,
  threadId,
  evidence,
}: CreateTaskLifecycleActivityInput): TaskActivity {
  return {
    id: activityId,
    projectId,
    taskId,
    type,
    summary,
    occurredAt,
    ...(attemptId ? { attemptId } : {}),
    ...(action ? { action } : {}),
    ...(threadId ? { threadId } : {}),
    ...(evidence ? { evidence } : {}),
  };
}

export function taskReportFromActivity(activity: TaskActivity): TaskReport {
  if (
    !activity.attemptId ||
    !activity.reportOpportunityId ||
    !activity.outcome ||
    !activity.action
  ) {
    throw new Error(`Activity ${activity.id} is not a task report`);
  }
  return {
    taskId: activity.taskId,
    attemptId: activity.attemptId,
    reportOpportunityId: activity.reportOpportunityId,
    outcome: activity.outcome,
    summary: activity.summary,
    ...activity.evidence,
  };
}

export function taskActivityMatchesReport(
  activity: TaskActivity,
  report: TaskReport,
): boolean {
  if (!activity.outcome) return false;
  return isDeepStrictEqual(taskReportFromActivity(activity), report);
}

export function projectTaskActivities(
  activities: readonly TaskActivity[],
  workActivityId?: string,
): TaskActivityProjection {
  const projection: TaskActivityProjection = {
    delivery: {},
    conversations: { reviewCount: 0 },
    latestDecisionRequest: null,
  };
  const reviewAttempts = new Set<string>();
  let latestWorkspacePath: string | undefined;
  let latestBaseCommit: string | undefined;
  const targetWorkActivityId = workActivityId ?? lastWorkActivityId(activities);

  for (const activity of activities) {
    const evidence = activity.evidence;
    if (evidence?.workspacePath) latestWorkspacePath = evidence.workspacePath;
    if (evidence?.baseCommit) latestBaseCommit = evidence.baseCommit;

    if (activity.id === targetWorkActivityId) {
      projection.delivery = {
        ...(evidence?.workspacePath
          ? { workspacePath: evidence.workspacePath }
          : latestWorkspacePath
            ? { workspacePath: latestWorkspacePath }
            : {}),
        ...(evidence?.baseCommit
          ? { baseCommit: evidence.baseCommit }
          : latestBaseCommit
            ? { baseCommit: latestBaseCommit }
            : {}),
        ...(evidence?.candidateCommit
          ? { candidateCommit: evidence.candidateCommit }
          : {}),
      };
    } else if (activity.workActivityId === targetWorkActivityId) {
      if (evidence?.reviewedMainCommit) {
        projection.delivery.reviewedMainCommit = evidence.reviewedMainCommit;
      }
      if (evidence?.mergedCommit) {
        projection.delivery.mergedCommit = evidence.mergedCommit;
      }
    }

    if (activity.action === "review") {
      if (activity.attemptId) reviewAttempts.add(activity.attemptId);
      if (activity.threadId) {
        projection.conversations.reviewThreadId = activity.threadId;
      }
    } else if (activity.threadId) {
      projection.conversations.workThreadId = activity.threadId;
    }

    if (activity.type === "decision_requested") {
      projection.latestDecisionRequest = activity;
    } else if (
      projection.latestDecisionRequest?.attemptId &&
      projection.latestDecisionRequest.attemptId === activity.attemptId
    ) {
      projection.latestDecisionRequest = null;
    }
  }

  projection.conversations.reviewCount = reviewAttempts.size;
  if (!projection.delivery.workspacePath && latestWorkspacePath) {
    projection.delivery.workspacePath = latestWorkspacePath;
  }
  if (!projection.delivery.baseCommit && latestBaseCommit) {
    projection.delivery.baseCommit = latestBaseCommit;
  }
  return projection;
}

function lastWorkActivityId(
  activities: readonly TaskActivity[],
): string | undefined {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    if (activities[index]?.type === "work_completed") {
      return activities[index]!.id;
    }
  }
  return undefined;
}

function reportEvidence(report: TaskReport): TaskActivityEvidence | undefined {
  const entries = reportEvidenceFields.flatMap((field) =>
    report[field] === undefined ? [] : [[field, report[field]] as const],
  );
  return entries.length > 0
    ? (Object.fromEntries(entries) as TaskActivityEvidence)
    : undefined;
}

function activityType(
  action: TaskAction,
  outcome: TaskReport["outcome"],
): TaskActivityType {
  if (outcome === "needs_input") return "decision_requested";
  if (outcome === "blocked") return "blocked";
  if (action === "work" && outcome === "completed") return "work_completed";
  if (action === "review" && outcome === "approved") return "review_approved";
  if (action === "review" && outcome === "changes_requested") {
    return "review_changes_requested";
  }
  if (action === "integrate" && outcome === "needs_review") {
    return "work_completed";
  }
  if (action === "integrate" && outcome === "work_required") {
    return "integration_work_required";
  }
  if (action === "integrate" && outcome === "completed") {
    return "integration_completed";
  }
  throw new Error(`Outcome ${outcome} is invalid for ${action}`);
}
