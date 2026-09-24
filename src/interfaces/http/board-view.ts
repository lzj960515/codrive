import { projectDecisionReply } from "../../domain/decision-reply.js";
import type { Milestone, MilestoneActivity } from "../../domain/milestone.js";
import { createMilestoneView, milestoneTaskWait } from "./milestone-view.js";
import type { ProjectSnapshot } from "../../domain/types.js";
import { createTaskDisplay } from "./task-display.js";

export function createBoardView(
  snapshots: ProjectSnapshot[],
  schedulingSnapshots: ProjectSnapshot[] = snapshots,
  milestoneActivities: ReadonlyMap<string, MilestoneActivity[]> = new Map(),
) {
  return snapshots.map(({ project, tasks, milestones }) => {
    const planning = createPlanningView(project, tasks);
    const milestonesById = new Map(milestones.map(milestone => [milestone.id, milestone]));
    return {
      project: {
        id: project.id,
        name: project.name,
        planningThreadId: project.planningThreadId ?? null,
        status: project.status,
        displayStatus: projectDisplayStatus(
          project.archivedAt,
          project.status,
          project.scheduling,
          planning.status,
          tasks,
        ),
        scheduling: project.scheduling,
        archivedAt: project.archivedAt ?? null,
        requestedAction: project.requestedAction,
        executionStatus: project.currentExecution?.status ?? null,
        cancellation: project.cancellation ?? null,
        attention: projectAttention(project),
        planning,
        updatedAt: project.updatedAt,
      },
      milestones: milestones.map(milestone => createMilestoneView(
        milestone,
        milestoneActivities.get(milestone.id) ?? [],
        tasks.filter(task => task.milestoneId === milestone.id).length,
        project,
      )),
      tasks: tasks.map((task) => ({
        ...taskMilestoneView(task, milestonesById, milestoneActivities, project),
        id: task.id,
        title: task.title,
        taskDocumentPath: task.taskDocumentPath ?? null,
        description: task.description,
        acceptanceCriteria: task.acceptanceCriteria,
        order: task.order,
        status: task.status,
        ...createTaskDisplay(schedulingSnapshots, project, task),
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
              ? (task.cancellation?.cancelledAt ?? task.updatedAt)
              : null,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
      })),
    };
  });
}

function taskMilestoneView(
  task: ProjectSnapshot["tasks"][number],
  milestones: ReadonlyMap<string, Milestone>,
  activities: ReadonlyMap<string, MilestoneActivity[]>,
  project: ProjectSnapshot["project"],
) {
  const milestone = task.milestoneId ? milestones.get(task.milestoneId) : undefined;
  return {
    milestoneId: milestone?.id ?? null,
    milestoneTitle: milestone?.title ?? null,
    milestoneWait: milestone
      ? milestoneTaskWait(milestone, activities.get(milestone.id) ?? [], task.id, project)
      : null,
  };
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
    decisionReply: projectDecisionReply(project),
    kind: result.outcome === "needs_input" ? "decision_requested" : "blocked",
    summary: result.summary,
    question: result.question ?? null,
    occurredAt: execution.finishedAt ?? execution.startedAt,
  };
}

function projectDisplayStatus(
  archivedAt: string | undefined,
  projectStatus: ProjectSnapshot["project"]["status"],
  scheduling: ProjectSnapshot["project"]["scheduling"],
  planningStatus: string,
  tasks: ProjectSnapshot["tasks"],
): string {
  if (archivedAt) return "archived";
  if (projectStatus !== "active") return projectStatus;
  const activeTasks = tasks.some(
    ({ status, currentExecution }) =>
      ["working", "reviewing", "integrating"].includes(
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
