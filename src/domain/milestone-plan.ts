import { WorkflowConflictError } from "./errors.js";
import { projectMilestoneActivities } from "./milestone-activity.js";
import type {
  Milestone,
  MilestoneActivity,
  MilestoneReport,
  MilestoneResolution,
} from "./milestone.js";
import { isProjectArchived } from "./project.js";
import { validateTaskDefinitionUpdate } from "./task-definition.js";
import type { ProjectSnapshot, Task } from "./types.js";

export function validateMilestonePlan(
  snapshot: ProjectSnapshot,
  milestone: Milestone,
  activities: MilestoneActivity[],
  report: MilestoneReport,
): void {
  validateTarget(snapshot, milestone, report);
  const tasks = new Map(snapshot.tasks.map((task) => [task.id, task]));
  const keys = validateNewTaskKeys(tasks, report);
  const unresolved =
    projectMilestoneActivities(activities).unresolvedActivities;
  const consumed = validateResolutions(
    tasks,
    keys,
    milestone.id,
    unresolved,
    report,
  );
  const remainingResolutions = unresolved.flatMap((activity) =>
    activity.type === "resolution" && !consumed.has(activity.id)
      ? [activity.resolution]
      : [],
  );
  validatePrerequisites([
    ...remainingResolutions,
    ...(report.plan?.resolutions ?? []),
  ]);
  validateTaskChanges(snapshot, milestone, tasks, report);
  validateOutcome(snapshot, milestone, unresolved, consumed, report);
}

function validateTarget(
  snapshot: ProjectSnapshot,
  milestone: Milestone,
  report: MilestoneReport,
): void {
  if (
    milestone.status !== "active" ||
    snapshot.project.status === "cancelled" ||
    isProjectArchived(snapshot.project)
  )
    throw new WorkflowConflictError("Milestone cannot accept reports");
  if (
    report.definitionVersion !== milestone.definitionVersion ||
    report.definitionVersion !==
      milestone.currentExecution?.definitionVersion ||
    report.planningRevision !== milestone.currentExecution?.planningRevision
  )
    throw new WorkflowConflictError(
      "Milestone report uses stale target or execution facts",
    );
}

function validateNewTaskKeys(
  tasks: Map<string, Task>,
  report: MilestoneReport,
): Set<string> {
  const additions = report.plan?.tasks ?? [];
  const keys = new Set(additions.map((task) => task.key));
  if (
    keys.size !== additions.length ||
    additions.some((task) => !task.key.trim() || tasks.has(task.key))
  )
    throw new WorkflowConflictError(
      "New task keys must be distinct local references",
    );
  return keys;
}

function validateResolutions(
  tasks: Map<string, Task>,
  keys: Set<string>,
  milestoneId: string,
  unresolved: MilestoneActivity[],
  report: MilestoneReport,
): Set<string> {
  const sources = new Set(unresolved.map((activity) => activity.id));
  const consumed = new Set<string>();
  for (const resolution of report.plan?.resolutions ?? []) {
    for (const id of resolution.sourceActivityIds) {
      if (!sources.has(id) || consumed.has(id))
        throw new WorkflowConflictError(
          `Activity ${id} is stale or already resolved`,
        );
      consumed.add(id);
    }
    for (const id of [
      ...(resolution.affectedTaskIds ?? []),
      ...(resolution.waitForTaskIds ?? []),
    ]) {
      if (!keys.has(id) && tasks.get(id)?.milestoneId !== milestoneId)
        throw new WorkflowConflictError(
          `Task reference ${id} is outside this milestone`,
        );
    }
    if (
      (resolution.waitForTaskIds ?? []).some((id) =>
        resolution.affectedTaskIds?.includes(id),
      )
    )
      throw new WorkflowConflictError(
        "A prerequisite task cannot wait on itself",
      );
    if (
      resolution.waitForTaskIds?.some(
        (id) =>
          tasks.has(id) &&
          ["done", "cancelled"].includes(tasks.get(id)!.status),
      )
    )
      throw new WorkflowConflictError(
        "Waiting requires unfinished prerequisite tasks",
      );
  }
  return consumed;
}

