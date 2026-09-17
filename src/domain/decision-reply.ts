import { projectMilestoneActivities } from "./milestone-activity.js";
import type { Milestone, MilestoneActivity } from "./milestone.js";
import { projectCanSchedule } from "./project.js";
import type { Project, Task, TaskActivity } from "./types.js";

export interface DecisionReplyTarget {
  scope: "task" | "project" | "milestone";
  id: string;
  reportOpportunityId: string;
}

export interface DecisionReplyInput extends DecisionReplyTarget {
  message: string;
}

export function taskDecisionReply(
  project: Project,
  task: Task,
  activities: readonly TaskActivity[],
): DecisionReplyTarget | null {
  const execution = task.currentExecution;
  const decision = activities.find(
    (activity) =>
      activity.id === execution?.submittedActivityId &&
      activity.type === "decision_requested",
  );
  if (
    !projectCanSchedule(project) ||
    task.status !== "waiting_for_input" ||
    execution?.status !== "waiting_for_input" ||
    !execution.threadId ||
    !execution.turnCompletedAt ||
    !decision
  )
    return null;
  return {
    scope: "task",
    id: task.id,
    reportOpportunityId: execution.reportOpportunityId,
  };
}

export function projectDecisionReply(
  project: Project,
): DecisionReplyTarget | null {
  const execution = project.currentExecution;
  if (
    !projectCanSchedule(project) ||
    execution?.status !== "completed" ||
    !execution.turnCompletedAt ||
    !project.planningThreadId ||
    execution.threadId !== project.planningThreadId ||
    execution.result?.outcome !== "needs_input" ||
    execution.planningRevision !== project.planning.revision
  )
    return null;
  return {
    scope: "project",
    id: project.id,
    reportOpportunityId: execution.reportOpportunityId,
  };
}

export function milestoneDecisionReply(
  project: Project,
  milestone: Milestone,
  activities: readonly MilestoneActivity[],
): DecisionReplyTarget | null {
  const execution = milestone.currentExecution;
  const hasQuestion = projectMilestoneActivities(
    activities,
  ).unresolvedActivities.some(
    (activity) =>
      activity.type === "resolution" && Boolean(activity.resolution.question),
  );
  if (
    !projectCanSchedule(project) ||
    milestone.status !== "active" ||
    execution?.status !== "completed" ||
    !execution.turnCompletedAt ||
    !milestone.threadId ||
    execution.threadId !== milestone.threadId ||
    !hasQuestion
  )
    return null;
  return {
    scope: "milestone",
    id: milestone.id,
    reportOpportunityId: execution.reportOpportunityId,
  };
}
