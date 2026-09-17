import { describe, expect, it } from "vitest";
import type { Project } from "../../src/domain/types.js";
import type { Milestone } from "../../src/domain/milestone.js";
import { createMilestoneView, milestoneTaskWait } from "../../src/interfaces/http/milestone-view.js";

const milestone: Milestone = {
  id: "m", projectId: "p", title: "Social migration", description: "Preserve current behavior",
  acceptanceCriteria: ["Consumers migrated"], definitionVersion: 1, status: "active",
  planning: { revision: 1, changedAt: "2026-09-15T00:00:00Z", changeReason: "project_registered" },
  createdAt: "2026-09-15T00:00:00Z", updatedAt: "2026-09-15T00:00:00Z",
  currentExecution: {
    attemptId: "attempt", reportOpportunityId: "opportunity", action: "assess_milestone",
    status: "failed", startedAt: "2026-09-15T00:00:00Z",
    modelRouting: { model: "model", route: "primary", retryCount: 0 },
  },
};

describe("milestone view", () => {
  it("makes a failed assessment visible without adding a milestone business state", () => {
    expect(createMilestoneView(milestone, [], 0, project)).toMatchObject({ status: "active", statusLabel: "评估失败" });
  });
  it("keeps an unresolved decision visible while its next assessment runs", () => {
    const running = { ...milestone, currentExecution: { ...milestone.currentExecution!, status: "running" as const } };
    const view = createMilestoneView(running, [{
      id: "q", projectId: "p", milestoneId: "m", occurredAt: milestone.createdAt,
      type: "resolution", summary: "Retain old report until decided", assessmentActivityId: "assessment",
      resolution: { sourceActivityIds: [], summary: "Retain old report until decided", question: "Keep old report?" },
    }], 2, project);
    expect(view).toMatchObject({ statusLabel: "需要决定", questions: ["Keep old report?"] });
  });
});

const project: Project = {
  id: "p",
  name: "Project",
  repositoryPath: "/workspace/project",
  defaultBranch: "main",
  status: "active",
  scheduling: "paused",
  requestedAction: null,
  planning: {
    revision: 1,
    changedAt: milestone.createdAt,
    changeReason: "project_registered",
    concurrencyLimit: 2,
  },
  productFacts: {
    revision: 1,
    digest: "sha256:" + "a".repeat(64),
    changedAt: milestone.createdAt,
  },
  createdAt: milestone.createdAt,
  updatedAt: milestone.createdAt,
};

it("hides both milestone reply targets when the owning project is paused", () => {
  const waiting: Milestone = {
    ...milestone,
    threadId: "owner_thread",
    currentExecution: {
      ...milestone.currentExecution!,
      status: "completed",
      threadId: "owner_thread",
      turnCompletedAt: milestone.createdAt,
    },
  };
  const activities = [
    {
      id: "q",
      projectId: "p",
      milestoneId: "m",
      occurredAt: milestone.createdAt,
      type: "resolution" as const,
      summary: "Choose",
      assessmentActivityId: "assessment",
      resolution: {
        sourceActivityIds: [],
        summary: "Choose",
        question: "Ship?",
        affectedTaskIds: ["task"],
      },
    },
  ];
  const view = createMilestoneView(waiting, activities, 1, project);
  const taskWait = milestoneTaskWait(waiting, activities, "task", project);
  expect(view.decisionReply).toBeNull();
  expect(taskWait?.decisionReply).toBeNull();
  expect(view.questions).toEqual(["Ship?"]);
  expect(taskWait?.threadId).toBe("owner_thread");
});
