import { appendFile, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ProjectStore } from "../../src/infrastructure/project-store.js";
import { migrateStateDirectory } from "../../src/infrastructure/state-migration.js";

const timestamp = "2026-08-11T00:00:00.000Z";

describe("Codrive state migration", () => {
  it("recovers every historical report once and upgrades current state", async () => {
    const stateDirectory = await legacyStateFixture();

    await expect(migrateStateDirectory(stateDirectory)).resolves.toEqual({
      migrated: true,
      reportCount: 2,
      activityCount: 2,
    });

    const store = new ProjectStore(stateDirectory);
    const snapshot = await store.getProject("project_1");
    const activities = await store.listTaskActivities("project_1", "task_1");
    expect(snapshot?.project).toMatchObject({
      planning: { revision: 1, evaluatedRevision: 1 },
      currentExecution: {
        attemptId: "project_attempt_1",
        result: { outcome: "wait_for_active_tasks" },
      },
    });
    expect(snapshot?.project).not.toHaveProperty("latestReport");
    expect(snapshot?.project.planning).not.toHaveProperty("lastDecision");
    expect(snapshot?.tasks[0]).not.toHaveProperty("latestReport");
    expect(snapshot?.tasks[0]).not.toHaveProperty("reviewAttempts");
    expect(snapshot?.tasks[0]).not.toHaveProperty("candidateCommit");
    expect(snapshot?.tasks[0]?.currentExecution).toMatchObject({
      attemptId: "attempt_1",
      status: "waiting_for_input",
      submittedActivityId: "activity_report_2",
    });
    expect(snapshot?.tasks[0]?.currentExecution).not.toHaveProperty(
      "reportOpportunityId",
    );
    expect(activities.map(({ type }) => type)).toEqual([
      "decision_requested",
      "development_completed",
    ]);
    expect(activities.map(({ attemptId }) => attemptId)).toEqual([
      "attempt_1",
      "attempt_1",
    ]);
    expect(activities.every((activity) => !activity.reportOpportunityId)).toBe(true);
    expect(
      (await store.listTaskActivities("project_1", "task_2")).map(({ type }) => type),
    ).toEqual(["cancelled"]);
    expect(
      (await store.listTaskActivities("project_1", "task_3")).map(({ type }) => type),
    ).toEqual(["execution_failed"]);
    expect(snapshot?.tasks.find(({ id }) => id === "task_4")?.currentExecution)
      .toMatchObject({
        attemptId: "active_1",
        status: "running",
        threadId: "active_thread",
      });

    await expect(migrateStateDirectory(stateDirectory)).resolves.toEqual({
      migrated: false,
      reportCount: 0,
      activityCount: 0,
    });
    expect(
      (await store.listTaskActivities("project_1", "task_1")).map(({ id }) => id),
    ).toEqual(["activity_report_1", "activity_report_2"]);
    await expect(
      readFile(join(stateDirectory, "backups", "state-v1", "projects", "project_1", "project.json"), "utf8"),
    ).resolves.toContain('"latestReport"');
  });

  it("resumes after one deterministic activity was appended before the schema marker", async () => {
    const stateDirectory = await legacyStateFixture();
    const eventsPath = join(
      stateDirectory,
      "projects",
      "project_1",
      "events.ndjson",
    );
    const partialActivity = {
      id: "activity_report_1",
      projectId: "project_1",
      taskId: "task_1",
      type: "decision_requested",
      action: "develop",
      outcome: "needs_input",
      attemptId: "attempt_1",
      summary: "Need a decision",
      occurredAt: timestamp,
      threadId: "thread_1",
      evidence: { question: "Which mode?" },
    };
    await appendFile(
      eventsPath,
      `${JSON.stringify({
        schemaVersion: 1,
        eventId: "migration_report_1",
        type: "task.activity_recorded",
        source: "system",
        projectId: "project_1",
        taskId: "task_1",
        attemptId: "attempt_1",
        threadId: "thread_1",
        occurredAt: timestamp,
        data: { activity: partialActivity },
      })}\n`,
    );

    await expect(migrateStateDirectory(stateDirectory)).resolves.toEqual({
      migrated: true,
      reportCount: 2,
      activityCount: 2,
    });

    const store = new ProjectStore(stateDirectory);
    const activities = await store.listTaskActivities("project_1", "task_1");
    expect(activities.map(({ id }) => id)).toEqual([
      "activity_report_1",
      "activity_report_2",
    ]);
  });

  it("moves legacy context notes to audit history and requires explicit reconciliation", async () => {
    const stateDirectory = await legacyProductFactsFixture();

    await expect(migrateStateDirectory(stateDirectory)).resolves.toEqual({
      migrated: true,
      reportCount: 0,
      activityCount: 0,
    });

    const store = new ProjectStore(stateDirectory);
    const snapshot = await store.getProject("project_context");
    expect(snapshot?.project).toMatchObject({
      planning: { changeReason: "product_document_updated" },
      productFacts: {
        revision: 1,
        status: "reconciliation_required",
        reconciliationReason: "legacy_context_notes",
      },
      currentExecution: {
        attemptId: "selection_context",
        status: "interrupted",
      },
    });
    expect(snapshot?.project).not.toHaveProperty("contextNotes");

    const events = (await readFile(
      join(
        stateDirectory,
        "projects",
        "project_context",
        "events.ndjson",
      ),
      "utf8",
    ))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "project.product_facts_reconciliation_required",
        data: {
          reason: "legacy_context_notes",
          legacyContextNotes: [
            "Use keyboard controls.",
            "Replace keyboard-only mode with controller support.",
          ],
        },
      }),
    );
  });
});

