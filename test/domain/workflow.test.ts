import { describe, expect, it } from "vitest";

import {
  applyTaskReport as applyTaskReportWithIdentity,
  startTaskExecution as startTaskExecutionWithModel,
} from "../../src/domain/workflow.js";
import type { Task, TaskReport } from "../../src/domain/types.js";
import { testModelRouting } from "../support/recording-executors.js";

const timestamp = "2026-08-03T00:00:00.000Z";

function startTaskExecution(task: Task, attemptId: string, now: string): Task {
  return startTaskExecutionWithModel(
    task,
    attemptId,
    `report_opportunity_${attemptId}`,
    now,
    testModelRouting(),
  );
}

type TaskReportFixture = Omit<TaskReport, "reportOpportunityId"> & {
  reportOpportunityId?: string;
};

function applyTaskReport(
  task: Task,
  report: TaskReportFixture,
  now: string,
): Task {
  return applyTaskReportWithIdentity(
    {
      ...task,
      currentExecution: {
        ...task.currentExecution!,
        submittedActivityId: `activity_${task.currentExecution!.attemptId}`,
      },
    },
    {
      reportOpportunityId: task.currentExecution!.reportOpportunityId,
      ...report,
    },
    now,
  );
}

function task(overrides: Partial<Task> = {}): Task {
  const requiresWorkBinding = ["review", "integrate"].includes(
    overrides.requestedAction ?? "",
  );
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
    ...(requiresWorkBinding ? { workActivityId: "activity_work" } : {}),
    ...overrides,
  };
}

describe("task workflow", () => {
  it("starts the action selected by the project-level AI decision", () => {
    const selected = task({ requestedAction: "work" });

    const started = startTaskExecution(selected, "attempt_1", timestamp);

    expect(started).toMatchObject({
      status: "working",
      requestedAction: "work",
      currentExecution: {
        attemptId: "attempt_1",
        action: "work",
        status: "pending",
      },
    });
  });

  it("rejects stale reports", () => {
    const running = startTaskExecution(
      task({ requestedAction: "work" }),
      "current_attempt",
      timestamp,
    );
    const stale: TaskReport = {
      taskId: running.id,
      attemptId: "stale_attempt",
      reportOpportunityId: "report_opportunity_stale_attempt",
      outcome: "completed",
      summary: "Done",
    };

    expect(() => applyTaskReport(running, stale, timestamp)).toThrow(
      /current execution/i,
    );
  });

  it("routes work, review feedback, and integration reports", () => {
    const developing = startTaskExecution(
      task({ requestedAction: "work" }),
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
      status: "working",
      requestedAction: "work",
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
        workspacePath: "/workspace/.worktrees/task_1",
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
      task({ requestedAction: "work" }),
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
      requestedAction: "work",
      currentExecution: {
        attemptId: "develop_attempt",
        action: "work",
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

  it.each(["work", "review", "integrate"] as const)(
    "keeps the same %s execution while a planned blocker waits",
    (action) => {
      const started = startTaskExecution(
        task({ status: statusForAction(action), requestedAction: action }),
        `${action}_attempt`,
        timestamp,
      );

      const waiting = applyTaskReport(
        started,
        {
          taskId: started.id,
          attemptId: `${action}_attempt`,
          outcome: "blocked",
          summary: "Wait for the external build",
          resumeAt: "2026-08-03T01:00:00.000Z",
          resumePrompt: "Check the external build result, then continue the current stage.",
        },
        timestamp,
      );

      expect(waiting).toMatchObject({
        status: "blocked",
        requestedAction: action,
        currentExecution: {
          attemptId: `${action}_attempt`,
          action,
          status: "waiting_for_resume",
          scheduledResume: {
            reason: "Wait for the external build",
            resumeAt: "2026-08-03T01:00:00.000Z",
            resumePrompt:
              "Check the external build result, then continue the current stage.",
          },
        },
      });
    },
  );

  it("validates the complete planned blocker report contract", () => {
    const developing = startTaskExecution(
      task({ requestedAction: "work" }),
      "develop_attempt",
      timestamp,
    );
    const report = (overrides: Partial<TaskReport>): TaskReport => ({
      taskId: developing.id,
      attemptId: "develop_attempt",
      reportOpportunityId: "report_opportunity_develop_attempt",
      outcome: "blocked",
      summary: "Wait for a dependency",
      ...overrides,
    });

    expect(() =>
      applyTaskReport(
        developing,
        report({ resumeAt: "2026-08-03T01:00:00.000Z" }),
        timestamp,
      ),
    ).toThrow(/resumeAt.*resumePrompt/i);
    expect(() =>
      applyTaskReport(
        developing,
        report({ resumePrompt: "Continue after checking the dependency." }),
        timestamp,
      ),
    ).toThrow(/resumeAt.*resumePrompt/i);
    expect(() =>
      applyTaskReport(
        developing,
        report({
          resumeAt: "2026-08-03 01:00",
          resumePrompt: "Continue after checking the dependency.",
        }),
        timestamp,
      ),
    ).toThrow(/RFC 3339/i);
    expect(() =>
      applyTaskReport(
        developing,
        report({
          resumeAt: "2026-08-02T23:59:00.000Z",
          resumePrompt: "Continue after checking the dependency.",
        }),
        timestamp,
      ),
    ).toThrow(/future/i);
    expect(() =>
      applyTaskReport(
        developing,
        {
          taskId: developing.id,
          attemptId: "develop_attempt",
          outcome: "needs_input",
          summary: "Choose a behavior",
          question: "Which behavior?",
          resumeAt: "2026-08-03T01:00:00.000Z",
          resumePrompt: "Continue later.",
        },
        timestamp,
      ),
    ).toThrow(/only.*blocked/i);
  });

  it("requires artifacts only when a report creates code-backed work", () => {
    const cases: Array<{ task: Task; report: TaskReportFixture; expected: RegExp }> = [
      {
        task: startTaskExecution(
          task({ requestedAction: "work" }),
          "develop_attempt",
          timestamp,
        ),
        report: {
          taskId: "task_1",
          attemptId: "develop_attempt",
          outcome: "completed",
          summary: "Candidate without its workspace",
          candidateCommit: "candidate",
        },
        expected: /workspacePath/i,
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
          outcome: "needs_review",
          summary: "Missing candidate workspace",
          candidateCommit: "resolved",
        },
        expected: /workspacePath/i,
      },
    ];

    for (const testCase of cases) {
      expect(() =>
        applyTaskReport(testCase.task, testCase.report, timestamp),
      ).toThrow(testCase.expected);
    }
  });
});

function statusForAction(action: NonNullable<Task["requestedAction"]>): Task["status"] {
  if (action === "review") return "reviewing";
  if (action === "integrate") return "integrating";
  return "working";
}
