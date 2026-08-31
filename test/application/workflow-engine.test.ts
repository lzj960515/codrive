import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { WorkflowEngine } from "../../src/application/workflow-engine.js";
import { createTaskReportActivity } from "../../src/domain/task-activity.js";
import type {
  ExecutionStatus,
  Project,
  ProjectReport,
  Task,
  TaskReport,
} from "../../src/domain/types.js";
import { ProjectStore } from "../../src/infrastructure/project-store.js";
import {
  RecordingProjectExecutor,
  RecordingTaskDispatcher,
  testModelRouting,
} from "../support/recording-executors.js";

let store: ProjectStore;
let taskDispatcher: RecordingTaskDispatcher;
let projectExecutor: RecordingProjectExecutor;
let workflow: WorkflowEngine;
let id = 0;
let now: Date;

const models = {
  primary: "gpt-5.6-sol",
  fallback: "gpt-5.6-terra",
};

function digest(document: string): string {
  return `sha256:${createHash("sha256").update(document).digest("hex")}`;
}

function readProjectEvents(store: ProjectStore, projectId: string) {
  return store.listProjectEvents(projectId);
}

beforeEach(async () => {
  store = new ProjectStore(await mkdtemp(join(tmpdir(), "codrive-workflow-")));
  taskDispatcher = new RecordingTaskDispatcher();
  projectExecutor = new RecordingProjectExecutor();
  now = new Date("2026-08-03T00:00:00.000Z");
  workflow = new WorkflowEngine(
    store,
    taskDispatcher,
    {
      maxConcurrentTasks: 2,
      models,
      now: () => now.toISOString(),
      createId: (prefix) => `${prefix}_${++id}`,
    },
    projectExecutor,
  );
  id = 0;
});

async function registerProject(taskCount = 2) {
  return workflow.registerProject({
    name: "Tiny Game",
    repositoryPath: "/workspace/game",
    defaultBranch: "main",
    productDocument: "# Tiny Game\n",
    tasks: Array.from({ length: taskCount }, (_, index) => ({
      title: `Task ${index + 1}`,
      description: `Build task ${index + 1}`,
      acceptanceCriteria: [],
    })),
  });
}

async function addProjectWork(
  projectId: string,
  tasks: Parameters<WorkflowEngine["addProjectWork"]>[1],
) {
  const project = (await store.getProject(projectId))!.project;
  const currentDocument = await store.readProductDocument(projectId);
  const nextDocument =
    `${currentDocument.trimEnd()}\n\n` +
    `Work update ${project.productFacts.revision + 1}.\n`;
  await writeFile(store.productDocumentPath(projectId), nextDocument);
  return workflow.addProjectWork(projectId, tasks, {
    decisionSummary: "Add the confirmed product work.",
    expectedRevision: project.productFacts.revision,
    expectedDigest: project.productFacts.digest,
    documentDigest: digest(nextDocument),
  });
}

async function finishProjectExecution(report: Omit<ProjectReport, "attemptId">) {
  const snapshot = (await store.getProject(report.projectId))!;
  const execution = snapshot.project.currentExecution!;
  await workflow.submitProjectReport({ ...report, attemptId: execution.attemptId });
  return workflow.completeProjectTurn(
    report.projectId,
    execution.attemptId,
    execution.turnId!,
  );
}

async function finishTaskExecution(
  taskId: string,
  report: Omit<TaskReport, "taskId" | "attemptId" | "reportOpportunityId">,
) {
  const task = (await store.findTask(taskId))!.task;
  const execution = task.currentExecution!;
  await workflow.submitReport({
    ...report,
    taskId,
    attemptId: execution.attemptId,
    reportOpportunityId: requiredReportOpportunity(execution),
  });
  return workflow.completeTurn(taskId, execution.attemptId, execution.turnId!);
}

async function bindNoCodeWork(
  targetStore: ProjectStore,
  projectId: string,
  task: Task,
  activityId: string,
): Promise<Task> {
  const activity = createTaskReportActivity({
    activityId,
    projectId,
    action: "work",
    report: {
      taskId: task.id,
      attemptId: `attempt_${activityId}`,
      reportOpportunityId: `report_opportunity_${activityId}`,
      outcome: "completed",
      summary: "Prepared for the next lifecycle stage",
    },
    occurredAt: now.toISOString(),
  });
  await targetStore.appendEvent({
    schemaVersion: 1,
    eventId: `event_${activityId}`,
    type: "task.activity_recorded",
    projectId,
    taskId: task.id,
    occurredAt: now.toISOString(),
    data: { activity },
  });
  return { ...task, workActivityId: activityId };
}

function requiredReportOpportunity(
  execution: NonNullable<Task["currentExecution"]>,
): string {
  expect(execution.reportOpportunityId).toEqual(expect.any(String));
  return execution.reportOpportunityId!;
}

async function advanceTaskToAction(
  taskId: string,
  action: NonNullable<Task["requestedAction"]>,
) {
  if (action === "work") return;
  await finishTaskExecution(taskId, {
    outcome: "completed",
    summary: "Implemented",
    workspacePath: "/workspace/game/.worktrees/task_1",
    candidateCommit: "candidate_1",
  });
  if (action === "review") return;
  await finishTaskExecution(taskId, {
    outcome: "approved",
    summary: "Approved",
    reviewedMainCommit: "main_1",
  });
}

async function startTaskAtAction(action: NonNullable<Task["requestedAction"]>) {
  const created = await registerProject(1);
  const taskId = created.tasks[0]!.id;
  await finishProjectExecution({
    projectId: created.project.id,
    outcome: "selected",
    summary: "Start the task",
    taskIds: [taskId],
  });
  await advanceTaskToAction(taskId, action);
  return {
    projectId: created.project.id,
    taskId,
    execution: (await store.findTask(taskId))!.task.currentExecution!,
  };
}

async function waitForScheduledResume(
  taskId: string,
  execution: NonNullable<Task["currentExecution"]>,
  resumeAt: string,
  summary: string,
  resumePrompt: string,
) {
  await workflow.submitReport({
    taskId,
    attemptId: execution.attemptId,
    reportOpportunityId: requiredReportOpportunity(execution),
    outcome: "blocked",
    summary,
    resumeAt,
    resumePrompt,
  });
  await workflow.completeTurn(taskId, execution.attemptId, execution.turnId!);
  const waiting = (await store.findTask(taskId))!.task;
  return {
    waiting,
    blockedActivityId: waiting.currentExecution!.submittedActivityId,
  };
}

function successfulReportForAction(
  action: NonNullable<Task["requestedAction"]>,
  taskId: string,
  attemptId: string,
  reportOpportunityId: string,
): TaskReport {
  const report = {
    taskId,
    attemptId,
    reportOpportunityId,
    outcome: action === "review" ? ("approved" as const) : ("completed" as const),
    summary: `Finished ${action} after the scheduled wait`,
  };
  switch (action) {
    case "work":
      return {
        ...report,
        workspacePath: "/workspace/game/.worktrees/task_1",
        candidateCommit: "candidate_after_resume",
      };
    case "review":
      return { ...report, reviewedMainCommit: "main_after_review" };
    case "integrate":
      return { ...report, mergedCommit: "main_after_integration" };
  }
}

function capacityFailure(turnId: string) {
  return {
    turnId,
    message: "Selected model is at capacity. Please try a different model.",
    codexErrorInfo: "serverOverloaded",
  };
}

function primaryProbeAt(task: Task): string {
  const circuit = task.currentExecution!.modelRouting.circuitBreaker;
  expect(circuit?.state).toBe("open");
  if (!circuit || circuit.state !== "open") {
    throw new Error("Expected an open model circuit");
  }
  return circuit.primaryProbeAt;
}

function projectPrimaryProbeAt(project: Project): string {
  const circuit = project.currentExecution!.modelRouting.circuitBreaker;
  expect(circuit?.state).toBe("open");
  if (!circuit || circuit.state !== "open") {
    throw new Error("Expected an open project model circuit");
  }
  return circuit.primaryProbeAt;
}

async function failCapacityAndStartRetry(taskId: string, delayMs: number) {
  const running = (await store.findTask(taskId))!.task.currentExecution!;
  await workflow.failTurn(taskId, running.attemptId, capacityFailure(running.turnId!));
  now = new Date(now.getTime() + delayMs);
  await workflow.retryScheduledExecutions(now);
}

