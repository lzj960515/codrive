import { projectTaskActivities } from "../../domain/task-activity.js";
import type { Project, Task } from "../../domain/types.js";
import type { ProjectStore } from "../../infrastructure/project-store.js";

export async function createTaskDetailView(
  store: ProjectStore,
  project: Project,
  task: Task,
) {
  const activities = await store.listTaskActivities(project.id, task.id);
  const projection = projectTaskActivities(activities);
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
      modelRouting: task.currentExecution?.modelRouting ?? null,
      cancellation: task.cancellation ?? null,
      reviewCount: projection.reviewCount,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    },
    activities,
    conversations: {
      developmentThreadId:
        task.currentExecution?.action !== "review"
          ? (task.currentExecution?.threadId ?? projection.developmentThreadId ?? null)
          : (projection.developmentThreadId ?? null),
      reviewThreadId:
        task.currentExecution?.action === "review"
          ? (task.currentExecution.threadId ?? projection.reviewThreadId ?? null)
          : (projection.reviewThreadId ?? null),
    },
  };
}