async function legacyProductFactsFixture(): Promise<string> {
  const stateDirectory = await mkdtemp(join(tmpdir(), "codrive-state-v2-"));
  const projectDirectory = join(
    stateDirectory,
    "projects",
    "project_context",
  );
  const taskDirectory = join(projectDirectory, "tasks");
  await mkdir(taskDirectory, { recursive: true });
  const project = {
    id: "project_context",
    name: "Context Game",
    repositoryPath: "/workspace/context-game",
    defaultBranch: "main",
    status: "active",
    scheduling: "running",
    requestedAction: "select_tasks",
    planning: {
      revision: 4,
      changedAt: timestamp,
      changeReason: "project_decision_recorded",
      concurrencyLimit: 2,
    },
    contextNotes: [
      "Use keyboard controls.",
      "Replace keyboard-only mode with controller support.",
    ],
    currentExecution: {
      attemptId: "selection_context",
      action: "select_tasks",
      status: "running",
      threadId: "thread_context",
      turnId: "turn_context",
      startedAt: timestamp,
      planningRevision: 4,
      modelRouting: {
        model: "gpt-5.6-sol",
        route: "primary",
        retryCount: 0,
      },
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const task = {
    id: "task_context",
    projectId: "project_context",
    title: "Loop",
    description: "Build it",
    acceptanceCriteria: [],
    order: 1,
    status: "backlog",
    requestedAction: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  await Promise.all([
    writeFile(
      join(stateDirectory, "state-schema.json"),
      JSON.stringify({ schemaVersion: 2, migratedAt: timestamp }),
    ),
    writeFile(join(projectDirectory, "project.json"), JSON.stringify(project)),
    writeFile(join(projectDirectory, "PROJECT.md"), "# Context Game\n"),
    writeFile(join(taskDirectory, "task_context.json"), JSON.stringify(task)),
    writeFile(join(projectDirectory, "events.ndjson"), ""),
  ]);
  return stateDirectory;
}

async function legacyStateFixture(): Promise<string> {
  const stateDirectory = await mkdtemp(join(tmpdir(), "codrive-state-v1-"));
  const projectDirectory = join(stateDirectory, "projects", "project_1");
  const taskDirectory = join(projectDirectory, "tasks");
  await mkdir(taskDirectory, { recursive: true });
  const projectReport = {
    projectId: "project_1",
    attemptId: "project_attempt_1",
    outcome: "wait_for_active_tasks",
    summary: "Wait for the active task",
  };
  const project = {
    id: "project_1",
    name: "Game",
    repositoryPath: "/workspace/game",
    defaultBranch: "main",
    status: "active",
    scheduling: "running",
    requestedAction: null,
    planning: {
      revision: 1,
      changedAt: timestamp,
      changeReason: "project_registered",
      lastDecision: {
        revision: 1,
        outcome: "wait_for_active_tasks",
        summary: "Wait",
        taskIds: [],
        wakeCondition: "task_completed",
        nextAction: "wait_for_task_completion",
        decidedAt: timestamp,
      },
    },
    currentExecution: {
      attemptId: "project_attempt_1",
      action: "select_tasks",
      status: "completed",
      startedAt: timestamp,
      planningRevision: 1,
      modelRouting: { model: "gpt-5.6-sol", route: "primary", retryCount: 0 },
      report: projectReport,
    },
    latestReport: projectReport,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const requestReport = {
    taskId: "task_1",
    attemptId: "attempt_1",
    outcome: "needs_input",
    summary: "Need a decision",
    question: "Which mode?",
  };
  const completedReport = {
    taskId: "task_1",
    attemptId: "attempt_1",
    outcome: "completed",
    summary: "Implemented the mode",
    workspacePath: "/workspace/game/.worktrees/task_1",
    candidateCommit: "candidate_1",
  };
  const task = {
    id: "task_1",
    projectId: "project_1",
    title: "Loop",
    description: "Build it",
    acceptanceCriteria: [],
    order: 1,
    status: "waiting_for_input",
    requestedAction: "develop",
    developmentThreadId: "thread_1",
    reviewAttempts: [],
    workspacePath: "/workspace/game/.worktrees/task_1",
    candidateCommit: "candidate_1",
    latestReport: completedReport,
    currentExecution: {
      attemptId: "attempt_1",
      action: "develop",
      status: "waiting_for_input",
      threadId: "thread_1",
      startedAt: timestamp,
      modelRouting: { model: "gpt-5.6-sol", route: "primary", retryCount: 0 },
      report: completedReport,
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const cancelledTask = {
    ...task,
    id: "task_2",
    status: "cancelled",
    requestedAction: null,
    latestReport: undefined,
    currentExecution: {
      ...task.currentExecution,
      attemptId: "cancel_1",
      status: "interrupted",
      threadId: "cancel_thread",
      report: undefined,
    },
    cancellation: {
      cancelledBy: "codex",
      decisionBasis: "user_confirmed",
      reason: "No longer needed",
      cancelledAt: "2026-08-11T00:02:00.000Z",
    },
  };
  const failedTask = {
    ...task,
    id: "task_3",
    status: "blocked",
    latestReport: undefined,
    currentExecution: {
      ...task.currentExecution,
      attemptId: "failed_1",
      status: "failed",
      threadId: "failed_thread",
      report: undefined,
    },
  };
  const activeTask = {
    ...task,
    id: "task_4",
    status: "developing",
    latestReport: undefined,
    currentExecution: {
      ...task.currentExecution,
      attemptId: "active_1",
      status: "running",
      threadId: "active_thread",
      report: undefined,
    },
  };
  const eventTask = (report: typeof requestReport | typeof completedReport) => ({
    ...task,
    latestReport: report,
    currentExecution: { ...task.currentExecution, report },
  });
  const events = [
    {
      schemaVersion: 1,
      eventId: "report_1",
      type: "task.reported",
      projectId: "project_1",
      taskId: "task_1",
      occurredAt: timestamp,
      state: { task: eventTask(requestReport) },
    },
    {
      schemaVersion: 1,
      eventId: "report_2",
      type: "task.reported",
      projectId: "project_1",
      taskId: "task_1",
      occurredAt: "2026-08-11T00:01:00.000Z",
      state: { task: eventTask(completedReport) },
    },
    {
      schemaVersion: 1,
      eventId: "cancel_1",
      type: "task.cancelled",
      projectId: "project_1",
      taskId: "task_2",
      attemptId: "cancel_1",
      threadId: "cancel_thread",
      occurredAt: "2026-08-11T00:02:00.000Z",
      reason: "No longer needed",
      before: { status: "developing", action: "develop" },
      after: { status: "cancelled", action: "develop" },
      data: { decisionBasis: "user_confirmed" },
      state: { task: cancelledTask },
    },
    {
      schemaVersion: 1,
      eventId: "failure_1",
      type: "turn.failed",
      projectId: "project_1",
      taskId: "task_3",
      attemptId: "failed_1",
      threadId: "failed_thread",
      occurredAt: "2026-08-11T00:03:00.000Z",
      reason: "Codex turn failed",
      before: { status: "developing", action: "develop" },
      after: { status: "blocked", action: "develop" },
      state: { task: failedTask },
    },
    {
      schemaVersion: 1,
      eventId: "active_1",
      type: "turn.started",
      projectId: "project_1",
      taskId: "task_4",
      attemptId: "active_1",
      threadId: "active_thread",
      occurredAt: "2026-08-11T00:04:00.000Z",
      after: { status: "developing", action: "develop" },
      state: { task: activeTask },
    },
  ];
  await Promise.all([
    writeFile(join(projectDirectory, "project.json"), JSON.stringify(project)),
    writeFile(join(projectDirectory, "PROJECT.md"), "# Game\n"),
    writeFile(join(taskDirectory, "task_1.json"), JSON.stringify(task)),
    writeFile(join(taskDirectory, "task_2.json"), JSON.stringify(cancelledTask)),
    writeFile(join(taskDirectory, "task_3.json"), JSON.stringify(failedTask)),
    writeFile(join(taskDirectory, "task_4.json"), JSON.stringify(activeTask)),
    writeFile(
      join(projectDirectory, "events.ndjson"),
      events.map((event) => JSON.stringify(event)).join("\n") + "\n",
    ),
  ]);
  return stateDirectory;
}
