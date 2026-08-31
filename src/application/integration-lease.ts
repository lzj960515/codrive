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

export function taskHoldsIntegrationLease(task: Task): boolean {
  const execution = task.currentExecution;
  return Boolean(
    execution?.action === "integrate" &&
      integrationLeaseStatuses.has(execution.status),
  );
}

export function findCompetingIntegrationLease(
  snapshots: ProjectSnapshot[],
  project: Project,
  taskId: string,
): IntegrationLeaseHolder | null {
  const repository = resolve(project.repositoryPath);
  for (const candidate of snapshots) {
    if (resolve(candidate.project.repositoryPath) !== repository) continue;
    for (const task of candidate.tasks) {
      if (candidate.project.id === project.id && task.id === taskId) continue;
      if (taskHoldsIntegrationLease(task)) {
        return { project: candidate.project, task };
      }
    }
  }
  return null;
}

export function activeIntegrationRepositories(
  snapshots: ProjectSnapshot[],
): Set<string> {
  return new Set(
    snapshots.flatMap(({ project, tasks }) =>
      tasks.some(taskHoldsIntegrationLease)
        ? [resolve(project.repositoryPath)]
        : [],
    ),
  );
}