describe("WorkflowEngine", () => {
  it("creates one open Semantic Atlas maintenance task in one planning revision", async () => {
    const created = await registerProject(1);

    const maintenance = await workflow.ensureSemanticAtlasMaintenanceTask(
      created.project.id,
    );
    const replay = await workflow.ensureSemanticAtlasMaintenanceTask(created.project.id);
    const snapshot = (await store.getProject(created.project.id))!;

    expect(replay.id).toBe(maintenance.id);
    expect(snapshot.tasks.filter(({ origin }) =>
      origin?.kind === "semantic_atlas_maintenance"
    )).toHaveLength(1);
    expect(maintenance).toMatchObject({
      status: "backlog",
      origin: { kind: "semantic_atlas_maintenance" },
    });
    expect(snapshot.project.planning).toMatchObject({
      revision: 2,
      changeReason: "system_work_added",
    });
  });

  it("persists a project thread before starting its turn", async () => {
    projectExecutor.beforeStartTurn = async (project, threadId) => {
      const stored = (await store.getProject(project.id))!.project;
      expect(stored.currentExecution?.threadId).toBe(threadId);
      expect(stored.currentExecution?.turnId).toBeUndefined();
    };

    await registerProject();

    expect(projectExecutor.started).toHaveLength(1);
  });

  it("starts independent task conversations only after AI selects their IDs", async () => {
    const created = await registerProject();
    const selectedIds = created.tasks.map(({ id }) => id);

    await finishProjectExecution({
      projectId: created.project.id,
      outcome: "selected",
      summary: "Both tasks can start",
      taskIds: selectedIds,
    });

    expect(taskDispatcher.started.map(({ task }) => task.id)).toEqual(selectedIds);
    expect(new Set(taskDispatcher.started.map(({ threadId }) => threadId)).size).toBe(
      selectedIds.length,
    );
    const updated = (await store.getProject(created.project.id))!;
    expect(updated.tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "working", requestedAction: "work" }),
        expect.objectContaining({ status: "working", requestedAction: "work" }),
      ]),
    );
  });

  it("dispatches four tasks selected in one planning attempt", async () => {
    workflow = new WorkflowEngine(
      store,
      taskDispatcher,
      {
        maxConcurrentTasks: 4,
        models,
        now: () => "2026-08-03T00:00:00.000Z",
        createId: (prefix) => `${prefix}_${++id}`,
      },
      projectExecutor,
    );
    const created = await registerProject(4);

    await finishProjectExecution({
      projectId: created.project.id,
      outcome: "selected",
      summary: "All four tasks can start independently",
      taskIds: created.tasks.map(({ id: taskId }) => taskId),
    });

    expect(taskDispatcher.started.map(({ task }) => task.id)).toEqual(
      created.tasks.map(({ id: taskId }) => taskId),
    );
    expect(projectExecutor.started).toHaveLength(1);
  });

  it("treats a partial multi-slot selection as complete for the current planning facts", async () => {
    workflow = new WorkflowEngine(
      store,
      taskDispatcher,
      {
        maxConcurrentTasks: 4,
        models,
        now: () => "2026-08-03T00:00:00.000Z",
        createId: (prefix) => `${prefix}_${++id}`,
      },
      projectExecutor,
    );
    const created = await registerProject(4);

    await finishProjectExecution({
      projectId: created.project.id,
      outcome: "selected",
      summary: "Only two tasks can start independently",
      taskIds: created.tasks.slice(0, 2).map(({ id: taskId }) => taskId),
    });

    expect(taskDispatcher.started.map(({ task }) => task.id)).toEqual(
      created.tasks.slice(0, 2).map(({ id: taskId }) => taskId),
    );
    expect(projectExecutor.started).toHaveLength(1);
  });

  it("continues a task pipeline while backlog planning waits for a project decision", async () => {
    const created = await registerProject(1);
    await finishProjectExecution({
      projectId: created.project.id,
      outcome: "selected",
      summary: "Start the foundation",
      taskIds: [created.tasks[0]!.id],
    });
    const developing = (await store.findTask(created.tasks[0]!.id))!.task;

    await addProjectWork(created.project.id, [
      {
        title: "Follow-up",
        description: "Needs a product decision",
        acceptanceCriteria: [],
      },
    ]);
    await finishProjectExecution({
      projectId: created.project.id,
      outcome: "needs_input",
      summary: "The follow-up needs a product decision",
      question: "Which product rule should the follow-up use?",
    });

    await workflow.submitReport({
      taskId: developing.id,
      attemptId: developing.currentExecution!.attemptId,
      reportOpportunityId: requiredReportOpportunity(
        developing.currentExecution!,
      ),
      outcome: "completed",
      summary: "Foundation implemented",
      workspacePath: "/workspace/game/.worktrees/foundation",
      candidateCommit: "candidate_1",
    });
    await workflow.completeTurn(
      developing.id,
      developing.currentExecution!.attemptId,
      developing.currentExecution!.turnId!,
    );

    const snapshot = (await store.getProject(created.project.id))!;
    expect(snapshot.project.status).toBe("active");
    expect(snapshot.tasks.find(({ id }) => id === developing.id)).toMatchObject({
      status: "reviewing",
      requestedAction: "review",
      currentExecution: { action: "review", status: "running" },
    });
  });

  it.each(["running", "needs_input", "failed"] as const)(
    "starts review while task selection is %s",
    async (selectionState) => {
      const created = await registerProject(2);
      const taskId = created.tasks[0]!.id;
      await finishProjectExecution({
        projectId: created.project.id,
        outcome: "selected",
        summary: "Start the foundation",
        taskIds: [taskId],
      });
      const replanned = await workflow.controlProject(created.project.id, "replan");

      if (selectionState === "needs_input") {
        await finishProjectExecution({
          projectId: created.project.id,
          outcome: "needs_input",
          summary: "A product decision is required",
          question: "Which direction should the backlog use?",
        });
      } else if (selectionState === "failed") {
        await workflow.failProjectTurn(
          created.project.id,
          replanned.currentExecution!.attemptId,
          {
            turnId: replanned.currentExecution!.turnId!,
            message: "The planning model failed",
          },
        );
      }

      await finishTaskExecution(taskId, {
        outcome: "completed",
        summary: "Implemented",
        workspacePath: "/workspace/game/.worktrees/foundation",
        candidateCommit: "candidate_1",
      });

      expect((await store.findTask(taskId))!.task).toMatchObject({
        status: "reviewing",
        requestedAction: "review",
        currentExecution: { action: "review", status: "running" },
      });
      expect((await store.getProject(created.project.id))!.project.status).toBe(
        "active",
      );
    },
  );

  it("keeps one independent review conversation across review rounds", async () => {
    const events: Array<Record<string, unknown>> = [];
    store.subscribe((event) => events.push(event as unknown as Record<string, unknown>));
    const created = await registerProject(1);
    const taskId = created.tasks[0]!.id;

    await finishProjectExecution({
      projectId: created.project.id,
      outcome: "selected",
      summary: "Start the task",
      taskIds: [taskId],
    });
    await finishTaskExecution(taskId, {
      outcome: "completed",
      summary: "Implemented",
      workspacePath: "/workspace/game/.worktrees/task",
      candidateCommit: "candidate_1",
    });
    await finishTaskExecution(taskId, {
      outcome: "changes_requested",
      summary: "One blocker remains",
      findings: ["Preserve stable identity"],
    });
    await finishTaskExecution(taskId, {
      outcome: "completed",
      summary: "Resolved the blocker",
      workspacePath: "/workspace/game/.worktrees/task",
      candidateCommit: "candidate_2",
    });

    const reviewTurns = taskDispatcher.started.filter(
      ({ task }) => task.currentExecution?.action === "review",
    );
    expect(reviewTurns).toHaveLength(2);
    expect(reviewTurns[1]!.threadId).toBe(reviewTurns[0]!.threadId);

    const createdTaskThreads = events.filter(
      (event) => event.type === "thread.created" && event.taskId === taskId,
    );
    expect(createdTaskThreads).toHaveLength(2);
  });

  it("completes a no-code work result through review and integration", async () => {
    const created = await registerProject(1);
    const taskId = created.tasks[0]!.id;
    await finishProjectExecution({
      projectId: created.project.id,
      outcome: "selected",
      summary: "Start the operational work",
      taskIds: [taskId],
    });

    await finishTaskExecution(taskId, {
      outcome: "completed",
      summary: "Validated the external operation",
      tests: "Observed the expected result without a Git candidate.",
    });
    const reviewing = (await store.findTask(taskId))!.task;
    expect(reviewing).toMatchObject({
      status: "reviewing",
      requestedAction: "review",
      currentExecution: {
        action: "review",
        workActivityId: reviewing.workActivityId,
      },
    });

    await finishTaskExecution(taskId, {
      outcome: "approved",
      summary: "Operational evidence approved",
    });
    await finishTaskExecution(taskId, {
      outcome: "completed",
      summary: "The task is fully complete",
    });

    expect((await store.findTask(taskId))!.task).toMatchObject({
      status: "done",
      requestedAction: null,
      workActivityId: reviewing.workActivityId,
    });
    const activities = await store.listTaskActivities(created.project.id, taskId);
    expect(activities.map(({ type }) => type)).toEqual([
      "work_completed",
      "review_approved",
      "integration_completed",
    ]);
    expect(activities.slice(1).map(({ workActivityId }) => workActivityId)).toEqual([
      reviewing.workActivityId,
      reviewing.workActivityId,
    ]);
  });

  it("starts fresh work after integration requests it without reusing old candidate evidence", async () => {
    const created = await registerProject(1);
    const taskId = created.tasks[0]!.id;
    await finishProjectExecution({
      projectId: created.project.id,
      outcome: "selected",
      summary: "Start the code-backed work",
      taskIds: [taskId],
    });
    await finishTaskExecution(taskId, {
      outcome: "completed",
      summary: "Prepared the original candidate",
      workspacePath: "/workspace/game/.worktrees/task",
      candidateCommit: "candidate_1",
    });
    const firstWorkActivityId = (await store.findTask(taskId))!.task.workActivityId!;
    await finishTaskExecution(taskId, {
      outcome: "approved",
      summary: "Approved the original candidate",
      reviewedMainCommit: "main_1",
    });

    await finishTaskExecution(taskId, {
      outcome: "work_required",
      summary: "Integration exposed follow-up work",
      mergedCommit: "main_2",
    });
    expect((await store.findTask(taskId))!.task).toMatchObject({
      status: "working",
      requestedAction: "work",
      workActivityId: firstWorkActivityId,
      currentExecution: { action: "work" },
    });

    await finishTaskExecution(taskId, {
      outcome: "completed",
      summary: "Completed the follow-up without a Git candidate",
    });
    const secondRound = (await store.findTask(taskId))!.task;
    expect(secondRound.workActivityId).not.toBe(firstWorkActivityId);
    expect(secondRound.currentExecution).toMatchObject({
      action: "review",
      workActivityId: secondRound.workActivityId,
    });

    // The new no-code result, not the earlier candidate, controls Git evidence rules.
    await finishTaskExecution(taskId, {
      outcome: "approved",
      summary: "Approved the follow-up result",
    });
    await finishTaskExecution(taskId, {
      outcome: "completed",
      summary: "Closed the task after the follow-up",
    });

    expect((await store.findTask(taskId))!.task.status).toBe("done");
    const activities = await store.listTaskActivities(created.project.id, taskId);
    expect(activities.filter(({ type }) => type === "work_completed")).toHaveLength(2);
    expect(
      activities.find(({ id }) => id === secondRound.workActivityId)?.evidence
        ?.candidateCommit,
    ).toBeUndefined();
  });

  it("turns integration changes into a new reviewable work result", async () => {
    const created = await registerProject(1);
    const taskId = created.tasks[0]!.id;
    await finishProjectExecution({
      projectId: created.project.id,
      outcome: "selected",
      summary: "Start the candidate",
      taskIds: [taskId],
    });
    await finishTaskExecution(taskId, {
      outcome: "completed",
      summary: "Prepared the candidate",
      workspacePath: "/workspace/game/.worktrees/task",
      candidateCommit: "candidate_1",
    });
    const originalWorkActivityId = (await store.findTask(taskId))!.task
      .workActivityId!;
    await finishTaskExecution(taskId, {
      outcome: "approved",
      summary: "Approved the candidate",
      reviewedMainCommit: "main_1",
    });

    await finishTaskExecution(taskId, {
      outcome: "needs_review",
      summary: "Conflict resolution changed the candidate",
      workspacePath: "/workspace/game/.worktrees/task",
      candidateCommit: "candidate_2",
    });

    const reviewing = (await store.findTask(taskId))!.task;
    expect(reviewing).toMatchObject({
      status: "reviewing",
      requestedAction: "review",
      currentExecution: {
        action: "review",
        workActivityId: reviewing.workActivityId,
      },
    });
    expect(reviewing.workActivityId).not.toBe(originalWorkActivityId);
    const newWork = (
      await store.listTaskActivities(created.project.id, taskId)
    ).find(({ id }) => id === reviewing.workActivityId);
    expect(newWork).toMatchObject({
      type: "work_completed",
      action: "integrate",
      outcome: "needs_review",
      workActivityId: reviewing.workActivityId,
      evidence: {
        workspacePath: "/workspace/game/.worktrees/task",
        candidateCommit: "candidate_2",
      },
    });
  });

  it("advances planning only after a task completes its full pipeline", async () => {
    const created = await registerProject(2);
    const taskId = created.tasks[0]!.id;
    await finishProjectExecution({
      projectId: created.project.id,
      outcome: "selected",
      summary: "Start the foundation",
      taskIds: [taskId],
    });

    await finishTaskExecution(taskId, {
      outcome: "completed",
      summary: "Implemented",
      workspacePath: "/workspace/game/.worktrees/foundation",
      candidateCommit: "candidate_1",
    });
    expect((await store.getProject(created.project.id))!.project.planning.revision).toBe(1);

    await finishTaskExecution(taskId, {
      outcome: "approved",
      summary: "Approved",
      reviewedMainCommit: "main_1",
    });
    expect((await store.getProject(created.project.id))!.project.planning.revision).toBe(1);

    await finishTaskExecution(taskId, {
      outcome: "completed",
      summary: "Integrated",
      mergedCommit: "main_2",
    });

    const snapshot = (await store.getProject(created.project.id))!;
    expect(snapshot.tasks.find(({ id }) => id === taskId)?.status).toBe("done");
    expect(snapshot.project.planning).toMatchObject({
      revision: 2,
      changeReason: "task_completed",
    });
    expect(projectExecutor.started).toHaveLength(2);
    expect(projectExecutor.started[1]?.project.currentExecution).toMatchObject({
      action: "select_tasks",
      planningRevision: 2,
    });
  });

  it("supersedes a running selection when integration completes a task", async () => {
    const created = await registerProject(2);
    const taskId = created.tasks[0]!.id;
    await finishProjectExecution({
      projectId: created.project.id,
      outcome: "selected",
      summary: "Start the foundation",
      taskIds: [taskId],
    });
    await finishTaskExecution(taskId, {
      outcome: "completed",
      summary: "Implemented",
      workspacePath: "/workspace/game/.worktrees/foundation",
      candidateCommit: "candidate_1",
    });
    await finishTaskExecution(taskId, {
      outcome: "approved",
      summary: "Approved",
      reviewedMainCommit: "main_1",
    });
    const replanned = await workflow.controlProject(created.project.id, "replan");
    const supersededSelection = replanned.currentExecution!;

    await finishTaskExecution(taskId, {
      outcome: "completed",
      summary: "Integrated",
      mergedCommit: "main_2",
    });

    const snapshot = (await store.getProject(created.project.id))!;
    expect(snapshot.project.planning).toMatchObject({
      revision: 3,
      changeReason: "task_completed",
    });
    expect(snapshot.project.currentExecution).toMatchObject({
      action: "select_tasks",
      planningRevision: 3,
    });
    expect(projectExecutor.interrupted).toHaveLength(1);
    await expect(
      workflow.submitProjectReport({
        projectId: created.project.id,
        attemptId: supersededSelection.attemptId,
        outcome: "selected",
        summary: "This result belongs to revision 2",
        taskIds: [created.tasks[1]!.id],
      }),
    ).rejects.toThrow(/does not match the current project execution/i);
    expect((await store.findTask(created.tasks[1]!.id))!.task.requestedAction).toBe(
      null,
    );
  });

  it("waits for a blocked selected task until cancellation changes planning facts", async () => {
    const created = await registerProject(2);
    const taskId = created.tasks[0]!.id;
    await finishProjectExecution({
      projectId: created.project.id,
      outcome: "selected",
      summary: "Start the foundation",
      taskIds: [taskId],
    });

    await finishTaskExecution(taskId, {
      outcome: "blocked",
      summary: "The required tool is unavailable",
    });
    await workflow.recoverProjectsWithoutActiveWork();
    await workflow.recoverProjectsWithoutActiveWork();

    let snapshot = (await store.getProject(created.project.id))!;
    expect(snapshot.project.planning.revision).toBe(1);
    expect(projectExecutor.started).toHaveLength(1);

    await workflow.cancelTask(taskId, {
      cancelledBy: "codex",
      decisionBasis: "agent_decision",
      reason: "The blocked task is no longer required",
    });
    snapshot = (await store.getProject(created.project.id))!;
    expect(snapshot.project.planning).toMatchObject({
      revision: 2,
      changeReason: "task_cancelled",
    });
    expect(projectExecutor.started).toHaveLength(2);
  });

  it.each([
    {
      decisionBasis: "user_confirmed" as const,
      reason: "The user confirmed that D1 must be reviewed before replacing D2",
    },
    {
      decisionBasis: "agent_decision" as const,
      reason: "The duplicate task is fully covered by the accepted replacement",
    },
  ])(
    "persists a $decisionBasis Codex cancellation with its reason",
    async ({ decisionBasis, reason }) => {
      const created = await registerProject(1);
      const taskId = created.tasks[0]!.id;

      const cancelled = (await workflow.execute(
        {
          type: "task.control",
          payload: { taskId, action: "cancel", decisionBasis, reason },
        },
        "skill",
      )) as Task;

      expect(cancelled).toMatchObject({
        status: "cancelled",
        requestedAction: null,
        cancellation: {
          cancelledBy: "codex",
          decisionBasis,
          reason,
          cancelledAt: "2026-08-03T00:00:00.000Z",
        },
      });
    },
  );

  it("propagates a reasoned Codex project cancellation to unfinished tasks", async () => {
    const created = await registerProject(1);

    const cancelled = await workflow.execute(
      {
        type: "project.control",
        payload: {
          projectId: created.project.id,
          action: "cancel",
          decisionBasis: "agent_decision",
          reason: "The registered project duplicates an active canonical project",
        },
      },
      "skill",
    );

    expect(cancelled).toMatchObject({
      status: "cancelled",
      scheduling: "paused",
      cancellation: {
        cancelledBy: "codex",
        decisionBasis: "agent_decision",
        reason: "The registered project duplicates an active canonical project",
      },
    });
    expect((await store.findTask(created.tasks[0]!.id))!.task).toMatchObject({
      status: "cancelled",
      cancellation: {
        cancelledBy: "codex",
        decisionBasis: "agent_decision",
        reason: "The registered project duplicates an active canonical project",
      },
    });
  });

  it("starts one independent task selection per project", async () => {
    const first = await registerProject(1);
    const second = await registerProject(1);

    expect(projectExecutor.started).toHaveLength(2);
    expect(projectExecutor.started[0]?.project.id).toBe(first.project.id);
    expect(projectExecutor.started[1]?.project.id).toBe(second.project.id);
    expect(
      projectExecutor.started.map(
        ({ project }) => project.currentExecution?.selectionCapacity,
      ),
    ).toEqual([2, 2]);
  });

  it("dispatches each project's tasks against its own concurrency limit", async () => {
    const first = await store.createProject({
      name: "First",
      repositoryPath: "/workspace/first",
      defaultBranch: "main",
      productDocument: "# First\n",
      tasks: [{ title: "First task", description: "Build", acceptanceCriteria: [] }],
    });
    const second = await store.createProject({
      name: "Second",
      repositoryPath: "/workspace/second",
      defaultBranch: "main",
      productDocument: "# Second\n",
      tasks: [{ title: "Second task", description: "Build", acceptanceCriteria: [] }],
    });
    await store.saveTask(first.project.id, {
      ...first.tasks[0]!,
      requestedAction: "work",
    });
    await store.saveTask(second.project.id, {
      ...second.tasks[0]!,
      requestedAction: "work",
    });
    const perProjectDispatcher = new RecordingTaskDispatcher();
    const perProjectWorkflow = new WorkflowEngine(
      store,
      perProjectDispatcher,
      { maxConcurrentTasks: 1, models },
      new RecordingProjectExecutor(),
    );

    await perProjectWorkflow.reconcile();

    expect(perProjectDispatcher.started.map(({ task }) => task.projectId).sort()).toEqual(
      [first.project.id, second.project.id].sort(),
    );
  });

  it("does not let one project's selection failure block another project", async () => {
    const first = await store.createProject({
      name: "First",
      repositoryPath: "/workspace/first",
      defaultBranch: "main",
      productDocument: "# First\n",
      tasks: [{ title: "First task", description: "Build", acceptanceCriteria: [] }],
    });
    const second = await store.createProject({
      name: "Second",
      repositoryPath: "/workspace/second",
      defaultBranch: "main",
      productDocument: "# Second\n",
      tasks: [{ title: "Second task", description: "Build", acceptanceCriteria: [] }],
    });
    let startCount = 0;
    projectExecutor.beforeStartTurn = async () => {
      startCount += 1;
      if (startCount === 1) throw new Error("Planner failed to start");
    };

    await workflow.reconcile();

    expect((await store.getProject(first.project.id))!.project).toMatchObject({
      status: "active",
      planning: { revision: 1, evaluatedRevision: 1 },
      currentExecution: {
        action: "select_tasks",
        status: "failed",
        result: { outcome: "blocked", summary: "Planner failed to start" },
      },
    });
    expect((await store.getProject(second.project.id))!.project.currentExecution).toMatchObject({
      action: "select_tasks",
      status: "running",
    });
    expect(projectExecutor.started).toHaveLength(1);
    expect(projectExecutor.started[0]?.project.id).toBe(second.project.id);
  });

  it("keeps captured capacity when same-project work claims live slots", async () => {
    const capacityStore = new ProjectStore(
      await mkdtemp(join(tmpdir(), "codrive-selection-capacity-")),
    );
    const capacityDispatcher = new RecordingTaskDispatcher();
    const capacityExecutor = new RecordingProjectExecutor();
    const capacityWorkflow = new WorkflowEngine(
      capacityStore,
      capacityDispatcher,
      { maxConcurrentTasks: 2, models },
      capacityExecutor,
    );
    const planned = await capacityStore.createProject({
      name: "Planned",
      repositoryPath: "/workspace/planned",
      defaultBranch: "main",
      productDocument: "# Planned\n",
      tasks: [
        { title: "Busy one", description: "Build", acceptanceCriteria: [] },
        { title: "Busy two", description: "Build", acceptanceCriteria: [] },
        { title: "Selected one", description: "Build", acceptanceCriteria: [] },
        { title: "Selected two", description: "Build", acceptanceCriteria: [] },
      ],
    });
    await capacityWorkflow.reconcile();
    const selection = (await capacityStore.getProject(planned.project.id))!.project
      .currentExecution!;
    expect(selection.selectionCapacity).toBe(2);

    for (const [index, task] of planned.tasks.slice(0, 2).entries()) {
      await capacityStore.saveTask(planned.project.id, {
        ...task,
        status: "working",
        requestedAction: "work",
        currentExecution: {
          attemptId: `busy_${index}`,
          reportOpportunityId: `report_opportunity_busy_${index}`,
          action: "work",
          status: "running",
          startedAt: "2026-08-03T00:00:00.000Z",
          modelRouting: testModelRouting(),
        },
      });
    }
    await capacityWorkflow.submitProjectReport({
      projectId: planned.project.id,
      attemptId: selection.attemptId,
      outcome: "selected",
      summary: "Both planned tasks are independent",
      taskIds: planned.tasks.slice(2).map(({ id }) => id),
    });
    await capacityWorkflow.completeProjectTurn(
      planned.project.id,
      selection.attemptId,
      selection.turnId!,
    );

    let plannedSnapshot = (await capacityStore.getProject(planned.project.id))!;
    expect(plannedSnapshot.tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "backlog", requestedAction: "work" }),
        expect.objectContaining({ status: "backlog", requestedAction: "work" }),
      ]),
    );
    expect(capacityDispatcher.started).toHaveLength(0);

    for (const task of planned.tasks.slice(0, 2)) {
      const current = (await capacityStore.findTask(task.id))!.task;
      await capacityStore.saveTask(planned.project.id, {
        ...current,
        status: "done",
        requestedAction: null,
        currentExecution: {
          ...current.currentExecution!,
          status: "completed",
          finishedAt: "2026-08-03T01:00:00.000Z",
        },
      });
    }
    await capacityWorkflow.reconcile();

    plannedSnapshot = (await capacityStore.getProject(planned.project.id))!;
    expect(plannedSnapshot.tasks.slice(0, 2).every(({ status }) => status === "done"))
      .toBe(true);
    expect(
      plannedSnapshot.tasks.slice(2).every(({ status }) => status === "working"),
    ).toBe(true);
    expect(capacityDispatcher.started).toHaveLength(2);
  });

  it("dispatches an existing task continuation before reserved development", async () => {
    const priorityStore = new ProjectStore(
      await mkdtemp(join(tmpdir(), "codrive-continuation-priority-")),
    );
    const priorityDispatcher = new RecordingTaskDispatcher();
    const priorityWorkflow = new WorkflowEngine(
      priorityStore,
      priorityDispatcher,
      { maxConcurrentTasks: 1, models },
      new RecordingProjectExecutor(),
    );
    const project = await priorityStore.createProject({
      name: "Prioritized",
      repositoryPath: "/workspace/prioritized",
      defaultBranch: "main",
      productDocument: "# Prioritized\n",
      tasks: [
        { title: "Review me", description: "Review", acceptanceCriteria: [] },
        { title: "Develop me", description: "Develop", acceptanceCriteria: [] },
      ],
    });
    const reviewable = await bindNoCodeWork(
      priorityStore,
      project.project.id,
      project.tasks[0]!,
      "activity_priority_work",
    );
    await priorityStore.saveTask(project.project.id, {
      ...reviewable,
      status: "reviewing",
      requestedAction: "review",
      currentExecution: {
        attemptId: "developed",
        reportOpportunityId: "report_opportunity_developed",
        action: "work",
        status: "completed",
        startedAt: "2026-08-03T00:00:00.000Z",
        modelRouting: testModelRouting(),
        finishedAt: "2026-08-03T00:30:00.000Z",
      },
    });
    await priorityStore.saveTask(project.project.id, {
      ...project.tasks[1]!,
      requestedAction: "work",
    });

    await priorityWorkflow.reconcile();

    expect(priorityDispatcher.started).toHaveLength(1);
    expect(priorityDispatcher.started[0]?.task.id).toBe(project.tasks[0]!.id);
    expect((await priorityStore.findTask(project.tasks[1]!.id))!.task.status).toBe(
      "backlog",
    );
  });

  it("manually replans the same project with a new revision", async () => {
    const created = await registerProject(2);
    await finishProjectExecution({
      projectId: created.project.id,
      outcome: "selected",
      summary: "Start one task",
      taskIds: [created.tasks[0]!.id],
    });

    const replanned = await workflow.controlProject(created.project.id, "replan");

    expect(replanned.planning).toMatchObject({
      revision: 2,
      changeReason: "manual_replan",
    });
    expect(replanned.currentExecution).toMatchObject({
      action: "select_tasks",
      planningRevision: 2,
      selectionCapacity: 1,
    });
    expect(projectExecutor.started).toHaveLength(2);
  });

  it("reevaluates unchanged tasks when the concurrency limit increases", async () => {
    const created = await store.createProject({
      name: "Tiny Game",
      repositoryPath: "/workspace/game",
      defaultBranch: "main",
      productDocument: "# Tiny Game\n",
      tasks: [
        { title: "Foundation", description: "Build it", acceptanceCriteria: [] },
        { title: "Gameplay", description: "Build it too", acceptanceCriteria: [] },
      ],
    });
    await store.saveTask(created.project.id, {
      ...created.tasks[0]!,
      status: "working",
      requestedAction: "work",
      currentExecution: {
        attemptId: "attempt_1",
        reportOpportunityId: "report_opportunity_1",
        action: "work",
        status: "running",
        startedAt: "2026-08-03T00:00:00.000Z",
        modelRouting: testModelRouting(),
      },
    });

    const singleTaskWorkflow = new WorkflowEngine(
      store,
      new RecordingTaskDispatcher(),
      { maxConcurrentTasks: 1, models },
      new RecordingProjectExecutor(),
    );
    await singleTaskWorkflow.reconcile();

    const expandedExecutor = new RecordingProjectExecutor();
    const expandedWorkflow = new WorkflowEngine(
      store,
      new RecordingTaskDispatcher(),
      { maxConcurrentTasks: 4, models },
      expandedExecutor,
    );
    await expandedWorkflow.reconcile();
    await expandedWorkflow.reconcile();

    expect(expandedExecutor.started).toHaveLength(1);
    expect(expandedExecutor.started[0]?.project.requestedAction).toBe(
      "select_tasks",
    );
    expect((await store.getProject(created.project.id))!.project.planning).toMatchObject({
      revision: 2,
      changeReason: "concurrency_changed",
      concurrencyLimit: 4,
    });
  });

  it("does not let another project's active work consume selection capacity", async () => {
    const activeProject = await store.createProject({
      name: "Active Game",
      repositoryPath: "/workspace/active-game",
      defaultBranch: "main",
      productDocument: "# Active Game\n",
      tasks: [
        { title: "Foundation", description: "Build it", acceptanceCriteria: [] },
      ],
    });
    await store.saveTask(activeProject.project.id, {
      ...activeProject.tasks[0]!,
      status: "working",
      requestedAction: "work",
      currentExecution: {
        attemptId: "attempt_active",
        reportOpportunityId: "report_opportunity_active",
        action: "work",
        status: "running",
        startedAt: "2026-08-03T00:00:00.000Z",
        modelRouting: testModelRouting(),
      },
    });
    const waitingProject = await store.createProject({
      name: "Waiting Game",
      repositoryPath: "/workspace/waiting-game",
      defaultBranch: "main",
      productDocument: "# Waiting Game\n",
      tasks: [
        { title: "Gameplay", description: "Build it", acceptanceCriteria: [] },
      ],
    });
    const singleSlotExecutor = new RecordingProjectExecutor();
    const singleSlotWorkflow = new WorkflowEngine(
      store,
      new RecordingTaskDispatcher(),
      { maxConcurrentTasks: 1, models },
      singleSlotExecutor,
    );

    await singleSlotWorkflow.reconcile();

    const selections = singleSlotExecutor.started.filter(
      ({ project }) => project.requestedAction === "select_tasks",
    );
    expect(selections).toHaveLength(1);
    expect(selections[0]?.project.id).toBe(waitingProject.project.id);
    expect(selections[0]?.project.currentExecution?.selectionCapacity).toBe(1);
  });

  it("persists a task thread before starting its turn", async () => {
    const created = await registerProject(1);
    taskDispatcher.beforeStartTurn = async (request, threadId) => {
      const stored = (await store.findTask(request.task.id))!.task;
      expect(stored.currentExecution?.threadId).toBe(threadId);
      expect(stored.currentExecution?.turnId).toBeUndefined();
    };

    await finishProjectExecution({
      projectId: created.project.id,
      outcome: "selected",
      summary: "Start the task",
      taskIds: [created.tasks[0]!.id],
    });

    expect(taskDispatcher.started).toHaveLength(1);
  });

  it("records a terminal activity when a task turn cannot start", async () => {
    const created = await registerProject(1);
    taskDispatcher.beforeStartTurn = async () => {
      throw new Error("Codex task turn failed to start");
    };

    await finishProjectExecution({
      projectId: created.project.id,
      outcome: "selected",
      summary: "Start the task",
      taskIds: [created.tasks[0]!.id],
    });

    expect((await store.findTask(created.tasks[0]!.id))!.task).toMatchObject({
      status: "blocked",
      currentExecution: { status: "failed" },
    });
    expect(
      await store.listTaskActivities(created.project.id, created.tasks[0]!.id),
    ).toEqual([
      expect.objectContaining({
        type: "execution_failed",
        summary: "Codex task turn failed to start",
        threadId: "task_thread_1",
      }),
    ]);
  });

  it("lets the same project turn correct invalid task selection reports", async () => {
    const created = await registerProject(3);
    const project = (await store.getProject(created.project.id))!.project;
    const execution = project.currentExecution!;

    const expectRejectedWithoutEndingTurn = async (
      report: Pick<ProjectReport, "outcome" | "summary" | "taskIds">,
      expectedError: RegExp,
    ) => {
      await expect(
        workflow.submitProjectReport({
          projectId: created.project.id,
          attemptId: execution.attemptId,
          ...report,
        }),
      ).rejects.toThrow(expectedError);

      const rejected = (await store.getProject(project.id))!.project;
      expect(rejected.currentExecution).toMatchObject({
        attemptId: execution.attemptId,
        threadId: execution.threadId,
        turnId: execution.turnId,
        status: "running",
      });
      expect(rejected.currentExecution?.result).toBeUndefined();
    };

    await expectRejectedWithoutEndingTurn(
      {
        outcome: "selected",
        summary: "Duplicate selection",
        taskIds: [created.tasks[0]!.id, created.tasks[0]!.id],
      },
      /unique/i,
    );
    await expectRejectedWithoutEndingTurn(
      {
        outcome: "selected",
        summary: "Unknown task",
        taskIds: ["task_does_not_exist"],
      },
      new RegExp(`not available.*Available task IDs:.*${created.tasks[0]!.id}`, "i"),
    );
    await expectRejectedWithoutEndingTurn(
      {
        outcome: "selected",
        summary: "Too many tasks",
        taskIds: created.tasks.map(({ id }) => id),
      },
      /only 2 slots are available/i,
    );
    await expectRejectedWithoutEndingTurn(
      {
        outcome: "wait_for_active_tasks",
        summary: "Wait without ongoing work",
      },
      /requires at least one ongoing task/i,
    );
    expect(projectExecutor.opened).toHaveLength(1);
    expect(projectExecutor.started).toHaveLength(1);

    await workflow.submitProjectReport({
      projectId: created.project.id,
      attemptId: execution.attemptId,
      outcome: "selected",
      summary: "Corrected selection",
      taskIds: created.tasks.slice(0, 2).map(({ id }) => id),
    });
    await workflow.completeProjectTurn(
      project.id,
      execution.attemptId,
      execution.turnId!,
    );

    expect(projectExecutor.opened).toHaveLength(1);
    expect(projectExecutor.started).toHaveLength(1);
    expect(taskDispatcher.started.map(({ task }) => task.id)).toEqual(
      created.tasks.slice(0, 2).map(({ id }) => id),
    );
  });

  it("keeps project lifecycle and scheduling control independent", async () => {
    const created = await store.createProject({
      name: "Tiny Game",
      repositoryPath: "/workspace/game",
      defaultBranch: "main",
      productDocument: "# Tiny Game\n",
      tasks: [
        { title: "Task", description: "Build it", acceptanceCriteria: [] },
      ],
    });

    const paused = await workflow.controlProject(created.project.id, "pause");
    expect(paused).toMatchObject({ status: "active", scheduling: "paused" });

    const withWork = await addProjectWork(created.project.id, [
      { title: "More", description: "Add more", acceptanceCriteria: [] },
    ]);
    expect(withWork.project).toMatchObject({
      status: "active",
      scheduling: "paused",
    });

    const resumed = await workflow.controlProject(created.project.id, "resume");
    expect(resumed.scheduling).toBe("running");
    expect(projectExecutor.started).toHaveLength(1);
  });

  it("archives and restores a project without changing its lifecycle status", async () => {
    const created = await store.createProject({
      name: "Tiny Game",
      repositoryPath: "/workspace/game",
      defaultBranch: "main",
      productDocument: "# Tiny Game\n",
      tasks: [{ title: "Task", description: "Build it", acceptanceCriteria: [] }],
    });
    await store.saveTask(created.project.id, {
      ...created.tasks[0]!,
      status: "blocked",
      requestedAction: "work",
    });

    const archived = await workflow.controlProject(created.project.id, "archive");
    expect(archived).toMatchObject({
      status: "active",
      scheduling: "paused",
      archivedAt: "2026-08-03T00:00:00.000Z",
    });
    await workflow.controlProject(created.project.id, "archive");
    await workflow.reconcile();
    expect(projectExecutor.started).toHaveLength(0);

    now = new Date("2026-08-03T00:05:00.000Z");
    const restored = await workflow.controlProject(created.project.id, "unarchive");
    expect(restored).toMatchObject({ status: "active", scheduling: "paused" });
    expect(restored).not.toHaveProperty("archivedAt");
    await workflow.controlProject(created.project.id, "unarchive");
    expect(projectExecutor.started).toHaveLength(0);

    expect(
      (await readProjectEvents(store, created.project.id))
        .filter(({ type }) => ["project.archived", "project.unarchived"].includes(type))
        .map(({ type }) => type),
    ).toEqual(["project.archived", "project.unarchived"]);
  });

  it("keeps a restored failed project paused until scheduling is resumed", async () => {
    const created = await registerProject(1);
    const failedExecution = created.project.currentExecution!;
    await workflow.failProjectTurn(
      created.project.id,
      failedExecution.attemptId,
      {
        turnId: failedExecution.turnId!,
        message: "Planner process failed",
      },
    );
    await workflow.controlProject(created.project.id, "archive");
    const restored = await workflow.controlProject(
      created.project.id,
      "unarchive",
    );

    await expect(workflow.retryProject(created.project.id)).rejects.toThrow(
      /resumed.*retry/i,
    );

    expect(restored).toMatchObject({
      scheduling: "paused",
      currentExecution: {
        attemptId: failedExecution.attemptId,
        status: "failed",
      },
    });
    expect(projectExecutor.started).toHaveLength(1);
  });

  it("archives idle and cancelled projects while preserving their status", async () => {
    for (const status of ["idle", "cancelled"] as const) {
      const created = await store.createProject({
        name: `Project ${status}`,
        repositoryPath: `/workspace/${status}`,
        defaultBranch: "main",
        productDocument: `# ${status}\n`,
        tasks: [{ title: "Task", description: "Done", acceptanceCriteria: [] }],
      });
      await store.saveProject({
        ...created.project,
        status,
        scheduling: status === "cancelled" ? "paused" : "running",
      });

      const archived = await workflow.controlProject(created.project.id, "archive");

      expect(archived).toMatchObject({ status, scheduling: "paused" });
      expect(archived.archivedAt).toBe("2026-08-03T00:00:00.000Z");
    }
  });

  it("rejects archiving while the project or one of its tasks has active execution state", async () => {
    const blockingStatuses = [
      "pending",
      "running",
      "retry_scheduled",
      "awaiting_report",
      "waiting_for_input",
      "waiting_for_resume",
    ] as const satisfies readonly ExecutionStatus[];
    const statusLabels: Record<(typeof blockingStatuses)[number], string> = {
      pending: "正在启动",
      running: "正在运行",
      retry_scheduled: "等待重试",
      awaiting_report: "等待汇报",
      waiting_for_input: "等待输入",
      waiting_for_resume: "计划等待",
    };

    for (const status of blockingStatuses) {
      const created = await store.createProject({
        name: `Project ${status}`,
        repositoryPath: `/workspace/${status}`,
        defaultBranch: "main",
        productDocument: `# ${status}\n`,
        tasks: [{ title: "Task", description: "In progress", acceptanceCriteria: [] }],
      });
      await store.saveTask(created.project.id, {
        ...created.tasks[0]!,
        status: status === "waiting_for_input" ? "waiting_for_input" : "working",
        requestedAction: "work",
        currentExecution: {
          attemptId: `attempt_${status}`,
          reportOpportunityId: `report_${status}`,
          action: "work",
          status,
          startedAt: now.toISOString(),
          modelRouting: testModelRouting(),
        },
      });

      await expect(
        workflow.controlProject(created.project.id, "archive"),
      ).rejects.toThrow(
        new RegExp(`任务.*${statusLabels[status]}.*完成或取消.*归档`),
      );
      expect((await store.getProject(created.project.id))!.project).not.toHaveProperty(
        "archivedAt",
      );
    }

    const planning = await store.createProject({
      name: "Planning",
      repositoryPath: "/workspace/planning",
      defaultBranch: "main",
      productDocument: "# Planning\n",
      tasks: [{ title: "Task", description: "Backlog", acceptanceCriteria: [] }],
    });
    await store.saveProject({
      ...planning.project,
      requestedAction: "select_tasks",
      currentExecution: {
        attemptId: "planning_attempt",
        action: "select_tasks",
        status: "running",
        startedAt: now.toISOString(),
        modelRouting: testModelRouting(),
      },
    });

    await expect(
      workflow.controlProject(planning.project.id, "archive"),
    ).rejects.toThrow(/项目规划执行.*正在运行.*完成或取消.*归档/);
  });

  it("preserves idle while project scheduling is paused and resumed", async () => {
    const created = await store.createProject({
      name: "Tiny Game",
      repositoryPath: "/workspace/game",
      defaultBranch: "main",
      productDocument: "# Tiny Game\n",
      tasks: [{ title: "Task", description: "Build it", acceptanceCriteria: [] }],
    });
    await store.saveTask(created.project.id, {
      ...created.tasks[0]!,
      status: "done",
    });
    await workflow.reconcile();

    const paused = await workflow.controlProject(created.project.id, "pause");
    expect(paused).toMatchObject({ status: "idle", scheduling: "paused" });

    const resumed = await workflow.controlProject(created.project.id, "resume");
    expect(resumed).toMatchObject({ status: "idle", scheduling: "running" });
    expect(projectExecutor.started).toHaveLength(0);
  });

  it("accepts a locally edited product document and replaces stale task selection", async () => {
    const created = await store.createProject({
      name: "Tiny Game",
      repositoryPath: "/workspace/game",
      defaultBranch: "main",
      productDocument: "# Tiny Game\n",
      tasks: [{ title: "Task", description: "Build it", acceptanceCriteria: [] }],
    });
    await workflow.reconcile();
    const before = (await store.getProject(created.project.id))!.project;
    const previousExecution = before.currentExecution!;
    const productDocument = "# Tiny Game\n\nSupport keyboard and controller.\n";
    await writeFile(store.productDocumentPath(created.project.id), productDocument);

    const project = await workflow.updateProductDocument(created.project.id, {
      decisionSummary: "Support keyboard and controller.",
      expectedRevision: before.productFacts.revision,
      expectedDigest: before.productFacts.digest,
      documentDigest: digest(productDocument),
    });

    expect(project).toMatchObject({
      status: "active",
      productFacts: {
        revision: 2,
        digest: digest(productDocument),
      },
      planning: { revision: 2, changeReason: "product_document_updated" },
      currentExecution: { action: "select_tasks", planningRevision: 2 },
    });
    expect(project.currentExecution?.attemptId).not.toBe(
      previousExecution.attemptId,
    );
    expect(projectExecutor.interrupted).toHaveLength(1);

    const events = await readProjectEvents(store, created.project.id);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "project.product_document_updated",
        decision: "Support keyboard and controller.",
      }),
    );
    expect(JSON.stringify(project)).not.toContain("Support keyboard and controller.");
  });

  it("rejects stale product document notifications without changing accepted facts", async () => {
    const created = await registerProject(1);
    const accepted = created.project.productFacts;
    const firstDocument = "# Tiny Game\n\nFirst revision.\n";
    await writeFile(store.productDocumentPath(created.project.id), firstDocument);
    await workflow.updateProductDocument(created.project.id, {
      decisionSummary: "Accept the first revision.",
      expectedRevision: accepted.revision,
      expectedDigest: accepted.digest,
      documentDigest: digest(firstDocument),
    });

    const secondDocument = "# Tiny Game\n\nSecond revision.\n";
    await writeFile(store.productDocumentPath(created.project.id), secondDocument);
    await expect(
      workflow.updateProductDocument(created.project.id, {
        decisionSummary: "Attempt a stale second revision.",
        expectedRevision: accepted.revision,
        expectedDigest: accepted.digest,
        documentDigest: digest(secondDocument),
      }),
    ).rejects.toThrow(/stale|superseded/i);

    expect((await store.getProject(created.project.id))!.project.productFacts)
      .toMatchObject({ revision: 2, digest: digest(firstDocument) });
  });

  it("rejects task selection after PROJECT.md changes but before notification", async () => {
    const created = await registerProject(1);
    const execution = created.project.currentExecution!;
    await writeFile(
      store.productDocumentPath(created.project.id),
      "# Tiny Game\n\nUnrecorded local change.\n",
    );

    await expect(
      workflow.submitProjectReport({
        projectId: created.project.id,
        attemptId: execution.attemptId,
        outcome: "selected",
        summary: "This selection used the earlier document.",
        taskIds: [created.tasks[0]!.id],
      }),
    ).rejects.toThrow(/PROJECT\.md|product facts|document/i);
    await expect(workflow.availableTaskSlots(created.project.id)).resolves.toBe(0);
    expect((await store.findTask(created.tasks[0]!.id))!.task.requestedAction).toBe(
      null,
    );
  });

  it("restarts temporary project selection when new work changes its facts", async () => {
    const created = await registerProject(1);
    const firstExecution = created.project.currentExecution!;

    const updated = await addProjectWork(created.project.id, [
      { title: "Audio", description: "Add audio", acceptanceCriteria: [] },
    ]);

    expect(projectExecutor.interrupted).toHaveLength(1);
    expect(projectExecutor.started).toHaveLength(2);
    expect(updated.tasks).toHaveLength(2);
    expect(updated.project.currentExecution).toMatchObject({
      action: "select_tasks",
      status: "running",
    });
    expect(updated.project.currentExecution?.attemptId).not.toBe(
      firstExecution.attemptId,
    );
    await expect(
      workflow.submitProjectReport({
        projectId: created.project.id,
        attemptId: firstExecution.attemptId,
        outcome: "selected",
        summary: "This report arrived after its planning facts changed",
        taskIds: [created.tasks[0]!.id],
      }),
    ).rejects.toThrow(/does not match the current project execution/i);
    expect((await store.findTask(created.tasks[0]!.id))!.task.requestedAction).toBe(
      null,
    );
  });

  it("reactivates an idle project when new work is added and rejects cancelled projects", async () => {
    const created = await store.createProject({
      name: "Tiny Game",
      repositoryPath: "/workspace/game",
      defaultBranch: "main",
      productDocument: "# Tiny Game\n",
      tasks: [{ title: "Task", description: "Build", acceptanceCriteria: [] }],
    });
    await store.saveProject({ ...created.project, status: "idle" });

    const active = await addProjectWork(created.project.id, [
      { title: "Expansion", description: "Build more", acceptanceCriteria: [] },
    ]);
    expect(active.project.status).toBe("active");

    await workflow.cancelProject(created.project.id, {
      cancelledBy: "codex",
      decisionBasis: "agent_decision",
      reason: "The idle project is being retired",
    });
    await expect(
      addProjectWork(created.project.id, [
        { title: "Too late", description: "No", acceptanceCriteria: [] },
      ]),
    ).rejects.toThrow(/cancelled/i);
  });

  it("accepts a final report on the same attempt after input arrives in Codex App", async () => {
    const created = await registerProject(1);
    await finishProjectExecution({
      projectId: created.project.id,
      outcome: "selected",
      summary: "Start",
      taskIds: [created.tasks[0]!.id],
    });
    const developing = (await store.findTask(created.tasks[0]!.id))!.task;
    const execution = developing.currentExecution!;

    await workflow.submitReport({
      taskId: developing.id,
      attemptId: execution.attemptId,
      reportOpportunityId: requiredReportOpportunity(execution),
      outcome: "needs_input",
      summary: "Need a product decision",
      question: "Should it be turn based?",
    });
    const waiting = await workflow.completeTurn(
      developing.id,
      execution.attemptId,
      execution.turnId!,
    );
    expect(waiting.currentExecution).toMatchObject({
      attemptId: execution.attemptId,
      status: "waiting_for_input",
    });
    await expect(workflow.retryTask(developing.id)).rejects.toThrow(
      /still active and cannot be retried/,
    );

    await workflow.submitReport({
      taskId: developing.id,
      attemptId: execution.attemptId,
      reportOpportunityId: requiredReportOpportunity(waiting.currentExecution!),
      outcome: "completed",
      summary: "Implemented after the answer",
      workspacePath: "/workspace/game/.worktrees/task_1",
      candidateCommit: "candidate_1",
    });

    const reviewing = (await store.findTask(developing.id))!.task;
    expect(reviewing).toMatchObject({
      status: "reviewing",
      requestedAction: "review",
    });
    expect(reviewing.currentExecution?.action).toBe("review");
    const activities = await store.listTaskActivities(created.project.id, developing.id);
    expect(activities).toEqual([
      expect.objectContaining({
        type: "decision_requested",
        attemptId: execution.attemptId,
        threadId: execution.threadId,
      }),
      expect.objectContaining({
        type: "work_completed",
        attemptId: execution.attemptId,
        threadId: execution.threadId,
      }),
    ]);
  });

  it("keeps a selection decision non-blocking while a waiting task continues", async () => {
    const created = await registerProject(2);
    const taskId = created.tasks[0]!.id;
    await finishProjectExecution({
      projectId: created.project.id,
      outcome: "selected",
      summary: "Start the first task",
      taskIds: [taskId],
    });
    const developing = (await store.findTask(taskId))!.task;
    const execution = developing.currentExecution!;

    await workflow.submitReport({
      taskId,
      attemptId: execution.attemptId,
      reportOpportunityId: requiredReportOpportunity(execution),
      outcome: "needs_input",
      summary: "Need a decision",
      question: "Keep the existing files?",
    });
    const waiting = await workflow.completeTurn(
      taskId,
      execution.attemptId,
      execution.turnId!,
    );
    await addProjectWork(created.project.id, [
      {
        title: "Later task",
        description: "Added after the first selection",
        acceptanceCriteria: [],
      },
    ]);
    await finishProjectExecution({
      projectId: created.project.id,
      outcome: "needs_input",
      summary: "No other task should start yet",
      question: "Wait for the first task?",
    });

    expect((await store.getProject(created.project.id))!.project.status).toBe("active");

    await workflow.submitReport({
      taskId,
      attemptId: execution.attemptId,
      reportOpportunityId: requiredReportOpportunity(waiting.currentExecution!),
      outcome: "completed",
      summary: "Implemented after resolving the question",
      workspacePath: "/workspace/game/.worktrees/task_1",
      candidateCommit: "candidate_1",
    });

    const snapshot = (await store.getProject(created.project.id))!;
    expect(snapshot.project.status).toBe("active");
    expect(snapshot.project.currentExecution?.result).toMatchObject({
      outcome: "needs_input",
      question: "Wait for the first task?",
    });
    expect(projectExecutor.started).toHaveLength(2);
    expect(snapshot.tasks.find(({ id }) => id === taskId)).toMatchObject({
      status: "reviewing",
      requestedAction: "review",
      currentExecution: { action: "review", status: "running" },
    });
  });

  it("lets task selection wait for a task whose Codex conversation needs input", async () => {
    const created = await store.createProject({
      name: "Tiny Game",
      repositoryPath: "/workspace/game",
      defaultBranch: "main",
      productDocument: "# Tiny Game\n",
      tasks: [
        { title: "Foundation", description: "Build it", acceptanceCriteria: [] },
        { title: "Gameplay", description: "Build it next", acceptanceCriteria: [] },
      ],
    });
    await store.saveTask(created.project.id, {
      ...created.tasks[0]!,
      status: "waiting_for_input",
      requestedAction: "work",
      currentExecution: {
        attemptId: "attempt_1",
        reportOpportunityId: "report_opportunity_1",
        action: "work",
        status: "waiting_for_input",
        startedAt: "2026-08-03T00:00:00.000Z",
        modelRouting: testModelRouting(),
      },
    });

    await workflow.reconcile();
    await finishProjectExecution({
      projectId: created.project.id,
      outcome: "wait_for_active_tasks",
      summary: "The next task should wait for the foundation",
    });

    expect((await store.getProject(created.project.id))!.project).toMatchObject({
      status: "active",
      requestedAction: null,
      planning: { revision: 1, evaluatedRevision: 1 },
      currentExecution: { result: { outcome: "wait_for_active_tasks" } },
    });
  });

  it("keeps a reported blocker visible until an explicit retry", async () => {
    const created = await registerProject(2);
    await finishProjectExecution({
      projectId: created.project.id,
      outcome: "selected",
      summary: "Start both tasks",
      taskIds: created.tasks.map(({ id: selectedTaskId }) => selectedTaskId),
    });
    const developing = (await store.findTask(created.tasks[0]!.id))!.task;
    const execution = developing.currentExecution!;

    await workflow.submitReport({
      taskId: developing.id,
      attemptId: execution.attemptId,
      reportOpportunityId: requiredReportOpportunity(execution),
      outcome: "blocked",
      summary: "The required tool is unavailable",
    });
    await workflow.completeTurn(
      developing.id,
      execution.attemptId,
      execution.turnId!,
    );

    const blocked = (await store.findTask(developing.id))!.task;
    expect(blocked).toMatchObject({
      status: "blocked",
      requestedAction: "work",
    });
    expect(blocked.currentExecution).toBeUndefined();
    expect(await store.listTaskActivities(created.project.id, developing.id)).toEqual([
      expect.objectContaining({
        type: "blocked",
        summary: "The required tool is unavailable",
      }),
    ]);
    expect(taskDispatcher.started).toHaveLength(2);
    expect((await store.findTask(created.tasks[1]!.id))!.task).toMatchObject({
      status: "working",
      currentExecution: { status: "running" },
    });

    await workflow.retryTask(developing.id);
    expect((await store.findTask(developing.id))!.task).toMatchObject({
      status: "working",
      currentExecution: { status: "running" },
    });
    expect(taskDispatcher.started).toHaveLength(3);
  });

  it("releases capacity while waiting and resumes one due turn with the same identity", async () => {
    const created = await registerProject(2);
    await finishProjectExecution({
      projectId: created.project.id,
      outcome: "selected",
      summary: "Start both tasks",
      taskIds: created.tasks.map(({ id: selectedTaskId }) => selectedTaskId),
    });
    const developing = (await store.findTask(created.tasks[0]!.id))!.task;
    const execution = developing.currentExecution!;
    const resumeAt = "2026-08-03T01:00:00.000Z";

    await workflow.submitReport({
      taskId: developing.id,
      attemptId: execution.attemptId,
      reportOpportunityId: requiredReportOpportunity(execution),
      outcome: "blocked",
      summary: "Wait for the remote build",
      resumeAt,
      resumePrompt: "Check build 42 and continue from the existing worktree.",
    });
    await workflow.completeTurn(
      developing.id,
      execution.attemptId,
      execution.turnId!,
    );

    const waiting = (await store.findTask(developing.id))!.task;
    expect(waiting).toMatchObject({
      status: "blocked",
      requestedAction: "work",
      currentExecution: {
        attemptId: execution.attemptId,
        threadId: execution.threadId,
        status: "waiting_for_resume",
        modelRouting: execution.modelRouting,
        scheduledResume: { resumeAt },
      },
    });
    expect(await workflow.availableTaskSlots(created.project.id)).toBe(1);

    now = new Date(resumeAt);
    await Promise.all([
      workflow.resumeScheduledTasks(now),
      workflow.resumeScheduledTasks(now),
    ]);

    const resumed = (await store.findTask(developing.id))!.task;
    expect(resumed).toMatchObject({
      status: "working",
      requestedAction: "work",
      currentExecution: {
        attemptId: execution.attemptId,
        threadId: execution.threadId,
        status: "running",
        modelRouting: execution.modelRouting,
      },
    });
    expect(resumed.currentExecution).not.toHaveProperty("scheduledResume");
    expect(taskDispatcher.scheduledResumes).toHaveLength(1);
    expect(taskDispatcher.scheduledResumes[0]).toMatchObject({
      threadId: execution.threadId,
      resumePrompt: "Check build 42 and continue from the existing worktree.",
    });
    expect(
      await store.listTaskActivities(created.project.id, developing.id),
    ).toEqual([
      expect.objectContaining({
        type: "blocked",
        evidence: expect.objectContaining({ resumeAt }),
      }),
      expect.objectContaining({ type: "scheduled_resume_started" }),
    ]);
  });

  it.each([
    { action: "work", nextStatus: "reviewing", nextAction: "review" },
    { action: "work", nextStatus: "reviewing", nextAction: "review" },
    { action: "review", nextStatus: "integrating", nextAction: "integrate" },
    { action: "integrate", nextStatus: "done", nextAction: null },
  ] as const)(
    "accepts one idempotent current report after a scheduled $action resume",
    async ({ action, nextStatus, nextAction }) => {
      const { projectId, taskId, execution } = await startTaskAtAction(action);
      const resumeAt = "2026-08-03T01:00:00.000Z";
      const { blockedActivityId } = await waitForScheduledResume(
        taskId,
        execution,
        resumeAt,
        `Wait before ${action}`,
        `Finish ${action} after the dependency is ready.`,
      );

      now = new Date(resumeAt);
      await workflow.resumeScheduledTasks(now);
      const resumedExecution = (await store.findTask(taskId))!.task
        .currentExecution!;
      expect(resumedExecution).not.toHaveProperty("submittedActivityId");
      expect(resumedExecution.reportOpportunityId).not.toBe(
        execution.reportOpportunityId,
      );

      const completedReport = successfulReportForAction(
        action,
        taskId,
        execution.attemptId,
        requiredReportOpportunity(resumedExecution),
      );
      const reported = await workflow.submitReport(completedReport);
      const completedActivityId = reported.currentExecution!.submittedActivityId;

      expect(completedActivityId).toBeDefined();
      expect(completedActivityId).not.toBe(blockedActivityId);
      expect(
        (await store.listTaskActivities(projectId, taskId)).filter(
          ({ attemptId, outcome }) =>
            attemptId === execution.attemptId && outcome !== undefined,
        ),
      ).toEqual([
        expect.objectContaining({
          id: blockedActivityId,
          outcome: "blocked",
          reportOpportunityId: execution.reportOpportunityId,
        }),
        expect.objectContaining({
          id: completedActivityId,
          outcome: completedReport.outcome,
          reportOpportunityId: resumedExecution.reportOpportunityId,
        }),
      ]);

      await workflow.submitReport(completedReport);
      await expect(
        workflow.submitReport({
          ...completedReport,
          summary: "A conflicting result for the resumed turn",
        }),
      ).rejects.toThrow(/conflicts with the recorded result/i);

      await workflow.completeTurn(
        taskId,
        execution.attemptId,
        resumedExecution.turnId!,
      );
      const completed = (await store.findTask(taskId))!.task;
      expect(completed).toMatchObject({
        status: nextStatus,
        requestedAction: nextAction,
        ...(nextAction
          ? { currentExecution: { action: nextAction, status: "running" } }
          : {}),
      });
      const activityCount = (
        await store.listTaskActivities(projectId, taskId)
      ).length;
      await workflow.submitReport(completedReport);
      expect(await store.listTaskActivities(projectId, taskId)).toHaveLength(
        activityCount,
      );
      await expect(
        workflow.submitReport({
          ...completedReport,
          summary: "A stale correction after the report was finalized",
        }),
      ).rejects.toThrow(/conflicts with the recorded result/i);
      expect(
        (await store.listTaskActivities(projectId, taskId)).filter(
          ({ type }) => type === "execution_failed",
        ),
      ).toHaveLength(0);
    },
  );

  it("accepts needs_input after an early scheduled continuation", async () => {
    const {
      projectId,
      taskId,
      execution: originalExecution,
    } = await startTaskAtAction("work");
    const blockedReport = {
      taskId,
      attemptId: originalExecution.attemptId,
      reportOpportunityId: requiredReportOpportunity(originalExecution),
      outcome: "blocked" as const,
      summary: "Wait for a product meeting",
      resumeAt: "2026-08-03T02:00:00.000Z",
      resumePrompt: "Check the meeting result and continue.",
    };
    const { blockedActivityId } = await waitForScheduledResume(
      taskId,
      originalExecution,
      blockedReport.resumeAt,
      blockedReport.summary,
      blockedReport.resumePrompt,
    );
    const decisionReport = {
      taskId,
      attemptId: originalExecution.attemptId,
      reportOpportunityId: requiredReportOpportunity(originalExecution),
      outcome: "needs_input" as const,
      summary: "The meeting exposed one product choice",
      question: "Should the task keep the temporary mode?",
    };
    await expect(workflow.submitReport(decisionReport)).rejects.toThrow(
      /conflicts with the recorded result/i,
    );
    await expect(
      workflow.submitReport({ ...decisionReport, attemptId: "wrong_attempt" }),
    ).rejects.toThrow(/does not match the current execution/i);

    await workflow.continueTaskNow(taskId);
    const resumedExecution = (await store.findTask(taskId))!.task.currentExecution!;
    expect(resumedExecution.turnId).not.toBe(originalExecution.turnId);

    const resumedDecisionReport = {
      ...decisionReport,
      reportOpportunityId: requiredReportOpportunity(resumedExecution),
    };
    const reported = await workflow.submitReport(resumedDecisionReport);
    const decisionActivityId = reported.currentExecution!.submittedActivityId;
    await expect(workflow.submitReport(blockedReport)).rejects.toThrow(
      /report opportunity/i,
    );

    await workflow.completeTurn(
      taskId,
      originalExecution.attemptId,
      originalExecution.turnId!,
    );
    expect((await store.findTask(taskId))!.task.currentExecution?.turnId).toBe(
      resumedExecution.turnId,
    );

    const waitingForInput = await workflow.completeTurn(
      taskId,
      originalExecution.attemptId,
      resumedExecution.turnId!,
    );
    expect(waitingForInput).toMatchObject({
      status: "waiting_for_input",
      requestedAction: "work",
      currentExecution: {
        attemptId: originalExecution.attemptId,
        status: "waiting_for_input",
        submittedActivityId: decisionActivityId,
      },
    });
    expect(waitingForInput.currentExecution?.reportOpportunityId).not.toBe(
      resumedExecution.reportOpportunityId,
    );
    const reportActivities = (
      await store.listTaskActivities(projectId, taskId)
    ).filter(
      ({ attemptId, outcome }) =>
        attemptId === originalExecution.attemptId && outcome !== undefined,
    );
    expect(reportActivities).toHaveLength(2);
    expect(reportActivities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: blockedActivityId, outcome: "blocked" }),
        expect.objectContaining({
          id: decisionActivityId,
          outcome: "needs_input",
          reportOpportunityId: resumedExecution.reportOpportunityId,
        }),
      ]),
    );
  });

  it("rejects a stale report before the early resumed turn submits its result", async () => {
    const { projectId, taskId, execution: originalExecution } =
      await startTaskAtAction("work");
    const originalOpportunityId =
      (
        originalExecution as typeof originalExecution & {
          reportOpportunityId?: string;
        }
      ).reportOpportunityId ?? "missing_original_opportunity";
    const blockedReport = {
      taskId,
      attemptId: originalExecution.attemptId,
      reportOpportunityId: originalOpportunityId,
      outcome: "blocked" as const,
      summary: "Wait for the deployment",
      resumeAt: "2026-08-03T02:00:00.000Z",
      resumePrompt: "Inspect the deployment and continue.",
    };

    await workflow.submitReport(blockedReport);
    await workflow.completeTurn(
      taskId,
      originalExecution.attemptId,
      originalExecution.turnId!,
    );
    await workflow.continueTaskNow(taskId);
    const resumedExecution = (await store.findTask(taskId))!.task.currentExecution!;
    const activityCount = (
      await store.listTaskActivities(projectId, taskId)
    ).length;

    await expect(workflow.submitReport(blockedReport)).rejects.toThrow(
      /report opportunity/i,
    );
    expect(await store.listTaskActivities(projectId, taskId)).toHaveLength(
      activityCount,
    );
    expect(
      (
        resumedExecution as typeof resumedExecution & {
          reportOpportunityId?: string;
        }
      ).reportOpportunityId,
    ).not.toBe(originalOpportunityId);
  });

  it("requires the current opportunity for a new execution report", async () => {
    const { projectId, taskId, execution } = await startTaskAtAction("work");
    const report = {
      taskId,
      attemptId: execution.attemptId,
      outcome: "completed" as const,
      summary: "Implemented",
      workspacePath: "/workspace/game/.worktrees/task_1",
      candidateCommit: "candidate_1",
    };

    await expect(
      workflow.submitReport(report as unknown as TaskReport),
    ).rejects.toThrow(
      /report opportunity/i,
    );
    await expect(
      workflow.submitReport({
        ...report,
        reportOpportunityId: "report_opportunity_from_another_turn",
      }),
    ).rejects.toThrow(/report opportunity/i);
    expect(
      (await store.listTaskActivities(projectId, taskId)).filter(
        ({ outcome }) => outcome !== undefined,
      ),
    ).toHaveLength(0);
  });

  it("rejects a persisted execution that lacks the current report identity", async () => {
    const { projectId, taskId, execution } = await startTaskAtAction("work");
    const found = (await store.findTask(taskId))!.task;
    const { reportOpportunityId: _reportOpportunityId, ...invalidExecution } =
      found.currentExecution!;
    await store.saveTask(projectId, {
      ...found,
      currentExecution:
        invalidExecution as unknown as NonNullable<Task["currentExecution"]>,
    });
    const report = {
      taskId,
      attemptId: execution.attemptId,
      outcome: "completed" as const,
      summary: "Implemented without a current report identity",
      workspacePath: "/workspace/game/.worktrees/task_1",
      candidateCommit: "candidate_without_identity",
    };

    await expect(
      workflow.submitReport(report as unknown as TaskReport),
    ).rejects.toThrow(
      /report opportunity/i,
    );
    expect(
      await store.listTaskActivities(projectId, taskId)
    ).toHaveLength(0);
  });

  it("accepts a new planned blocker after a rescheduled wait resumes", async () => {
    const { projectId, taskId, execution } = await startTaskAtAction("work");
    const { blockedActivityId: firstBlockedActivityId } =
      await waitForScheduledResume(
        taskId,
        execution,
        "2026-08-03T01:00:00.000Z",
        "Wait for the first deployment",
        "Inspect the first deployment.",
      );

    await workflow.rescheduleTaskResume(taskId, "2026-08-03T02:00:00.000Z");
    now = new Date("2026-08-03T02:00:00.000Z");
    await workflow.resumeScheduledTasks(now);
    const resumedExecution = (await store.findTask(taskId))!.task.currentExecution!;

    const waitingAgain = await workflow.submitReport({
      taskId,
      attemptId: execution.attemptId,
      reportOpportunityId: requiredReportOpportunity(resumedExecution),
      outcome: "blocked",
      summary: "Wait for the follow-up deployment",
      resumeAt: "2026-08-03T03:00:00.000Z",
      resumePrompt: "Inspect the follow-up deployment.",
    });
    const secondBlockedActivityId = waitingAgain.currentExecution!.submittedActivityId;
    await workflow.completeTurn(
      taskId,
      execution.attemptId,
      resumedExecution.turnId!,
    );

    expect((await store.findTask(taskId))!.task).toMatchObject({
      status: "blocked",
      requestedAction: "work",
      currentExecution: {
        attemptId: execution.attemptId,
        status: "waiting_for_resume",
        submittedActivityId: secondBlockedActivityId,
        scheduledResume: { resumeAt: "2026-08-03T03:00:00.000Z" },
      },
    });
    expect(
      (await store.listTaskActivities(projectId, taskId)).filter(
        ({ attemptId, outcome }) =>
          attemptId === execution.attemptId && outcome !== undefined,
      ),
    ).toEqual([
      expect.objectContaining({
        id: firstBlockedActivityId,
        outcome: "blocked",
      }),
      expect.objectContaining({
        id: secondBlockedActivityId,
        outcome: "blocked",
      }),
    ]);
  });

  it("clears a planned resume when its turn cannot be dispatched", async () => {
    const created = await registerProject(1);
    await finishProjectExecution({
      projectId: created.project.id,
      outcome: "selected",
      summary: "Start the task",
      taskIds: [created.tasks[0]!.id],
    });
    const taskId = created.tasks[0]!.id;
    const execution = (await store.findTask(taskId))!.task.currentExecution!;

    await workflow.submitReport({
      taskId,
      attemptId: execution.attemptId,
      reportOpportunityId: requiredReportOpportunity(execution),
      outcome: "blocked",
      summary: "Wait for the remote build",
      resumeAt: "2026-08-03T01:00:00.000Z",
      resumePrompt: "Inspect the remote build and continue.",
    });
    await workflow.completeTurn(taskId, execution.attemptId, execution.turnId!);
    taskDispatcher.beforeResumeScheduledTurn = async () => {
      throw new Error("Codex scheduled turn failed to start");
    };

    now = new Date("2026-08-03T01:00:00.000Z");
    await workflow.resumeScheduledTasks(now);

    const failed = (await store.findTask(taskId))!.task;
    expect(failed).toMatchObject({
      status: "blocked",
      requestedAction: "work",
      currentExecution: {
        attemptId: execution.attemptId,
        status: "failed",
      },
    });
    expect(failed.currentExecution).not.toHaveProperty("scheduledResume");
    await expect(
      workflow.submitReport({
        taskId,
        attemptId: execution.attemptId,
        reportOpportunityId: requiredReportOpportunity(failed.currentExecution!),
        outcome: "completed",
        summary: "This failed execution cannot report",
        workspacePath: "/workspace/game/.worktrees/task_1",
        candidateCommit: "candidate_after_failed_resume",
      }),
    ).rejects.toThrow(/does not match the current execution/i);
  });

  it("uses an expired fallback cooldown for a scheduled primary probe", async () => {
    const created = await registerProject(1);
    await finishProjectExecution({
      projectId: created.project.id,
      outcome: "selected",
      summary: "Start the task",
      taskIds: [created.tasks[0]!.id],
    });
    const taskId = created.tasks[0]!.id;
    const execution = (await store.findTask(taskId))!.task.currentExecution!;

    await workflow.submitReport({
      taskId,
      attemptId: execution.attemptId,
      reportOpportunityId: requiredReportOpportunity(execution),
      outcome: "blocked",
      summary: "Wait beyond the primary cooldown",
      resumeAt: "2026-08-03T01:00:00.000Z",
      resumePrompt: "Recheck the blocker and continue.",
    });
    await workflow.completeTurn(taskId, execution.attemptId, execution.turnId!);
    const waiting = (await store.findTask(taskId))!.task;
    await store.saveTask(created.project.id, {
      ...waiting,
      currentExecution: {
        ...waiting.currentExecution!,
        modelRouting: {
          model: models.fallback,
          route: "fallback",
          retryCount: 2,
          circuitBreaker: {
            state: "open",
            primaryProbeAt: "2026-08-03T00:30:00.000Z",
          },
        },
      },
    });
    taskDispatcher.beforeResumeScheduledTurn = async (request) => {
      expect(request.task.currentExecution?.modelRouting).toMatchObject({
        model: models.primary,
        route: "primary",
        circuitBreaker: { state: "half_open", fallbackRetryCount: 2 },
      });
      expect(
        (await store.findTask(taskId))!.task.currentExecution?.modelRouting,
      ).toEqual(request.task.currentExecution?.modelRouting);
    };

    now = new Date("2026-08-03T01:00:00.000Z");
    await workflow.resumeScheduledTasks(now);

    const probe = (await store.findTask(taskId))!.task.currentExecution!;
    expect(probe).toMatchObject({
      attemptId: execution.attemptId,
      status: "running",
      modelRouting: {
        model: models.primary,
        route: "primary",
        retryCount: 0,
        circuitBreaker: {
          state: "half_open",
          fallbackRetryCount: 2,
          probeStartedAt: now.toISOString(),
        },
      },
    });
    expect(taskDispatcher.scheduledResumes.at(-1)?.model).toBe(models.primary);

    await workflow.failTurn(
      taskId,
      probe.attemptId,
      capacityFailure(probe.turnId!),
    );

    expect((await store.findTask(taskId))!.task.currentExecution).toMatchObject({
      attemptId: execution.attemptId,
      status: "running",
      modelRouting: {
        model: models.fallback,
        route: "fallback",
        retryCount: 2,
        circuitBreaker: {
          state: "open",
          primaryProbeAt: new Date(now.getTime() + 5 * 60_000).toISOString(),
        },
      },
    });
    expect(taskDispatcher.started.at(-1)?.model).toBe(models.fallback);
  });

  it("keeps a due planned blocker paused and resumes it after the project continues", async () => {
    const created = await registerProject(1);
    await finishProjectExecution({
      projectId: created.project.id,
      outcome: "selected",
      summary: "Start the task",
      taskIds: [created.tasks[0]!.id],
    });
    const developing = (await store.findTask(created.tasks[0]!.id))!.task;
    const execution = developing.currentExecution!;

    await workflow.submitReport({
      taskId: developing.id,
      attemptId: execution.attemptId,
      reportOpportunityId: requiredReportOpportunity(execution),
      outcome: "blocked",
      summary: "Wait briefly",
      resumeAt: "2026-08-03T00:05:00.000Z",
      resumePrompt: "Recheck the result and continue.",
    });
    await workflow.completeTurn(developing.id, execution.attemptId, execution.turnId!);
    await workflow.controlProject(created.project.id, "pause");
    now = new Date("2026-08-03T00:06:00.000Z");

    await workflow.resumeScheduledTasks(now);
    expect(taskDispatcher.scheduledResumes).toHaveLength(0);

    await workflow.controlProject(created.project.id, "resume");
    expect(taskDispatcher.scheduledResumes).toHaveLength(1);
    expect((await store.findTask(developing.id))!.task.currentExecution).toMatchObject({
      attemptId: execution.attemptId,
      status: "running",
    });
  });

  it("reschedules or continues a planned blocker without replacing its execution", async () => {
    const created = await registerProject(1);
    await finishProjectExecution({
      projectId: created.project.id,
      outcome: "selected",
      summary: "Start the task",
      taskIds: [created.tasks[0]!.id],
    });
    const developing = (await store.findTask(created.tasks[0]!.id))!.task;
    const execution = developing.currentExecution!;

    await workflow.submitReport({
      taskId: developing.id,
      attemptId: execution.attemptId,
      reportOpportunityId: requiredReportOpportunity(execution),
      outcome: "blocked",
      summary: "Wait for a delivery",
      resumeAt: "2026-08-03T02:00:00.000Z",
      resumePrompt: "Inspect the delivery and continue.",
    });
    await workflow.completeTurn(developing.id, execution.attemptId, execution.turnId!);

    await workflow.rescheduleTaskResume(
      developing.id,
      "2026-08-03T03:00:00.000Z",
    );
    expect((await store.findTask(developing.id))!.task.currentExecution).toMatchObject({
      attemptId: execution.attemptId,
      scheduledResume: { resumeAt: "2026-08-03T03:00:00.000Z" },
    });

    await workflow.continueTaskNow(developing.id);
    expect(taskDispatcher.scheduledResumes).toHaveLength(1);
    expect((await store.findTask(developing.id))!.task.currentExecution).toMatchObject({
      attemptId: execution.attemptId,
      status: "running",
    });
  });

  it("serializes cancellation and rescheduling before concurrent due wakeups", async () => {
    const created = await registerProject(2);
    await finishProjectExecution({
      projectId: created.project.id,
      outcome: "selected",
      summary: "Start both tasks",
      taskIds: created.tasks.map(({ id: taskId }) => taskId),
    });
    const executions = await Promise.all(
      created.tasks.map(async ({ id: taskId }) =>
        (await store.findTask(taskId))!.task.currentExecution!,
      ),
    );
    for (const [index, task] of created.tasks.entries()) {
      await workflow.submitReport({
        taskId: task.id,
        attemptId: executions[index]!.attemptId,
        reportOpportunityId: requiredReportOpportunity(executions[index]!),
        outcome: "blocked",
        summary: `Wait ${index}`,
        resumeAt:
          index === 0
            ? "2026-08-03T00:05:00.000Z"
            : "2026-08-03T00:10:00.000Z",
        resumePrompt: `Recheck wait ${index} and continue.`,
      });
      await workflow.completeTurn(
        task.id,
        executions[index]!.attemptId,
        executions[index]!.turnId!,
      );
    }

    now = new Date("2026-08-03T00:05:00.000Z");
    await Promise.all([
      workflow.cancelTask(created.tasks[0]!.id, {
        cancelledBy: "codex",
        decisionBasis: "agent_decision",
        reason: "The scheduled work is no longer required",
      }),
      workflow.resumeScheduledTasks(now),
    ]);
    expect((await store.findTask(created.tasks[0]!.id))!.task.status).toBe(
      "cancelled",
    );
    expect(
      (await store.findTask(created.tasks[0]!.id))!.task.currentExecution,
    ).not.toHaveProperty("scheduledResume");
    expect(taskDispatcher.scheduledResumes).toHaveLength(0);

    now = new Date("2026-08-03T00:10:00.000Z");
    await Promise.all([
      workflow.rescheduleTaskResume(
        created.tasks[1]!.id,
        "2026-08-03T00:20:00.000Z",
      ),
      workflow.resumeScheduledTasks(now),
      workflow.resumeScheduledTasks(now),
    ]);
    expect((await store.findTask(created.tasks[1]!.id))!.task.currentExecution)
      .toMatchObject({
        attemptId: executions[1]!.attemptId,
        status: "waiting_for_resume",
        scheduledResume: { resumeAt: "2026-08-03T00:20:00.000Z" },
      });
    expect(taskDispatcher.scheduledResumes).toHaveLength(0);
  });

  it("retries failed project execution independently from scheduling resume", async () => {
    const created = await registerProject(1);
    const firstExecution = created.project.currentExecution!;

    await workflow.failProjectTurn(
      created.project.id,
      firstExecution.attemptId,
      {
        turnId: firstExecution.turnId!,
        message: "Planner process failed",
      },
    );
    const resumed = await workflow.controlProject(created.project.id, "resume");

    expect(resumed).toMatchObject({
      status: "active",
      scheduling: "running",
      requestedAction: "select_tasks",
      currentExecution: { status: "failed" },
      planning: { revision: 1, evaluatedRevision: 1 },
    });
    expect(projectExecutor.started).toHaveLength(1);

    const retried = await workflow.retryProject(created.project.id);
    expect(retried).toMatchObject({
      status: "active",
      requestedAction: "select_tasks",
      currentExecution: { status: "running" },
    });
    expect(retried.currentExecution?.attemptId).not.toBe(firstExecution.attemptId);
    expect(projectExecutor.started).toHaveLength(2);
  });

  it("keeps project planning active while a capacity failure waits to retry", async () => {
    const created = await registerProject(1);
    const execution = created.project.currentExecution!;

    await workflow.failProjectTurn(created.project.id, execution.attemptId, {
      turnId: execution.turnId!,
      message: "Selected model is at capacity. Please try a different model.",
      codexErrorInfo: "serverOverloaded",
    });

    const scheduled = (await store.getProject(created.project.id))!.project;
    expect(scheduled).toMatchObject({
      status: "active",
      requestedAction: "select_tasks",
      planning: { revision: 1 },
      currentExecution: {
        attemptId: execution.attemptId,
        status: "retry_scheduled",
        modelRouting: {
          model: models.primary,
          route: "primary",
          retryCount: 1,
        },
      },
    });
    expect(scheduled.planning.evaluatedRevision).toBeUndefined();

    now = new Date(now.getTime() + 5_000);
    await workflow.retryScheduledExecutions(now);
    expect((await store.getProject(created.project.id))!.project).toMatchObject({
      status: "active",
      currentExecution: {
        attemptId: execution.attemptId,
        status: "running",
        modelRouting: { model: models.primary, retryCount: 1 },
      },
    });
    expect(projectExecutor.started).toHaveLength(2);
  });

  it("starts a new project capacity failure window after a stable turn", async () => {
    const created = await registerProject(1);
    let execution = created.project.currentExecution!;
    await workflow.failProjectTurn(
      created.project.id,
      execution.attemptId,
      capacityFailure(execution.turnId!),
    );
    now = new Date(now.getTime() + 5_000);
    await workflow.retryScheduledExecutions(now);

    execution = (await store.getProject(created.project.id))!.project.currentExecution!;
    now = new Date(now.getTime() + 5 * 60_000);
    await workflow.failProjectTurn(
      created.project.id,
      execution.attemptId,
      capacityFailure(execution.turnId!),
    );

    expect(
      (await store.getProject(created.project.id))!.project.currentExecution,
    ).toMatchObject({
      status: "retry_scheduled",
      attemptId: execution.attemptId,
      threadId: execution.threadId,
      modelRouting: {
        model: models.primary,
        route: "primary",
        retryCount: 1,
        nextRetryAt: new Date(now.getTime() + 5_000).toISOString(),
      },
    });
  });

  it("persists a cleared retry count after a project turn stays stable", async () => {
    const created = await registerProject(1);
    let execution = created.project.currentExecution!;
    await workflow.failProjectTurn(
      created.project.id,
      execution.attemptId,
      capacityFailure(execution.turnId!),
    );
    now = new Date(now.getTime() + 5_000);
    await workflow.retryScheduledExecutions(now);

    now = new Date(now.getTime() + 5 * 60_000);
    await workflow.resetStableModelCapacityFailures(now);

    execution = (await store.getProject(created.project.id))!.project.currentExecution!;
    expect(execution).toMatchObject({
      status: "running",
      modelRouting: {
        model: models.primary,
        route: "primary",
        retryCount: 0,
      },
    });
  });

  it("probes the primary model on a project report turn after fallback cooldown", async () => {
    const created = await registerProject(1);

    for (const delay of [5_000, 10_000, 20_000]) {
      const running = (await store.getProject(created.project.id))!.project
        .currentExecution!;
      await workflow.failProjectTurn(
        created.project.id,
        running.attemptId,
        capacityFailure(running.turnId!),
      );
      now = new Date(now.getTime() + delay);
      await workflow.retryScheduledExecutions(now);
    }
    const exhaustedPrimary = (await store.getProject(created.project.id))!.project
      .currentExecution!;
    await workflow.failProjectTurn(
      created.project.id,
      exhaustedPrimary.attemptId,
      capacityFailure(exhaustedPrimary.turnId!),
    );

    const fallbackProject = (await store.getProject(created.project.id))!.project;
    const fallback = fallbackProject.currentExecution!;
    now = new Date(Date.parse(projectPrimaryProbeAt(fallbackProject)));
    await workflow.completeProjectTurn(
      created.project.id,
      fallback.attemptId,
      fallback.turnId!,
    );

    expect(
      (await store.getProject(created.project.id))!.project.currentExecution,
    ).toMatchObject({
      status: "awaiting_report",
      attemptId: fallback.attemptId,
      threadId: fallback.threadId,
      modelRouting: {
        model: models.primary,
        route: "primary",
        retryCount: 0,
        circuitBreaker: { state: "half_open", fallbackRetryCount: 0 },
      },
    });
    expect(
      projectExecutor.reminders.at(-1)?.project.currentExecution?.modelRouting.model,
    ).toBe(models.primary);
  });

  it("carries an open primary circuit into the next project planning revision", async () => {
    const created = await registerProject(1);

    for (const delay of [5_000, 10_000, 20_000]) {
      const running = (await store.getProject(created.project.id))!.project
        .currentExecution!;
      await workflow.failProjectTurn(
        created.project.id,
        running.attemptId,
        capacityFailure(running.turnId!),
      );
      now = new Date(now.getTime() + delay);
      await workflow.retryScheduledExecutions(now);
    }
    const exhaustedPrimary = (await store.getProject(created.project.id))!.project
      .currentExecution!;
    await workflow.failProjectTurn(
      created.project.id,
      exhaustedPrimary.attemptId,
      capacityFailure(exhaustedPrimary.turnId!),
    );
    const fallbackProject = (await store.getProject(created.project.id))!.project;
    const probeAt = projectPrimaryProbeAt(fallbackProject);

    await finishProjectExecution({
      projectId: created.project.id,
      outcome: "selected",
      summary: "Start the first task",
      taskIds: [created.tasks[0]!.id],
    });
    await addProjectWork(created.project.id, [
      { title: "Follow-up", description: "Build follow-up", acceptanceCriteria: [] },
    ]);

    expect((await store.getProject(created.project.id))!.project).toMatchObject({
      requestedAction: "select_tasks",
      currentExecution: {
        status: "running",
        modelRouting: {
          model: models.fallback,
          route: "fallback",
          retryCount: 0,
          circuitBreaker: { state: "open", primaryProbeAt: probeAt },
        },
      },
    });
    expect(
      projectExecutor.started.at(-1)?.project.currentExecution?.modelRouting.model,
    ).toBe(models.fallback);
  });

  it("retries model capacity failures three times before routing the same task attempt to the fallback model", async () => {
    const created = await registerProject(1);
    await finishProjectExecution({
      projectId: created.project.id,
      outcome: "selected",
      summary: "Start the task",
      taskIds: [created.tasks[0]!.id],
    });
    const taskId = created.tasks[0]!.id;
    const first = (await store.findTask(taskId))!.task.currentExecution!;

    expect(first).toMatchObject({
      modelRouting: {
        model: models.primary,
        route: "primary",
        retryCount: 0,
      },
    });

    for (const [index, delay] of [5_000, 10_000, 20_000].entries()) {
      const running = (await store.findTask(taskId))!.task.currentExecution!;
      await workflow.failTurn(taskId, running.attemptId, {
        turnId: running.turnId!,
        message: "Selected model is at capacity. Please try a different model.",
        codexErrorInfo: "serverOverloaded",
      });

      const scheduled = (await store.findTask(taskId))!.task;
      expect(scheduled).toMatchObject({
        status: "working",
        currentExecution: {
          attemptId: first.attemptId,
          reportOpportunityId: first.reportOpportunityId,
          threadId: first.threadId,
          status: "retry_scheduled",
          modelRouting: {
            model: models.primary,
            route: "primary",
            retryCount: index + 1,
            lastError: {
              kind: "model_capacity",
              message: "Selected model is at capacity. Please try a different model.",
            },
          },
        },
      });
      expect(Date.parse(scheduled.currentExecution!.modelRouting.nextRetryAt!)).toBe(
        now.getTime() + delay,
      );

      now = new Date(now.getTime() + delay);
      await workflow.retryScheduledExecutions(now);
      expect((await store.findTask(taskId))!.task.currentExecution).toMatchObject({
        attemptId: first.attemptId,
        reportOpportunityId: first.reportOpportunityId,
        status: "running",
        modelRouting: {
          model: models.primary,
          route: "primary",
          retryCount: index + 1,
        },
      });
    }

    const finalPrimary = (await store.findTask(taskId))!.task.currentExecution!;
    const circuitOpenedAt = now;
    await workflow.failTurn(taskId, finalPrimary.attemptId, {
      turnId: finalPrimary.turnId!,
      message: "Selected model is at capacity. Please try a different model.",
      codexErrorInfo: "serverOverloaded",
    });

    expect((await store.findTask(taskId))!.task).toMatchObject({
      status: "working",
      currentExecution: {
        attemptId: first.attemptId,
        reportOpportunityId: first.reportOpportunityId,
        threadId: first.threadId,
        status: "running",
        modelRouting: {
          model: models.fallback,
          route: "fallback",
          retryCount: 0,
          circuitBreaker: {
            state: "open",
            primaryProbeAt: new Date(
              circuitOpenedAt.getTime() + 5 * 60_000,
            ).toISOString(),
          },
        },
      },
    });
    expect(taskDispatcher.started).toHaveLength(5);
    expect(taskDispatcher.started.at(-1)?.model).toBe(models.fallback);
  });

  it("keeps counting capacity failures when the latest turn is shorter than the stable window", async () => {
    const created = await registerProject(1);
    await finishProjectExecution({
      projectId: created.project.id,
      outcome: "selected",
      summary: "Start the task",
      taskIds: [created.tasks[0]!.id],
    });
    const taskId = created.tasks[0]!.id;

    await failCapacityAndStartRetry(taskId, 5_000);
    await failCapacityAndStartRetry(taskId, 10_000);
    now = new Date(now.getTime() + 5 * 60_000 - 1);
    const running = (await store.findTask(taskId))!.task.currentExecution!;
    await workflow.failTurn(taskId, running.attemptId, capacityFailure(running.turnId!));

    expect((await store.findTask(taskId))!.task.currentExecution).toMatchObject({
      status: "retry_scheduled",
      modelRouting: {
        model: models.primary,
        route: "primary",
        retryCount: 3,
      },
    });
  });

  it("starts a new capacity failure window after the latest turn stays stable", async () => {
    const created = await registerProject(1);
    await finishProjectExecution({
      projectId: created.project.id,
      outcome: "selected",
      summary: "Start the task",
      taskIds: [created.tasks[0]!.id],
    });
    const taskId = created.tasks[0]!.id;

    await failCapacityAndStartRetry(taskId, 5_000);
    await failCapacityAndStartRetry(taskId, 10_000);
    now = new Date(now.getTime() + 5 * 60_000);
    const running = (await store.findTask(taskId))!.task.currentExecution!;
    await workflow.failTurn(taskId, running.attemptId, capacityFailure(running.turnId!));

    expect((await store.findTask(taskId))!.task.currentExecution).toMatchObject({
      status: "retry_scheduled",
      attemptId: running.attemptId,
      threadId: running.threadId,
      modelRouting: {
        model: models.primary,
        route: "primary",
        retryCount: 1,
        nextRetryAt: new Date(now.getTime() + 5_000).toISOString(),
      },
    });
  });

  it("persists a cleared retry count after a task turn stays stable", async () => {
    const created = await registerProject(1);
    await finishProjectExecution({
      projectId: created.project.id,
      outcome: "selected",
      summary: "Start the task",
      taskIds: [created.tasks[0]!.id],
    });
    const taskId = created.tasks[0]!.id;
    await failCapacityAndStartRetry(taskId, 5_000);

    now = new Date(now.getTime() + 5 * 60_000);
    await workflow.resetStableModelCapacityFailures(now);

    expect((await store.findTask(taskId))!.task.currentExecution).toMatchObject({
      status: "running",
      modelRouting: {
        model: models.primary,
        route: "primary",
        retryCount: 0,
      },
    });
  });

  it("does not clear capacity failures while their retry is still scheduled", async () => {
    const created = await registerProject(1);
    await finishProjectExecution({
      projectId: created.project.id,
      outcome: "selected",
      summary: "Start the task",
      taskIds: [created.tasks[0]!.id],
    });
    const taskId = created.tasks[0]!.id;
    const running = (await store.findTask(taskId))!.task.currentExecution!;
    await workflow.failTurn(taskId, running.attemptId, capacityFailure(running.turnId!));

    now = new Date(now.getTime() + 5 * 60_000);
    await workflow.resetStableModelCapacityFailures(now);

    expect((await store.findTask(taskId))!.task.currentExecution).toMatchObject({
      status: "retry_scheduled",
      modelRouting: {
        model: models.primary,
        route: "primary",
        retryCount: 1,
      },
    });
  });

  it("keeps an active fallback turn running when the primary probe cooldown expires", async () => {
    const created = await registerProject(1);
    await finishProjectExecution({
      projectId: created.project.id,
      outcome: "selected",
      summary: "Start the task",
      taskIds: [created.tasks[0]!.id],
    });
    const taskId = created.tasks[0]!.id;

    for (const delay of [5_000, 10_000, 20_000]) {
      await failCapacityAndStartRetry(taskId, delay);
    }
    const exhaustedPrimary = (await store.findTask(taskId))!.task.currentExecution!;
    await workflow.failTurn(
      taskId,
      exhaustedPrimary.attemptId,
      capacityFailure(exhaustedPrimary.turnId!),
    );
    now = new Date(now.getTime() + 5 * 60_000);
    await workflow.resetStableModelCapacityFailures(now);

    expect((await store.findTask(taskId))!.task.currentExecution).toMatchObject({
      status: "running",
      attemptId: exhaustedPrimary.attemptId,
      threadId: exhaustedPrimary.threadId,
      modelRouting: {
        model: models.fallback,
        route: "fallback",
        retryCount: 0,
        circuitBreaker: {
          state: "open",
          primaryProbeAt: now.toISOString(),
        },
      },
    });
    expect(taskDispatcher.started).toHaveLength(5);
  });

  it("probes the primary model on the next natural turn after fallback cooldown", async () => {
    const created = await registerProject(1);
    await finishProjectExecution({
      projectId: created.project.id,
      outcome: "selected",
      summary: "Start the task",
      taskIds: [created.tasks[0]!.id],
    });
    const taskId = created.tasks[0]!.id;

    for (const delay of [5_000, 10_000, 20_000]) {
      await failCapacityAndStartRetry(taskId, delay);
    }
    const exhaustedPrimary = (await store.findTask(taskId))!.task.currentExecution!;
    await workflow.failTurn(
      taskId,
      exhaustedPrimary.attemptId,
      capacityFailure(exhaustedPrimary.turnId!),
    );

    const fallback = (await store.findTask(taskId))!.task.currentExecution!;
    now = new Date(Date.parse(primaryProbeAt((await store.findTask(taskId))!.task)));
    await workflow.completeTurn(taskId, fallback.attemptId, fallback.turnId!);

    expect((await store.findTask(taskId))!.task.currentExecution).toMatchObject({
      status: "awaiting_report",
      attemptId: fallback.attemptId,
      threadId: fallback.threadId,
      modelRouting: {
        model: models.primary,
        route: "primary",
        retryCount: 0,
        circuitBreaker: { state: "half_open", fallbackRetryCount: 0 },
      },
    });
    expect(taskDispatcher.reminders.at(-1)?.model).toBe(models.primary);
  });

  it("carries an open primary circuit into the next task stage", async () => {
    const created = await registerProject(1);
    await finishProjectExecution({
      projectId: created.project.id,
      outcome: "selected",
      summary: "Start the task",
      taskIds: [created.tasks[0]!.id],
    });
    const taskId = created.tasks[0]!.id;

    for (const delay of [5_000, 10_000, 20_000]) {
      await failCapacityAndStartRetry(taskId, delay);
    }
    const exhaustedPrimary = (await store.findTask(taskId))!.task.currentExecution!;
    await workflow.failTurn(
      taskId,
      exhaustedPrimary.attemptId,
      capacityFailure(exhaustedPrimary.turnId!),
    );
    const fallbackTask = (await store.findTask(taskId))!.task;
    const fallback = fallbackTask.currentExecution!;
    const probeAt = primaryProbeAt(fallbackTask);

    await workflow.submitReport({
      taskId,
      attemptId: fallback.attemptId,
      reportOpportunityId: requiredReportOpportunity(fallback),
      outcome: "completed",
      summary: "Development completed on fallback",
      workspacePath: "/workspace/game/.worktrees/task",
      candidateCommit: "candidate_fallback",
    });
    await workflow.completeTurn(taskId, fallback.attemptId, fallback.turnId!);

    expect((await store.findTask(taskId))!.task).toMatchObject({
      status: "reviewing",
      requestedAction: "review",
      currentExecution: {
        action: "review",
        status: "running",
        modelRouting: {
          model: models.fallback,
          route: "fallback",
          retryCount: 0,
          circuitBreaker: { state: "open", primaryProbeAt: probeAt },
        },
      },
    });
    expect(taskDispatcher.started.at(-1)?.model).toBe(models.fallback);
  });

  it("reopens the circuit immediately when a primary probe reaches capacity", async () => {
    const created = await registerProject(1);
    await finishProjectExecution({
      projectId: created.project.id,
      outcome: "selected",
      summary: "Start the task",
      taskIds: [created.tasks[0]!.id],
    });
    const taskId = created.tasks[0]!.id;

    for (const delay of [5_000, 10_000, 20_000]) {
      await failCapacityAndStartRetry(taskId, delay);
    }
    const exhaustedPrimary = (await store.findTask(taskId))!.task.currentExecution!;
    await workflow.failTurn(
      taskId,
      exhaustedPrimary.attemptId,
      capacityFailure(exhaustedPrimary.turnId!),
    );
    const fallback = (await store.findTask(taskId))!.task.currentExecution!;
    await workflow.failTurn(
      taskId,
      fallback.attemptId,
      capacityFailure(fallback.turnId!),
    );

    const scheduledFallback = (await store.findTask(taskId))!.task.currentExecution!;
    now = new Date(Date.parse(primaryProbeAt((await store.findTask(taskId))!.task)));
    await workflow.retryScheduledExecutions(now);
    const probe = (await store.findTask(taskId))!.task.currentExecution!;
    expect(probe.modelRouting).toMatchObject({
      model: models.primary,
      route: "primary",
      retryCount: 0,
      circuitBreaker: { state: "half_open", fallbackRetryCount: 1 },
    });

    await workflow.failTurn(
      taskId,
      probe.attemptId,
      capacityFailure(probe.turnId!),
    );

    expect((await store.findTask(taskId))!.task.currentExecution).toMatchObject({
      status: "running",
      attemptId: probe.attemptId,
      threadId: probe.threadId,
      modelRouting: {
        model: models.fallback,
        route: "fallback",
        retryCount: 1,
        circuitBreaker: {
          state: "open",
          primaryProbeAt: new Date(now.getTime() + 5 * 60_000).toISOString(),
        },
      },
    });
    expect(taskDispatcher.started.slice(-2).map(({ model }) => model)).toEqual([
      models.primary,
      models.fallback,
    ]);
  });

  it("keeps the fallback failure budget when a probe follows a scheduled fallback retry", async () => {
    const created = await registerProject(1);
    await finishProjectExecution({
      projectId: created.project.id,
      outcome: "selected",
      summary: "Start the task",
      taskIds: [created.tasks[0]!.id],
    });
    const taskId = created.tasks[0]!.id;

    for (const delay of [5_000, 10_000, 20_000]) {
      await failCapacityAndStartRetry(taskId, delay);
    }
    const exhaustedPrimary = (await store.findTask(taskId))!.task.currentExecution!;
    await workflow.failTurn(
      taskId,
      exhaustedPrimary.attemptId,
      capacityFailure(exhaustedPrimary.turnId!),
    );
    for (const delay of [5_000, 10_000, 20_000]) {
      const fallback = (await store.findTask(taskId))!.task.currentExecution!;
      await workflow.failTurn(
        taskId,
        fallback.attemptId,
        capacityFailure(fallback.turnId!),
      );
      now = new Date(now.getTime() + delay);
      await workflow.retryScheduledExecutions(now);
    }

    const fallback = (await store.findTask(taskId))!.task;
    const probeAt = new Date(Date.parse(primaryProbeAt(fallback)));
    now = probeAt;
    await workflow.completeTurn(
      taskId,
      fallback.currentExecution!.attemptId,
      fallback.currentExecution!.turnId!,
    );
    const probe = (await store.findTask(taskId))!.task.currentExecution!;
    expect(probe.modelRouting.circuitBreaker).toMatchObject({
      state: "half_open",
      fallbackRetryCount: 3,
    });

    await workflow.failTurn(
      taskId,
      probe.attemptId,
      capacityFailure(probe.turnId!),
    );
    const resumedFallback = (await store.findTask(taskId))!.task.currentExecution!;
    expect(resumedFallback.modelRouting).toMatchObject({
      model: models.fallback,
      route: "fallback",
      retryCount: 3,
      circuitBreaker: { state: "open" },
    });

    await workflow.failTurn(
      taskId,
      resumedFallback.attemptId,
      capacityFailure(resumedFallback.turnId!),
    );
    expect((await store.findTask(taskId))!.task).toMatchObject({
      status: "blocked",
      currentExecution: {
        status: "failed",
        modelRouting: { model: models.fallback, route: "fallback", retryCount: 3 },
      },
    });
  });

  it("closes the circuit after a primary probe stays stable", async () => {
    const created = await registerProject(1);
    await finishProjectExecution({
      projectId: created.project.id,
      outcome: "selected",
      summary: "Start the task",
      taskIds: [created.tasks[0]!.id],
    });
    const taskId = created.tasks[0]!.id;

    for (const delay of [5_000, 10_000, 20_000]) {
      await failCapacityAndStartRetry(taskId, delay);
    }
    const exhaustedPrimary = (await store.findTask(taskId))!.task.currentExecution!;
    await workflow.failTurn(
      taskId,
      exhaustedPrimary.attemptId,
      capacityFailure(exhaustedPrimary.turnId!),
    );
    const fallback = (await store.findTask(taskId))!.task.currentExecution!;
    now = new Date(Date.parse(primaryProbeAt((await store.findTask(taskId))!.task)));
    await workflow.completeTurn(taskId, fallback.attemptId, fallback.turnId!);

    now = new Date(now.getTime() + 5 * 60_000);
    await workflow.resetStableModelCapacityFailures(now);

    expect((await store.findTask(taskId))!.task.currentExecution).toMatchObject({
      status: "awaiting_report",
      modelRouting: {
        model: models.primary,
        route: "primary",
        retryCount: 0,
        circuitBreaker: { state: "closed" },
      },
    });
  });

  it("blocks only after fallback capacity retries are exhausted", async () => {
    const created = await registerProject(1);
    await finishProjectExecution({
      projectId: created.project.id,
      outcome: "selected",
      summary: "Start the task",
      taskIds: [created.tasks[0]!.id],
    });
    const taskId = created.tasks[0]!.id;

    for (const route of ["primary", "fallback"] as const) {
      for (const delay of [5_000, 10_000, 20_000]) {
        const running = (await store.findTask(taskId))!.task.currentExecution!;
        expect(running.modelRouting.route).toBe(route);
        await workflow.failTurn(taskId, running.attemptId, {
          turnId: running.turnId!,
          message: "Selected model is at capacity. Please try a different model.",
          codexErrorInfo: "serverOverloaded",
        });
        now = new Date(now.getTime() + delay);
        await workflow.retryScheduledExecutions(now);
      }
      const running = (await store.findTask(taskId))!.task.currentExecution!;
      await workflow.failTurn(taskId, running.attemptId, {
        turnId: running.turnId!,
        message: "Selected model is at capacity. Please try a different model.",
        codexErrorInfo: "serverOverloaded",
      });
    }

    expect((await store.findTask(taskId))!.task).toMatchObject({
      status: "blocked",
      currentExecution: {
        status: "failed",
        modelRouting: {
          model: models.fallback,
          route: "fallback",
          retryCount: 3,
        },
      },
    });
  });

  it("does not retry a non-capacity model failure", async () => {
    const created = await registerProject(1);
    await finishProjectExecution({
      projectId: created.project.id,
      outcome: "selected",
      summary: "Start the task",
      taskIds: [created.tasks[0]!.id],
    });
    const running = (await store.findTask(created.tasks[0]!.id))!.task
      .currentExecution!;

    await workflow.failTurn(created.tasks[0]!.id, running.attemptId, {
      turnId: running.turnId!,
      message: "The prompt is invalid",
      codexErrorInfo: "badRequest",
    });

    expect((await store.findTask(created.tasks[0]!.id))!.task).toMatchObject({
      status: "blocked",
      currentExecution: { status: "failed" },
    });
    expect(taskDispatcher.started).toHaveLength(1);
  });

  it("keeps a scheduled retry paused and starts it once scheduling resumes", async () => {
    const created = await registerProject(1);
    await finishProjectExecution({
      projectId: created.project.id,
      outcome: "selected",
      summary: "Start the task",
      taskIds: [created.tasks[0]!.id],
    });
    const taskId = created.tasks[0]!.id;
    const running = (await store.findTask(taskId))!.task.currentExecution!;
    await workflow.failTurn(taskId, running.attemptId, {
      turnId: running.turnId!,
      message: "Selected model is at capacity. Please try a different model.",
      codexErrorInfo: "serverOverloaded",
    });
    await workflow.controlProject(created.project.id, "pause");

    now = new Date(now.getTime() + 5_000);
    await workflow.retryScheduledExecutions(now);
    expect((await store.findTask(taskId))!.task.currentExecution?.status).toBe(
      "retry_scheduled",
    );
    expect(taskDispatcher.started).toHaveLength(1);

    await workflow.controlProject(created.project.id, "resume");
    expect((await store.findTask(taskId))!.task.currentExecution).toMatchObject({
      status: "running",
      attemptId: running.attemptId,
    });
    expect(taskDispatcher.started).toHaveLength(2);
  });

  it("suppresses a stale recovery after the same task attempt has started", async () => {
    const created = await registerProject(1);
    await finishProjectExecution({
      projectId: created.project.id,
      outcome: "selected",
      summary: "Start",
      taskIds: [created.tasks[0]!.id],
    });
    const running = (await store.findTask(created.tasks[0]!.id))!.task;
    const events: Array<Record<string, unknown>> = [];
    store.subscribe((event) => events.push(event as unknown as Record<string, unknown>));

    await workflow.recoverTask(running.id, running.currentExecution!.attemptId);

    const current = (await store.findTask(running.id))!.task;
    expect(current.currentExecution?.attemptId).toBe(
      running.currentExecution!.attemptId,
    );
    expect(current.currentExecution?.turnId).toBe(running.currentExecution!.turnId);
    expect(taskDispatcher.started).toHaveLength(1);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "recovery.execution_suppressed",
        taskId: running.id,
        decision: "keep_current",
        reason: "execution_already_progressed",
      }),
    );
  });

  it("suppresses a stale recovery after the same project attempt has started", async () => {
    const created = await registerProject(1);
    const running = created.project.currentExecution!;

    await workflow.recoverProjectExecution(created.project.id, running.attemptId);

    const current = (await store.getProject(created.project.id))!.project;
    expect(current.currentExecution?.attemptId).toBe(running.attemptId);
    expect(current.currentExecution?.turnId).toBe(running.turnId);
    expect(projectExecutor.started).toHaveLength(1);
  });

  it("records concise state transitions around workflow events", async () => {
    const created = await store.createProject({
      name: "Tiny Game",
      repositoryPath: "/workspace/game",
      defaultBranch: "main",
      productDocument: "# Tiny Game\n",
      tasks: [{ title: "Task", description: "Build it", acceptanceCriteria: [] }],
    });
    const events: Array<Record<string, unknown>> = [];
    store.subscribe((event) => events.push(event as unknown as Record<string, unknown>));

    await workflow.controlProject(created.project.id, "pause");

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "project.paused",
        before: expect.objectContaining({
          status: "active",
          scheduling: "running",
        }),
        after: expect.objectContaining({
          status: "active",
          scheduling: "paused",
        }),
      }),
    );
  });

  it("uses one integration lease per repository", async () => {
    const created = await store.createProject({
      name: "Tiny Game",
      repositoryPath: "/workspace/game",
      defaultBranch: "main",
      productDocument: "# Tiny Game\n",
      tasks: [
        { title: "One", description: "One", acceptanceCriteria: [] },
        { title: "Two", description: "Two", acceptanceCriteria: [] },
      ],
    });
    for (const current of created.tasks) {
      const reviewable = await bindNoCodeWork(
        store,
        created.project.id,
        current,
        `activity_${current.id}`,
      );
      const integrating: Task = {
        ...reviewable,
        status: "integrating",
        requestedAction: "integrate",
      };
      await store.saveTask(created.project.id, integrating);
    }

    await workflow.reconcile();

    expect(taskDispatcher.started).toHaveLength(1);
    expect(taskDispatcher.started[0]?.task.currentExecution?.action).toBe("integrate");
  });

  it("keeps the integration lease while the integrating task waits for input", async () => {
    const created = await store.createProject({
      name: "Tiny Game",
      repositoryPath: "/workspace/game",
      defaultBranch: "main",
      productDocument: "# Tiny Game\n",
      tasks: [
        { title: "One", description: "One", acceptanceCriteria: [] },
        { title: "Two", description: "Two", acceptanceCriteria: [] },
      ],
    });
    const firstReviewable = await bindNoCodeWork(
      store,
      created.project.id,
      created.tasks[0]!,
      "activity_input_work",
    );
    const secondReviewable = await bindNoCodeWork(
      store,
      created.project.id,
      created.tasks[1]!,
      "activity_next_work",
    );
    await store.saveTask(created.project.id, {
      ...firstReviewable,
      status: "waiting_for_input",
      requestedAction: "integrate",
      currentExecution: {
        attemptId: "integrate_1",
        reportOpportunityId: "report_opportunity_integrate_1",
        action: "integrate",
        workActivityId: "activity_input_work",
        status: "waiting_for_input",
        startedAt: "2026-08-03T00:00:00.000Z",
        modelRouting: testModelRouting(),
      },
    });
    await store.saveTask(created.project.id, {
      ...secondReviewable,
      status: "integrating",
      requestedAction: "integrate",
    });

    await workflow.reconcile();

    expect(taskDispatcher.started).toHaveLength(0);
  });

  it("releases the integration lease while an integrating task waits for resume", async () => {
    const created = await store.createProject({
      name: "Tiny Game",
      repositoryPath: "/workspace/game",
      defaultBranch: "main",
      productDocument: "# Tiny Game\n",
      tasks: [
        { title: "One", description: "One", acceptanceCriteria: [] },
        { title: "Two", description: "Two", acceptanceCriteria: [] },
      ],
    });
    const waitingReviewable = await bindNoCodeWork(
      store,
      created.project.id,
      created.tasks[0]!,
      "activity_waiting_work",
    );
    const nextReviewable = await bindNoCodeWork(
      store,
      created.project.id,
      created.tasks[1]!,
      "activity_ready_work",
    );
    await store.saveTask(created.project.id, {
      ...waitingReviewable,
      status: "blocked",
      requestedAction: "integrate",
      currentExecution: {
        attemptId: "integrate_waiting",
        reportOpportunityId: "report_opportunity_integrate_waiting",
        action: "integrate",
        workActivityId: "activity_waiting_work",
        status: "waiting_for_resume",
        startedAt: "2026-08-03T00:00:00.000Z",
        threadId: "thread_waiting",
        modelRouting: testModelRouting(),
        scheduledResume: {
          reason: "Wait for a deployment",
          resumeAt: "2026-08-03T01:00:00.000Z",
          resumePrompt: "Check the deployment and continue.",
        },
      },
    });
    await store.saveTask(created.project.id, {
      ...nextReviewable,
      status: "integrating",
      requestedAction: "integrate",
    });

    await workflow.reconcile();

    expect(taskDispatcher.started).toHaveLength(1);
    expect(taskDispatcher.started[0]?.task.id).toBe(created.tasks[1]!.id);
  });

  it("resumes multiple due waits by deadline within available capacity", async () => {
    const created = await store.createProject({
      name: "Tiny Game",
      repositoryPath: "/workspace/game",
      defaultBranch: "main",
      productDocument: "# Tiny Game\n",
      tasks: [
        { title: "One", description: "One", acceptanceCriteria: [] },
        { title: "Two", description: "Two", acceptanceCriteria: [] },
      ],
    });
    for (const [index, task] of created.tasks.entries()) {
      await store.saveTask(created.project.id, {
        ...task,
        status: "blocked",
        requestedAction: "work",
        currentExecution: {
          attemptId: `wait_${index}`,
          reportOpportunityId: `report_opportunity_wait_${index}`,
          action: "work",
          status: "waiting_for_resume",
          startedAt: "2026-08-02T23:00:00.000Z",
          threadId: `thread_${index}`,
          modelRouting: testModelRouting(),
          scheduledResume: {
            reason: `Wait ${index}`,
            resumeAt:
              index === 0
                ? "2026-08-03T08:01:00.000+08:00"
                : "2026-08-03T00:02:00.000Z",
            resumePrompt: `Continue ${index}`,
          },
        },
      });
    }

    await workflow.resumeScheduledTasks(new Date("2026-08-03T00:03:00.000Z"));

    expect(taskDispatcher.scheduledResumes.map(({ task }) => task.id)).toEqual(
      created.tasks.map(({ id: taskId }) => taskId),
    );
  });

  it("marks the project idle when its last task completes the full pipeline", async () => {
    const created = await registerProject(1);
    const taskId = created.tasks[0]!.id;
    await finishProjectExecution({
      projectId: created.project.id,
      outcome: "selected",
      summary: "Start the only task",
      taskIds: [taskId],
    });
    await finishTaskExecution(taskId, {
      outcome: "completed",
      summary: "Implemented",
      workspacePath: "/workspace/game/.worktrees/task",
      candidateCommit: "candidate_1",
    });
    await finishTaskExecution(taskId, {
      outcome: "approved",
      summary: "Approved",
      reviewedMainCommit: "main_1",
    });
    await finishTaskExecution(taskId, {
      outcome: "completed",
      summary: "Integrated",
      mergedCommit: "main_2",
    });

    expect((await store.getProject(created.project.id))!.project).toMatchObject({
      status: "idle",
      requestedAction: null,
    });
    expect(projectExecutor.started).toHaveLength(1);
  });

  it("marks the project idle when its last task is cancelled", async () => {
    const created = await registerProject(1);

    await workflow.cancelTask(created.tasks[0]!.id, {
      cancelledBy: "codex",
      decisionBasis: "agent_decision",
      reason: "The planned work is no longer required",
    });

    expect((await store.getProject(created.project.id))!.project).toMatchObject({
      status: "idle",
      requestedAction: null,
    });
    expect(projectExecutor.interrupted).toHaveLength(1);
  });
});
