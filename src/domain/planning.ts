import type {
  PlanningChangeReason,
  ProjectPlanningState,
} from "./types.js";

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

export function markPlanningEvaluated(
  planning: ProjectPlanningState,
): ProjectPlanningState {
  return { ...planning, evaluatedRevision: planning.revision };
}
