import type {
  ExecutionStatus,
  Project,
  ProjectSnapshot,
} from "./types.js";

const archiveBlockingExecutionStatuses = new Set<ExecutionStatus>([
  "pending",
  "running",
  "retry_scheduled",
  "awaiting_report",
  "waiting_for_input",
  "waiting_for_resume",
]);

export type ProjectArchiveBlocker =
  | { scope: "project"; status: ExecutionStatus }
  | { scope: "task"; taskId: string; taskTitle: string; status: ExecutionStatus };

export function isProjectArchived(project: Project): boolean {
  return project.archivedAt !== undefined;
}

export function projectCanSchedule(project: Project): boolean {
  return (
    !isProjectArchived(project) &&
    project.status === "active" &&
    project.scheduling === "running"
  );
}

export function findProjectArchiveBlocker(
  snapshot: ProjectSnapshot,
): ProjectArchiveBlocker | null {
  const projectExecution = snapshot.project.currentExecution;
  if (
    projectExecution &&
    archiveBlockingExecutionStatuses.has(projectExecution.status)
  ) {
    return { scope: "project", status: projectExecution.status };
  }

  for (const task of snapshot.tasks) {
    const execution = task.currentExecution;
    if (execution && archiveBlockingExecutionStatuses.has(execution.status)) {
      return {
        scope: "task",
        taskId: task.id,
        taskTitle: task.title,
        status: execution.status,
      };
    }
  }
  return null;
}
