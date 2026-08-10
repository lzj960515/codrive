import type {
  PlanningChangeReason,
  Project,
  ProjectPlanningState,
  ProjectReport,
  SelectionDecision,
  SelectionDecisionOutcome,
} from "./types.js";

const selectionOutcomes = new Set<SelectionDecisionOutcome>([
  "selected",
  "wait_for_active_tasks",
  "needs_input",
  "blocked",
]);

export function createPlanningState(now: string): ProjectPlanningState {
  return {
    revision: 1,
    changedAt: now,
    changeReason: "project_registered",
  };
}

export function advancePlanning(
  planning: ProjectPlanningState,
  reason: PlanningChangeReason,
  now: string,
  concurrencyLimit = planning.concurrencyLimit,
): ProjectPlanningState {
  return {
    revision: planning.revision + 1,
    changedAt: now,
    changeReason: reason,
    ...(concurrencyLimit === undefined ? {} : { concurrencyLimit }),
  };
}

export function selectionDecision(
  report: ProjectReport,
  revision: number,
  decidedAt: string,
): SelectionDecision {
  if (!isSelectionOutcome(report.outcome)) {
    throw new Error(`Outcome ${report.outcome} is not a task-selection decision`);
  }
  const decision = decisionInstruction(report.outcome);
  return {
    revision,
    outcome: report.outcome,
    summary: report.summary,
    taskIds: report.taskIds ?? [],
    ...(report.question ? { question: report.question } : {}),
    ...decision,
    decidedAt,
  };
}

function isSelectionOutcome(
  outcome: ProjectReport["outcome"],
): outcome is SelectionDecisionOutcome {
  return selectionOutcomes.has(outcome as SelectionDecisionOutcome);
}

function decisionInstruction(outcome: SelectionDecisionOutcome): Pick<
  SelectionDecision,
  "wakeCondition" | "nextAction"
> {
  switch (outcome) {
    case "selected":
    case "wait_for_active_tasks":
      return {
        wakeCondition: "task_completed",
        nextAction: "wait_for_task_completion",
      };
    case "needs_input":
      return {
        wakeCondition: "project_decision_recorded",
        nextAction: "record_project_decision",
      };
    case "blocked":
      return {
        wakeCondition: "manual_replan",
        nextAction: "resolve_blocker_and_replan",
      };
  }
}
