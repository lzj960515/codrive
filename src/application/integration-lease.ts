import { resolve } from "node:path";

import type {
  ExecutionStatus,
  Project,
  ProjectSnapshot,
  Task,
} from "../domain/types.js";

const integrationLeaseStatuses = new Set<ExecutionStatus>([
  "pending",
  "running",
  "retry_scheduled",
  "awaiting_report",
  "waiting_for_input",
]);

export interface IntegrationLeaseHolder {
  project: Project;
  task: Task;
}

export function taskHoldsIntegrationLease(
  task: Task,
  restrictedTaskIds: ReadonlySet<string> = new Set(),
): boolean {
  const execution = task.currentExecution;
  if (
    execution?.status === "waiting_for_input" &&
    restrictedTaskIds.has(task.id)
  )
    return false;
  return Boolean(
    execution?.action === "integrate" &&
      integrationLeaseStatuses.has(execution.status),
  );
}

export function findCompetingIntegrationLease(
  snapshots: ProjectSnapshot[],
  project: Project,
  taskId: string,
  restrictedTaskIds?: ReadonlySet<string>,
): IntegrationLeaseHolder | null {
  const repository = resolve(project.repositoryPath);
  for (const candidate of snapshots) {
    if (resolve(candidate.project.repositoryPath) !== repository) continue;
    for (const task of candidate.tasks) {
      if (candidate.project.id === project.id && task.id === taskId) continue;
      if (taskHoldsIntegrationLease(task, restrictedTaskIds)) {
        return { project: candidate.project, task };
      }
    }
  }
  return null;
}

export function activeIntegrationRepositories(
  snapshots: ProjectSnapshot[],
  restrictedTaskIds?: ReadonlySet<string>,
): Set<string> {
  return new Set(
    snapshots.flatMap(({ project, tasks }) =>
      tasks.some((task) => taskHoldsIntegrationLease(task, restrictedTaskIds))
        ? [resolve(project.repositoryPath)]
        : [],
    ),
  );
}
