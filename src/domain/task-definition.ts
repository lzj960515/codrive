import { isDeepStrictEqual } from "node:util";
import { WorkflowConflictError } from "./errors.js";
import { isProjectArchived } from "./project.js";
import type {
  Project,
  Task,
  TaskDefinitionChanges,
  UpdateTaskDefinitionInput,
} from "./types.js";

function changedTaskDefinitionFields(
  task: Task,
  changes: TaskDefinitionChanges,
): Array<keyof TaskDefinitionChanges> {
  return (
    ["title", "description", "acceptanceCriteria", "milestoneId"] as const
  ).filter(
    (field) =>
      changes[field] !== undefined &&
      !isDeepStrictEqual(task[field], changes[field]),
  );
}

export function validateTaskDefinitionUpdate(
  project: Project,
  task: Task,
  input: UpdateTaskDefinitionInput,
): {
  decisionSummary: string;
  changedFields: Array<keyof TaskDefinitionChanges>;
} {
  if (project.status === "cancelled") {
    throw new WorkflowConflictError(
      `Cancelled project ${project.id} cannot update task definitions`,
    );
  }
  if (isProjectArchived(project)) {
    throw new WorkflowConflictError(
      `Archived project ${project.id} cannot update task definitions`,
    );
  }
  if (task.origin) {
    throw new WorkflowConflictError(
      `System-generated task ${task.id} cannot update its definition`,
    );
  }
  if (
    task.status !== "backlog" ||
    task.requestedAction !== null ||
    task.currentExecution
  ) {
    throw new WorkflowConflictError(
      `Task ${task.id} must remain an unstarted backlog task before its definition can change`,
    );
  }
  if (task.updatedAt !== input.expectedUpdatedAt) {
    throw new WorkflowConflictError(
      `Task ${task.id} definition is stale; current updatedAt is ${task.updatedAt}`,
    );
  }

  const decisionSummary = input.decisionSummary.trim();
  if (!decisionSummary) {
    throw new WorkflowConflictError(
      "Task definition changes require a decision summary",
    );
  }
  if (input.changes.title !== undefined && input.changes.title.length === 0) {
    throw new WorkflowConflictError("Task definition title must not be empty");
  }
  const changedFields = changedTaskDefinitionFields(task, input.changes);
  if (changedFields.length === 0) {
    throw new WorkflowConflictError(
      `Task ${task.id} definition update does not change any fields`,
    );
  }
  return { decisionSummary, changedFields };
}

export function applyTaskDefinitionChanges(
  task: Task,
  changes: TaskDefinitionChanges,
  updatedAt: string,
): Task {
  const result: Task = {
    ...task,
    ...(changes.milestoneId ? { milestoneId: changes.milestoneId } : {}),
    ...(changes.title === undefined ? {} : { title: changes.title }),
    ...(changes.description === undefined
      ? {}
      : { description: changes.description }),
    ...(changes.acceptanceCriteria === undefined
      ? {}
      : { acceptanceCriteria: changes.acceptanceCriteria }),
    updatedAt,
  };
  if (changes.milestoneId === null) delete result.milestoneId;
  return result;
}
