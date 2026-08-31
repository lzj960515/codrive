import { findCompetingIntegrationLease } from "../../application/integration-lease.js";
import type { Project, ProjectSnapshot, Task } from "../../domain/types.js";

export function createTaskDisplay(
  snapshots: ProjectSnapshot[],
  project: Project,
  task: Task,
) {
  const integrationWait = findIntegrationWait(snapshots, project, task);
  return {
    displayStatus: integrationWait ? "waiting_for_integration" : task.status,
    integrationWait,
  };
}

function findIntegrationWait(
  snapshots: ProjectSnapshot[],
  project: Project,
  task: Task,
) {
  if (
    task.status !== "integrating" ||
    task.requestedAction !== "integrate" ||
    task.currentExecution
  ) {
    return null;
  }
  const holder = findCompetingIntegrationLease(snapshots, project, task.id);
  if (!holder) return null;
  return {
    taskId: holder.task.id,
    taskTitle: holder.task.title,
    message: `「${holder.task.title}」完成合入后，本任务将自动开始合入。`,
  };
}
