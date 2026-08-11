import { describe, expect, it } from "vitest";

import {
  applyTaskReport,
  startTaskExecution as startTaskExecutionWithModel,
} from "../../src/domain/workflow.js";
import type { Task, TaskReport } from "../../src/domain/types.js";
import { testModelRouting } from "../support/recording-executors.js";

const timestamp = "2026-08-03T00:00:00.000Z";

function startTaskExecution(task: Task, attemptId: string, now: string): Task {
  return startTaskExecutionWithModel(task, attemptId, now, testModelRouting());
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "task_1",
    projectId: "project_1",
    title: "Build the workflow",
    description: "Implement the task workflow.",
    acceptanceCriteria: ["The workflow advances from reports."],
    order: 1,
    status: "backlog",
    requestedAction: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

describe("task workflow", () => {
  it("starts the action selected by the project-level AI decision", () => {
    const selected = task({ requestedAction: "develop" });

    const started = startTaskExecution(selected, "attempt_1", timestamp);

    expect(started).toMatchObject({
      status: "developing",
      requestedAction: "develop",
      currentExecution: {
        attemptId: "attempt_1",
        action: "develop",
        status: "pending",
      },
    });
  });

  it("rejects stale reports", () => {
    const running = startTaskExecution(
      task({ requestedAction: "develop" }),
      "current_attempt",
      timestamp,
    );
    const stale: TaskReport = {
      taskId: running.id,
      attemptId: "stale_attempt",
      outcome: "completed",
      summary: "Done",
    };

    expect(() => applyTaskReport(running, stale, timestamp)).toThrow(
      /current execution/i,
    );
  });

  it("routes development, review, rework, and integration reports", () => {
    const developing = startTaskExecution(
      task({ requestedAction: "develop" }),
      "develop_attempt",
      timestamp,
    );
    const developed = applyTaskReport(
      developing,
      {
        taskId: developing.id,
        attemptId: "develop_attempt",
        outcome: "completed",
        summary: "Implemented",
        workspacePath: "/workspace/.worktrees/task_1",
        candidateCommit: "abc123",
      },
      timestamp,
    );
    expect(developed).toMatchObject({
      status: "reviewing",
      requestedAction: "review",
    });
    expect(developed.currentExecution).toBeUndefined();

    const reviewing = startTaskExecution(developed, "review_attempt", timestamp);
    const changesRequested = applyTaskReport(
      reviewing,
      {
        taskId: reviewing.id,
        attemptId: "review_attempt",
        outcome: "changes_requested",
        summary: "Fix the edge case",
        findings: ["Empty input fails"],
      },
      timestamp,
    );
    expect(changesRequested).toMatchObject({
      status: "changes_requested",
      requestedAction: "rework",
    });

    const reworking = startTaskExecution(
      changesRequested,
      "rework_attempt",
      timestamp,
    );
    const fixed = applyTaskReport(
      reworking,
      {
        taskId: reworking.id,
        attemptId: "rework_attempt",
        outcome: "completed",
        summary: "Fixed",
        candidateCommit: "def456",
      },
      timestamp,
    );
    expect(fixed).toMatchObject({ status: "reviewing", requestedAction: "review" });

    const reviewingAgain = startTaskExecution(fixed, "approve_attempt", timestamp);
    const approved = applyTaskReport(
      reviewingAgain,
      {
        taskId: reviewingAgain.id,
        attemptId: "approve_attempt",
        outcome: "approved",
        summary: "Approved",
        reviewedMainCommit: "main123",
      },
      timestamp,
    );
    expect(approved).toMatchObject({
      status: "integrating",
      requestedAction: "integrate",
    });

    const integrating = startTaskExecution(approved, "integrate_attempt", timestamp);
    const completed = applyTaskReport(
      integrating,
      {
        taskId: integrating.id,
        attemptId: "integrate_attempt",
        outcome: "completed",
        summary: "Merged",
        mergedCommit: "merge789",
      },
      timestamp,
    );
    expect(completed).toMatchObject({
      status: "done",
      requestedAction: null,
    });
    expect(completed.currentExecution).toBeUndefined();
  });

  it("keeps the same execution while Codex waits for an answer in the App", () => {
    const developing = startTaskExecution(
      task({ requestedAction: "develop" }),
      "develop_attempt",
      timestamp,
    );

    const waiting = applyTaskReport(
      developing,
      {
        taskId: developing.id,
        attemptId: "develop_attempt",
        outcome: "needs_input",
        summary: "A product decision is required",
        question: "Should this be turn based?",
      },
      timestamp,
    );

    expect(waiting).toMatchObject({
      status: "waiting_for_input",
      requestedAction: "develop",
      currentExecution: {
        attemptId: "develop_attempt",
        action: "develop",
        status: "waiting_for_input",
      },
    });

    const completed = applyTaskReport(
      waiting,
      {
        taskId: waiting.id,
        attemptId: "develop_attempt",
        outcome: "completed",
        summary: "Implemented after the user decision",
        workspacePath: "/workspace/.worktrees/task_1",
        candidateCommit: "abc123",
      },
      timestamp,
    );
    expect(completed).toMatchObject({
      status: "reviewing",
      requestedAction: "review",
    });
    expect(completed.currentExecution).toBeUndefined();
  });

  it("requires the artifacts consumed by later stages", () => {
    const cases: Array<{ task: Task; report: TaskReport; expected: RegExp }> = [
      {
        task: startTaskExecution(
          task({ requestedAction: "develop" }),
          "develop_attempt",
          timestamp,
        ),
        report: {
          taskId: "task_1",
          attemptId: "develop_attempt",
          outcome: "completed",
          summary: "Missing candidate",
        },
        expected: /workspacePath.*candidateCommit/i,
      },
      {
        task: startTaskExecution(
          task({ status: "reviewing", requestedAction: "review" }),
          "review_attempt",
          timestamp,
        ),
        report: {
          taskId: "task_1",
          attemptId: "review_attempt",
          outcome: "approved",
          summary: "Missing reviewed main",
        },
        expected: /reviewedMainCommit/i,
      },
      {
        task: startTaskExecution(
          task({ status: "integrating", requestedAction: "integrate" }),
          "integrate_attempt",
          timestamp,
        ),
        report: {
          taskId: "task_1",
          attemptId: "integrate_attempt",
          outcome: "completed",
          summary: "Missing merged commit",
        },
        expected: /mergedCommit/i,
      },
    ];

    for (const testCase of cases) {
      expect(() =>
        applyTaskReport(testCase.task, testCase.report, timestamp),
      ).toThrow(testCase.expected);
    }
  });
});
