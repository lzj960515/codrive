import type { ProjectSnapshot } from "../../domain/types.js";

export function createBoardView(snapshots: ProjectSnapshot[]) {
  return snapshots.map(({ project, tasks }) => {
    const planning = createPlanningView(project, tasks);
    const latestProductReport =
      project.currentExecution?.action === "evaluate_product" &&
      project.currentExecution.report?.attemptId === project.latestReport?.attemptId
        ? project.latestReport
        : undefined;
    return {
      project: {
        id: project.id,
        name: project.name,
        status: project.status,
        displayStatus: projectDisplayStatus(project.status, planning.status, tasks),
        scheduling: project.scheduling,
        requestedAction: project.requestedAction,
        executionStatus: project.currentExecution?.status ?? null,
        summary: planning.summary ?? latestProductReport?.summary ?? null,
        question: planning.question ?? latestProductReport?.question ?? null,
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
        summary: task.latestReport?.summary ?? null,
        question: task.latestReport?.question ?? null,
        report: task.latestReport
          ? {
              outcome: task.latestReport.outcome,
              summary: task.latestReport.summary,
              tests: task.latestReport.tests ?? null,
              findings: task.latestReport.findings ?? [],
              question: task.latestReport.question ?? null,
            }
          : null,
        developmentThreadId: task.developmentThreadId ?? null,
        reviewThreadId: task.reviewAttempts.at(-1)?.threadId ?? null,
        reviewCount: task.reviewAttempts.length,
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
  const decision =
    project.planning.lastDecision?.revision === project.planning.revision
      ? project.planning.lastDecision
      : undefined;
  const status =
    execution?.action === "select_tasks" &&
    ["pending", "running", "awaiting_report"].includes(execution.status)
      ? "selecting"
      : !decision
        ? "pending"
        : decision.outcome === "wait_for_active_tasks"
          ? "waiting_for_task"
          : decision.outcome;
  return {
    revision: project.planning.revision,
    status,
    outcome: decision?.outcome ?? null,
    summary: decision?.summary ?? null,
    question: decision?.question ?? null,
    wakeCondition: decision?.wakeCondition ?? null,
    nextAction: decision?.nextAction ?? null,
    selectedTaskIds: decision?.taskIds ?? [],
    blockingTaskIds: tasks
      .filter(({ status: taskStatus }) =>
        ["waiting_for_input", "blocked"].includes(taskStatus),
      )
      .map(({ id }) => id),
  };
}

function projectDisplayStatus(
  projectStatus: ProjectSnapshot["project"]["status"],
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
      ["pending", "running", "awaiting_report"].includes(currentExecution.status),
  );
  if (activeTasks) return "active";
  if (planningStatus === "selecting" || planningStatus === "pending") {
    return "selecting_tasks";
  }
  if (planningStatus === "needs_input") return "waiting_for_input";
  if (planningStatus === "blocked") return "blocked";
  return "waiting_for_task";
}
