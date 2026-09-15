import { describe, expect, it } from "vitest";
import { assertCurrentEvent } from "../../src/infrastructure/state-validation.js";
import type { CodriveEvent } from "../../src/domain/types.js";

const activity = {
  id: "resolution_1", type: "resolution", projectId: "project_1", milestoneId: "milestone_1",
  occurredAt: "2026-09-15T00:00:00.000Z", summary: "Investigate before changing the capability",
  assessmentActivityId: "assessment_1",
  resolution: { sourceActivityIds: ["discovery_1"], summary: "Await investigation", waitForTaskIds: ["task_1"] },
};
function eventWith(value: unknown): CodriveEvent {
  return { schemaVersion: 1, eventId: "event_1", type: "milestone.activity_recorded",
    projectId: "project_1", milestoneId: "milestone_1", occurredAt: activity.occurredAt,
    data: { milestoneActivity: value } };
}

describe("current persisted milestone activity contract", () => {
  it("accepts a typed resolution with source evidence and investigation tasks", () => {
    expect(assertCurrentEvent(eventWith(activity))).toEqual(eventWith(activity));
  });

  it.each([
    { ...activity, projectId: "another_project" },
    { ...activity, milestoneId: "another_milestone" },
    { ...activity, resolution: { summary: "Missing source list" } },
    { ...activity, resolution: { sourceActivityIds: [], summary: "Await", waitForTaskIds: [42] } },
    { ...activity, resolution: { sourceActivityIds: [], summary: "Await", affectedTaskIds: "task_1" } },
  ])("rejects mismatched or malformed milestone activity %j", (invalid) => {
    expect(() => assertCurrentEvent(eventWith(invalid))).toThrow(/milestone|resolution/i);
  });

  it("rejects an assessment report bound to another milestone", () => {
    const assessment = {
      ...activity, type: "assessment", createdTaskIds: [], report: {
        milestoneId: "other", attemptId: "attempt_1", reportOpportunityId: "report_1", definitionVersion: 1,
        planningRevision: 1, outcome: "progress", summary: "Plan updated",
      },
    };
    expect(() => assertCurrentEvent(eventWith(assessment))).toThrow(/milestone/i);
  });
});
