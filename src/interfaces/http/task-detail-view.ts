import { projectTaskActivities } from "../../domain/task-activity.js";
import type { Project, Task } from "../../domain/types.js";
import type { ProjectStore } from "../../infrastructure/project-store.js";

export async function createTaskDetailView(
  store: ProjectStore,
  project: Project,
  task: Task,
) {
  const activities = await store.listTaskActivities(project.id, task.id);
  const publicActivities = activities.map((activity) => {
    if (!activity.evidence?.resumePrompt) return activity;
    const { resumePrompt: _resumePrompt, ...evidence } = activity.evidence;
    return { ...activity, evidence };
  });
  const projection = projectTaskActivities(activities);
  const currentExecution = task.currentExecution
    ? {
        action: task.currentExecution.action,
        status: task.currentExecution.status,
        threadId: task.currentExecution.threadId ?? null,
        scheduledResume: task.currentExecution.scheduledResume
          ? {
              reason: task.currentExecution.scheduledResume.reason,
              resumeAt: task.currentExecution.scheduledResume.resumeAt,
            }
          : null,
      }
    : null;
  const currentDecisionRequest =
    task.currentExecution?.status === "waiting_for_input" &&
    task.currentExecution.submittedActivityId
      ? (activities.find(
          ({ id, type }) =>
            id === task.currentExecution?.submittedActivityId &&
            type === "decision_requested",
        ) ?? null)
      : null;

  return {
    task: {
      id: task.id,
      projectId: task.projectId,
      title: task.title,
      description: task.description,
      acceptanceCriteria: task.acceptanceCriteria,
      order: task.order,
      status: task.status,
      requestedAction: task.requestedAction,
      executionStatus: task.currentExecution?.status ?? null,
      currentExecution,
      modelRouting: task.currentExecution?.modelRouting ?? null,
      cancellation: task.cancellation ?? null,
      reviewCount: projection.reviewCount,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    },
    activities: publicActivities,
    currentDecisionRequest,
  };
}