function validatePrerequisites(resolutions: MilestoneResolution[]): void {
  const prerequisites = new Map<string, string[]>();
  for (const resolution of resolutions) {
    for (const taskId of resolution.affectedTaskIds ?? []) {
      prerequisites.set(taskId, [
        ...(prerequisites.get(taskId) ?? []),
        ...(resolution.waitForTaskIds ?? []),
      ]);
    }
  }
  const checked = new Set<string>();
  for (const taskId of prerequisites.keys())
    visitPrerequisites(taskId, prerequisites, checked, new Set());
}

function visitPrerequisites(
  taskId: string,
  prerequisites: Map<string, string[]>,
  checked: Set<string>,
  visiting: Set<string>,
): void {
  if (visiting.has(taskId))
    throw new WorkflowConflictError(
      "Task prerequisite cycle cannot make progress",
    );
  if (checked.has(taskId)) return;
  visiting.add(taskId);
  for (const prerequisite of prerequisites.get(taskId) ?? [])
    visitPrerequisites(prerequisite, prerequisites, checked, visiting);
  visiting.delete(taskId);
  checked.add(taskId);
}

function validateTaskChanges(
  snapshot: ProjectSnapshot,
  milestone: Milestone,
  tasks: Map<string, Task>,
  report: MilestoneReport,
): void {
  const changedTasks = new Set<string>();
  for (const update of report.plan?.updates ?? []) {
    const task = tasks.get(update.taskId);
    if (!task || task.milestoneId !== milestone.id || changedTasks.has(task.id))
      throw new WorkflowConflictError(
        "Updated task is outside milestone or duplicated",
      );
    changedTasks.add(task.id);
    validateTaskDefinitionUpdate(snapshot.project, task, {
      ...update,
      decisionSummary: report.summary,
    });
    if (
      update.changes.milestoneId !== undefined &&
      update.changes.milestoneId !== milestone.id
    )
      throw new WorkflowConflictError(
        "Assessment cannot move tasks out of its milestone",
      );
  }
  for (const cancellation of report.plan?.cancellations ?? []) {
    const task = tasks.get(cancellation.taskId);
    if (
      !task ||
      task.milestoneId !== milestone.id ||
      task.updatedAt !== cancellation.expectedUpdatedAt ||
      changedTasks.has(task.id)
    )
      throw new WorkflowConflictError(
        "Cancelled task is outside milestone, duplicated or changed",
      );
    if (!cancellation.reason.trim())
      throw new WorkflowConflictError("Cancellation requires a reason");
    changedTasks.add(task.id);
  }
}

function validateOutcome(
  snapshot: ProjectSnapshot,
  milestone: Milestone,
  unresolved: MilestoneActivity[],
  consumed: Set<string>,
  report: MilestoneReport,
): void {
  const resolutions = report.plan?.resolutions ?? [];
  const hasNewUnresolved = resolutions.some(
    (resolution) => resolution.question || resolution.waitForTaskIds?.length,
  );
  const hasUnresolved =
    unresolved.some((activity) => !consumed.has(activity.id)) ||
    hasNewUnresolved;
  const unfinished = snapshot.tasks.filter(
    (task) =>
      task.milestoneId === milestone.id &&
      !["done", "cancelled"].includes(task.status) &&
      !report.plan?.cancellations?.some((item) => item.taskId === task.id),
  );
  const additions = report.plan?.tasks ?? [];
  if (
    report.outcome === "needs_input" &&
    !resolutions.some((resolution) => resolution.question?.trim())
  )
    throw new WorkflowConflictError("needs_input requires a decision question");
  if (
    report.outcome === "completed" &&
    (report.planningRevision !== milestone.planning.revision ||
      hasUnresolved ||
      unfinished.length ||
      additions.length ||
      !report.evidence?.length)
  )
    throw new WorkflowConflictError(
      "Milestone completion requires current evidence and no unfinished work or decisions",
    );
  const waitingForDecisionOrDelivery =
    hasNewUnresolved ||
    unresolved.some(
      (activity) =>
        !consumed.has(activity.id) && activity.type === "resolution",
    );
  if (
    report.outcome === "progress" &&
    !unfinished.length &&
    !additions.length &&
    !waitingForDecisionOrDelivery
  )
    throw new WorkflowConflictError(
      "Progress requires work or a concrete unresolved source",
    );
}
