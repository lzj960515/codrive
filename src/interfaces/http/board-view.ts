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
        planningNotice: project.status !== "cancelled" && (planning.summary || planning.question)
          ? {
              outcome: planning.outcome,
              summary: planning.summary,
              question: planning.question,
              wakeCondition: planning.wakeCondition,
              nextAction: planning.nextAction,
            }
          : null,
        latestEvaluation: latestProductReport
          ? {
              outcome: latestProductReport.outcome,
              summary: latestProductReport.summary,
              question:
                project.status === "cancelled"
                  ? null
                  : (latestProductReport.question ?? null),
            }
          : null,
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
        summary: task.latestReport?.summary ?? null,
        question:
          task.status === "cancelled" ? null : (task.latestReport?.question ?? null),
        cancellation: task.cancellation ?? null,
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
    ["pending", "running", "retry_scheduled", "awaiting_report"].includes(
      execution.status,
    )
      ? execution.status === "retry_scheduled"
        ? "retry_scheduled"
        : "selecting"
      : !decision
        ? "pending"
        : decision.outcome === "wait_for_active_tasks"
          ? "waiting_for_task"
          : decision.outcome;
  return {
    revision: project.planning.revision,
    status: project.status === "cancelled" ? "cancelled" : status,
    outcome: decision?.outcome ?? null,
    summary: decision?.summary ?? null,
    question:
      project.status === "cancelled" ? null : (decision?.question ?? null),
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
