import { describe, expect, it } from "vitest";
import { projectMilestoneActivities } from "../../src/domain/milestone-activity.js";
import type { MilestoneActivity } from "../../src/domain/milestone.js";

const base = {
  projectId: "p",
  milestoneId: "m",
  occurredAt: "2026-09-15T00:00:00Z",
  summary: "Evidence",
};
describe("milestone activity projection", () => {
  it("keeps restrictions until every independent question has been resolved", () => {
    const activities: MilestoneActivity[] = [
      {
        ...base,
        id: "a",
        type: "discovery",
        taskId: "t",
        attemptId: "x",
        requestId: "r",
        evidence: [],
        affectedTaskIds: [],
      },
      {
        ...base,
        id: "b",
        type: "resolution",
        assessmentActivityId: "z",
        resolution: {
          sourceActivityIds: ["a"],
          summary: "Investigate",
          question: "Keep this?",
          affectedTaskIds: ["delete"],
        },
      },
      {
        ...base,
        id: "c",
        type: "resolution",
        assessmentActivityId: "z",
        resolution: {
          sourceActivityIds: [],
          summary: "Other question",
          question: "Migrate?",
          affectedTaskIds: ["delete"],
        },
      },
      {
        ...base,
        id: "d",
        type: "resolution",
        assessmentActivityId: "z2",
        resolution: { sourceActivityIds: ["b"], summary: "Keep it" },
      },
    ];
    expect(projectMilestoneActivities(activities).restrictedTaskIds).toEqual([
      "delete",
    ]);
    expect(
      projectMilestoneActivities(activities).unresolvedActivities.map(
        (a) => a.id,
      ),
    ).toEqual(["c"]);
  });
  it("preserves a delivery prerequisite after a user question is answered", () => {
    const activities: MilestoneActivity[] = [
      {
        ...base,
        id: "a",
        type: "resolution",
        assessmentActivityId: "z",
        resolution: {
          sourceActivityIds: [],
          summary: "Wait migration",
          affectedTaskIds: ["delete"],
          waitForTaskIds: ["migrate"],
        },
      },
    ];
    expect(projectMilestoneActivities(activities).restrictedTaskIds).toEqual([
      "delete",
    ]);
  });
});
