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
  developmentThreadId?: string;
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
  threadId,
  occurredAt,
}: CreateTaskReportActivityInput): TaskActivity {
  const evidence = reportEvidence(report);
  return {
    id: activityId,
    projectId,
    taskId: report.taskId,
    type: activityType(action, report.outcome),
    action,
    outcome: report.outcome,
    attemptId: report.attemptId,
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
  if (!activity.attemptId || !activity.outcome || !activity.action) {
    throw new Error(`Activity ${activity.id} is not a task report`);
  }
  return {
    taskId: activity.taskId,
    attemptId: activity.attemptId,
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
): TaskActivityProjection {
  const projection: TaskActivityProjection = {
    delivery: {},
    conversations: { reviewCount: 0 },
    latestDecisionRequest: null,
  };
  const reviewAttempts = new Set<string>();

  for (const activity of activities) {
    const evidence = activity.evidence;
    if (evidence?.workspacePath) {
      projection.delivery.workspacePath = evidence.workspacePath;
    }
    if (evidence?.baseCommit) {
      projection.delivery.baseCommit = evidence.baseCommit;
    }
    if (evidence?.candidateCommit) {
      projection.delivery.candidateCommit = evidence.candidateCommit;
    }
    if (evidence?.reviewedMainCommit) {
      projection.delivery.reviewedMainCommit = evidence.reviewedMainCommit;
    }
    if (evidence?.mergedCommit) {
      projection.delivery.mergedCommit = evidence.mergedCommit;
    }

    if (activity.action === "review") {
      if (activity.attemptId) reviewAttempts.add(activity.attemptId);
      if (activity.threadId) {
        projection.conversations.reviewThreadId = activity.threadId;
      }
    } else if (activity.threadId) {
      projection.conversations.developmentThreadId = activity.threadId;
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
  return projection;
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
  if (action === "develop" && outcome === "completed") {
    return "development_completed";
  }
  if (action === "rework" && outcome === "completed") return "rework_completed";
  if (action === "review" && outcome === "approved") return "review_approved";
  if (action === "review" && outcome === "changes_requested") {
    return "review_changes_requested";
  }
  if (action === "integrate" && outcome === "needs_review") {
    return "review_requested";
  }
  if (action === "integrate" && outcome === "completed") {
    return "integration_completed";
  }
  throw new Error(`Outcome ${outcome} is invalid for ${action}`);
}
