import type { ProjectSnapshot } from "../../domain/types.js";

export function createBoardView(snapshots: ProjectSnapshot[]) {
  return snapshots.map(({ project, tasks }) => {
    const planning = createPlanningView(project, tasks);
    return {
      project: {
        id: project.id,
        name: project.name,
        status: project.status,
        displayStatus: projectDisplayStatus(
          project.status,
          project.scheduling,
          planning.status,
          tasks,
        ),
        scheduling: project.scheduling,
        requestedAction: project.requestedAction,
        executionStatus: project.currentExecution?.status ?? null,
        cancellation: project.cancellation ?? null,
        attention: projectAttention(project),
        planning,
        updatedAt: project.updatedAt,
      },
      tasks: tasks.map((task) => ({
        id: task.id,
        title: task.title,
        description: task.description,
        acceptanceCriteria: task.acceptanceCriteria,
        order: task.order,
        status: task.status,
        requestedAction: task.requestedAction,
        executionStatus: task.currentExecution?.status ?? null,
        modelRouting: task.currentExecution?.modelRouting ?? null,
        scheduledResume: task.currentExecution?.scheduledResume
          ? {
              reason: task.currentExecution.scheduledResume.reason,
              resumeAt: task.currentExecution.scheduledResume.resumeAt,
            }
          : null,
        cancellation: task.cancellation ?? null,
        terminalAt:
          task.status === "done"
            ? task.updatedAt
            : task.status === "cancelled"
              ? (task.cancellation?.cancelledAt ?? null)
              : null,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
      })),
    };
  });
}

function createPlanningView(
  project: ProjectSnapshot["project"],
  tasks: ProjectSnapshot["tasks"],
) {
  const execution = project.currentExecution;
  const result =
    execution?.action === "select_tasks" &&
    execution.planningRevision === project.planning.revision
      ? execution.result
      : undefined;
  const status =
    execution?.action === "select_tasks" &&
    ["pending", "running", "retry_scheduled", "awaiting_report"].includes(
      execution.status,
    )
      ? execution.status === "retry_scheduled"
        ? "retry_scheduled"
        : "selecting"
      : project.planning.evaluatedRevision !== project.planning.revision
        ? "pending"
        : result?.outcome === "wait_for_active_tasks"
          ? "waiting_for_task"
          : (result?.outcome ?? "waiting_for_task");
  return {
    revision: project.planning.revision,
    evaluatedRevision: project.planning.evaluatedRevision ?? null,
    status: ["cancelled", "idle"].includes(project.status)
      ? project.status
      : status,
    outcome: result?.outcome ?? null,
    selectedTaskIds: result?.taskIds ?? [],
    blockingTaskIds: tasks
      .filter(({ status: taskStatus }) =>
        ["waiting_for_input", "blocked"].includes(taskStatus),
      )
      .map(({ id }) => id),
  };
}

function projectAttention(project: ProjectSnapshot["project"]) {
  if (project.status !== "active") return null;
  const execution = project.currentExecution;
  const result = execution?.result;
  if (!execution || !result || !["needs_input", "blocked"].includes(result.outcome)) {
    return null;
  }
  if (
    execution.action === "select_tasks" &&
    execution.planningRevision !== project.planning.revision
  ) {
    return null;
  }
  return {
    kind: result.outcome === "needs_input" ? "decision_requested" : "blocked",
    summary: result.summary,
    question: result.question ?? null,
    occurredAt: execution.finishedAt ?? execution.startedAt,
  };
}

function projectDisplayStatus(
  projectStatus: ProjectSnapshot["project"]["status"],
  scheduling: ProjectSnapshot["project"]["scheduling"],
  planningStatus: string,
  tasks: ProjectSnapshot["tasks"],
): string {
  if (projectStatus !== "active") return projectStatus;
  const activeTasks = tasks.some(
    ({ status, currentExecution }) =>
      ["developing", "reviewing", "changes_requested", "integrating"].includes(
        status,
      ) &&
      currentExecution &&
      ["pending", "running", "retry_scheduled", "awaiting_report"].includes(
        currentExecution.status,
      ),
  );
  if (scheduling === "paused") return activeTasks ? "active_paused" : "paused";
  if (activeTasks) return "active";
  if (planningStatus === "retry_scheduled") return "retry_scheduled";
  if (planningStatus === "selecting" || planningStatus === "pending") {
    return "selecting_tasks";
  }
  if (planningStatus === "needs_input") return "waiting_for_input";
  if (planningStatus === "blocked") return "blocked";
  return "waiting_for_task";
}
