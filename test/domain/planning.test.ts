import { describe, expect, it } from "vitest";

import {
  advancePlanning,
  createPlanningState,
  markPlanningEvaluated,
} from "../../src/domain/planning.js";

describe("project planning state", () => {
  it("marks exactly one planning revision as evaluated", () => {
    const planning = createPlanningState("2026-08-11T00:00:00.000Z");

    expect(markPlanningEvaluated(planning)).toEqual({
      ...planning,
      evaluatedRevision: 1,
    });
  });

  it("requires a new decision after planning facts change", () => {
    const evaluated = markPlanningEvaluated(
      createPlanningState("2026-08-11T00:00:00.000Z"),
    );

    expect(
      advancePlanning(evaluated, "task_completed", "2026-08-11T01:00:00.000Z"),
    ).toEqual({
      revision: 2,
      changedAt: "2026-08-11T01:00:00.000Z",
      changeReason: "task_completed",
    });
  });
});
