import { describe, expect, it } from "vitest";

import {
  createTaskReportActivity,
  projectTaskActivities,
  taskActivityMatchesReport,
  taskReportFromActivity,
} from "../../src/domain/task-activity.js";
import type { TaskAction, TaskReport, TaskActivityType } from "../../src/domain/types.js";

const projectId = "project_1";
const taskId = "task_1";
const occurredAt = "2026-08-11T00:00:00.000Z";

describe("task activities", () => {
  it.each<{
    action: TaskAction;
    outcome: TaskReport["outcome"];
    type: TaskActivityType;
  }>([
    { action: "develop", outcome: "completed", type: "development_completed" },
    { action: "rework", outcome: "completed", type: "rework_completed" },
    { action: "review", outcome: "approved", type: "review_approved" },
    {
      action: "review",
      outcome: "changes_requested",
      type: "review_changes_requested",
    },
    { action: "integrate", outcome: "needs_review", type: "review_requested" },
    { action: "integrate", outcome: "completed", type: "integration_completed" },
    { action: "develop", outcome: "needs_input", type: "decision_requested" },
    { action: "review", outcome: "blocked", type: "blocked" },
  ])("maps $action/$outcome to $type", ({ action, outcome, type }) => {
    const report = reportFor(outcome);

    expect(createActivity(action, report)).toMatchObject({
      type,
      action,
      outcome,
      summary: report.summary,
    });
  });

  it("keeps report evidence inside one immutable activity", () => {
    const report: TaskReport = {
      taskId,
      attemptId: "attempt_1",
      outcome: "completed",
      summary: "Implemented the complete flow",
      workspacePath: "/workspace/.worktrees/task_1",
      baseCommit: "base_1",
      candidateCommit: "candidate_1",
      tests: "pnpm test passed",
    };

    const activity = createActivity("develop", report);

    expect(activity.evidence).toEqual({
      workspacePath: "/workspace/.worktrees/task_1",
      baseCommit: "base_1",
      candidateCommit: "candidate_1",
      tests: "pnpm test passed",
    });
    expect(taskReportFromActivity(activity)).toEqual(report);
    expect(taskActivityMatchesReport(activity, report)).toBe(true);
  });

  it("keeps a planned blocker schedule in its immutable activity", () => {
    const report: TaskReport = {
      taskId,
      attemptId: "attempt_1",
      outcome: "blocked",
      summary: "Wait for the deployment",
      resumeAt: "2026-08-11T02:00:00.000Z",
      resumePrompt: "Inspect deployment health and continue the review.",
    };

    const activity = createActivity("review", report);

    expect(activity.evidence).toEqual({
      resumeAt: "2026-08-11T02:00:00.000Z",
      resumePrompt: "Inspect deployment health and continue the review.",
    });
    expect(taskReportFromActivity(activity)).toEqual(report);
  });

  it("projects delivery and conversation facts from the ordered history", () => {
    const activities = [
      createActivity(
        "develop",
        {
          taskId,
          attemptId: "develop_1",
          outcome: "completed",
          summary: "Developed",
          workspacePath: "/workspace/.worktrees/task_1",
          baseCommit: "base_1",
          candidateCommit: "candidate_1",
          tests: "unit tests passed",
        },
        "development_thread",
      ),
      createActivity(
        "review",
        {
          taskId,
          attemptId: "review_1",
          outcome: "changes_requested",
          summary: "Found one issue",
          findings: ["Handle an empty input"],
        },
        "review_thread_1",
      ),
      createActivity(
        "rework",
        {
          taskId,
          attemptId: "rework_1",
          outcome: "completed",
          summary: "Fixed the issue",
          candidateCommit: "candidate_2",
        },
        "development_thread",
      ),
      createActivity(
        "review",
        {
          taskId,
          attemptId: "review_2",
          outcome: "approved",
          summary: "Approved",
          reviewedMainCommit: "main_2",
        },
        "review_thread_2",
      ),
      createActivity(
        "integrate",
        {
          taskId,
          attemptId: "integrate_1",
          outcome: "completed",
          summary: "Integrated",
          mergedCommit: "merged_1",
        },
        "development_thread",
      ),
    ];

    expect(projectTaskActivities(activities)).toEqual({
      workspacePath: "/workspace/.worktrees/task_1",
      baseCommit: "base_1",
      candidateCommit: "candidate_2",
      reviewedMainCommit: "main_2",
      mergedCommit: "merged_1",
      developmentThreadId: "development_thread",
      reviewThreadId: "review_thread_2",
      reviewCount: 2,
      latestDecisionRequest: null,
    });
  });

  it("preserves multiple reports from the same attempt in chronological order", () => {
    const request = createActivity("develop", {
      taskId,
      attemptId: "attempt_1",
      outcome: "needs_input",
      summary: "A product choice is required",
      question: "Keep both variants?",
    });
    const completed = createActivity("develop", {
      taskId,
      attemptId: "attempt_1",
      outcome: "completed",
      summary: "Implemented the chosen variant",
      workspacePath: "/workspace/.worktrees/task_1",
      candidateCommit: "candidate_1",
    });

    const projection = projectTaskActivities([request, completed]);

    expect([request.type, completed.type]).toEqual([
      "decision_requested",
      "development_completed",
    ]);
    expect(projection.latestDecisionRequest).toBeNull();
  });
});

function createActivity(
  action: TaskAction,
  report: TaskReport,
  threadId = "thread_1",
) {
  return createTaskReportActivity({
    activityId: `activity_${report.attemptId}_${report.outcome}`,
    projectId,
    action,
    report,
    threadId,
    occurredAt,
  });
}

function reportFor(outcome: TaskReport["outcome"]): TaskReport {
  return {
    taskId,
    attemptId: "attempt_1",
    outcome,
    summary: "Stage result",
    ...(outcome === "completed"
      ? {
          workspacePath: "/workspace/.worktrees/task_1",
          candidateCommit: "candidate_1",
          mergedCommit: "merged_1",
        }
      : {}),
    ...(outcome === "approved" ? { reviewedMainCommit: "main_1" } : {}),
    ...(outcome === "changes_requested" ? { findings: ["Fix the issue"] } : {}),
    ...(outcome === "needs_review" ? { candidateCommit: "candidate_2" } : {}),
    ...(outcome === "needs_input" ? { question: "Choose a direction" } : {}),
  };
}
