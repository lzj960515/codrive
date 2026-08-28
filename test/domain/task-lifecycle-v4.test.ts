import { describe, expect, it } from "vitest";

import { createTaskReportActivity } from "../../src/domain/task-activity.js";
import type { Task, TaskReport } from "../../src/domain/types.js";
import {
  applyTaskReport,
  startTaskExecution,
} from "../../src/domain/workflow.js";
import { testModelRouting } from "../support/recording-executors.js";

const now = "2026-08-28T04:00:00.000Z";

describe("task lifecycle v4", () => {
  it("routes every reviewed work result through work, review, and integrate", () => {
    const startedWork = start(task("work"), "attempt_work_1", "report_work_1");
    expect(startedWork).toMatchObject({
      status: "working",
      currentExecution: { action: "work" },
    });

    const reportedWork = apply(startedWork, {
      outcome: "completed",
      summary: "Verified the external release without changing code",
    });
    expect(reportedWork).toMatchObject({
      status: "reviewing",
      requestedAction: "review",
      workActivityId: "activity_work_1",
    });

    const startedReview = start(
      reportedWork,
      "attempt_review_1",
      "report_review_1",
    );
    expect(startedReview.currentExecution).toMatchObject({
      action: "review",
      workActivityId: "activity_work_1",
    });

    const changesRequested = apply(startedReview, {
      outcome: "changes_requested",
      summary: "One supported scenario is incomplete",
      findings: ["Complete the supported scenario"],
    });
    expect(changesRequested).toMatchObject({
      status: "working",
      requestedAction: "work",
      workActivityId: "activity_work_1",
    });

    const revisedWork = start(
      changesRequested,
      "attempt_work_2",
      "report_work_2",
    );
    const revised = apply(revisedWork, {
      outcome: "completed",
      summary: "Completed the supported scenario",
      workspacePath: "/workspace/task",
      baseCommit: "base",
      candidateCommit: "candidate",
    });
    expect(revised.workActivityId).toBe("activity_work_2");

    const approved = apply(
      start(revised, "attempt_review_2", "report_review_2"),
      {
        outcome: "approved",
        summary: "Approved",
        reviewedMainCommit: "main",
      },
    );
    expect(approved).toMatchObject({
      status: "integrating",
      requestedAction: "integrate",
      workActivityId: "activity_work_2",
    });

    const moreWork = apply(
      start(approved, "attempt_integrate_1", "report_integrate_1"),
      {
        outcome: "work_required",
        summary: "The merge is complete but deployment verification remains",
        mergedCommit: "candidate",
      },
    );
    expect(moreWork).toMatchObject({
      status: "working",
      requestedAction: "work",
      workActivityId: "activity_work_2",
    });

    const finalWork = apply(
      start(moreWork, "attempt_work_3", "report_work_3"),
      {
        outcome: "completed",
        summary: "Deployment verification passed without another code change",
      },
    );
    const finalApproved = apply(
      start(finalWork, "attempt_review_3", "report_review_3"),
      { outcome: "approved", summary: "Approved the verification" },
    );
    const completed = apply(
      start(finalApproved, "attempt_integrate_2", "report_integrate_2"),
      { outcome: "completed", summary: "The whole task is complete" },
    );
    expect(completed).toMatchObject({ status: "done", requestedAction: null });
  });

  it("records work ownership for ordinary work and integrate-produced candidates", () => {
    const ordinary = createTaskReportActivity({
      activityId: "activity_work",
      projectId: "project_1",
      action: "work" as never,
      report: report("attempt_work", "report_work", {
        outcome: "completed",
        summary: "Implemented",
        workspacePath: "/workspace/task",
        baseCommit: "base",
        candidateCommit: "candidate",
      }),
      threadId: "thread_work",
      occurredAt: now,
    });
    expect(ordinary).toMatchObject({
      type: "work_completed",
      workActivityId: "activity_work",
    });

    const integrationCandidate = createTaskReportActivity({
      activityId: "activity_integration_candidate",
      projectId: "project_1",
      action: "integrate",
      report: report("attempt_integrate", "report_integrate", {
        outcome: "needs_review" as never,
        summary: "Conflict resolution produced a new candidate",
        workspacePath: "/workspace/task",
        baseCommit: "main",
        candidateCommit: "resolved",
      }),
      workActivityId: "activity_work",
      threadId: "thread_work",
      occurredAt: now,
    } as never);
    expect(integrationCandidate).toMatchObject({
      type: "work_completed",
      workActivityId: "activity_integration_candidate",
    });
  });
});

function task(requestedAction: "work"): Task {
  return {
    id: "task_1",
    projectId: "project_1",
    title: "Lifecycle",
    description: "Exercise the lifecycle",
    acceptanceCriteria: ["The lifecycle is deterministic"],
    order: 1,
    status: "backlog",
    requestedAction,
    createdAt: now,
    updatedAt: now,
  } as unknown as Task;
}

function start(
  current: Task,
  attemptId: string,
  reportOpportunityId: string,
): Task {
  return startTaskExecution(
    current,
    attemptId,
    reportOpportunityId,
    now,
    testModelRouting(),
  );
}

function apply(
  current: Task,
  input: Omit<TaskReport, "taskId" | "attemptId" | "reportOpportunityId">,
): Task {
  const execution = current.currentExecution!;
  return applyTaskReport(
    {
      ...current,
      currentExecution: {
        ...execution,
        submittedActivityId: `activity_${execution.attemptId.replace("attempt_", "")}`,
      },
    },
    report(execution.attemptId, execution.reportOpportunityId, input),
    now,
  );
}

function report(
  attemptId: string,
  reportOpportunityId: string,
  input: Omit<TaskReport, "taskId" | "attemptId" | "reportOpportunityId">,
): TaskReport {
  return {
    taskId: "task_1",
    attemptId,
    reportOpportunityId,
    ...input,
  } as TaskReport;
}
