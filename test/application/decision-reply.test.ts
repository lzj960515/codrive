import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { WorkflowEngine } from "../../src/application/workflow-engine.js";
import { createHttpServer } from "../../src/interfaces/http/server.js";
import { ProjectStore } from "../../src/infrastructure/project-store.js";
import {
  RecordingProjectExecutor,
  RecordingTaskDispatcher,
  TestRepositoryPathResolver,
  testModels,
} from "../support/recording-executors.js";

async function setup(scope: "task" | "project" | "milestone") {
  const store = new ProjectStore(
    await mkdtemp(join(tmpdir(), "codrive-decision-")),
  );
  const tasks = new RecordingTaskDispatcher();
  const planner = new RecordingProjectExecutor();
  const workflow = new WorkflowEngine(
    store,
    tasks,
    { maxConcurrentTasks: 2, models: testModels },
    new TestRepositoryPathResolver(),
    planner,
  );
  const snapshot = await workflow.registerProject({
    name: "Decision",
    repositoryPath: "/workspace/decision",
    defaultBranch: "main",
    productDocument: "# Decision\n",
    tasks:
      scope === "milestone"
        ? []
        : [{ title: "Build", description: "Build", acceptanceCriteria: [] }],
    ...(scope === "milestone"
      ? {
          milestones: [
            {
              title: "Deliver",
              description: "Deliver",
              acceptanceCriteria: [],
            },
          ],
        }
      : {}),
  });
  if (scope === "milestone") {
    const owner = snapshot.milestones[0]!;
    const execution = owner.currentExecution!;
    await workflow.submitMilestoneReport({
      milestoneId: owner.id,
      attemptId: execution.attemptId,
      reportOpportunityId: execution.reportOpportunityId,
      definitionVersion: owner.definitionVersion,
      planningRevision: execution.planningRevision!,
      outcome: "needs_input",
      summary: "Choose",
      plan: {
        resolutions: [
          { sourceActivityIds: [], summary: "Choose", question: "Ship it?" },
        ],
      },
    });
    await workflow.completeMilestoneTurn(
      owner.id,
      execution.attemptId,
      execution.turnId!,
    );
    return {
      store,
      tasks,
      planner,
      workflow,
      id: owner.id,
      projectId: snapshot.project.id,
      execution: (await store.findMilestone(owner.id))!.milestone
        .currentExecution!,
    };
  }
  const execution = snapshot.project.currentExecution!;
  await workflow.submitProjectReport({
    projectId: snapshot.project.id,
    attemptId: execution.attemptId,
    reportOpportunityId: execution.reportOpportunityId,
    outcome: scope === "task" ? "selected" : "needs_input",
    summary: "Choose",
    ...(scope === "task"
      ? { taskIds: [snapshot.tasks[0]!.id] }
      : { question: "Ship it?" }),
  });
  await workflow.completeProjectTurn(
    snapshot.project.id,
    execution.attemptId,
    execution.turnId!,
  );
  if (scope === "project")
    return {
      store,
      tasks,
      planner,
      workflow,
      id: snapshot.project.id,
      projectId: snapshot.project.id,
      execution: (await store.getProject(snapshot.project.id))!.project
        .currentExecution!,
    };
  const task = (await store.findTask(snapshot.tasks[0]!.id))!.task;
  const taskExecution = task.currentExecution!;
  await workflow.submitReport({
    taskId: task.id,
    attemptId: taskExecution.attemptId,
    reportOpportunityId: taskExecution.reportOpportunityId,
    outcome: "needs_input",
    summary: "Choose",
    question: "Ship it?",
  });
  await workflow.completeTurn(
    task.id,
    taskExecution.attemptId,
    taskExecution.turnId!,
  );
  return {
    store,
    tasks,
    planner,
    workflow,
    id: task.id,
    projectId: snapshot.project.id,
    execution: (await store.findTask(task.id))!.task.currentExecution!,
  };
}

async function current(
  env: Awaited<ReturnType<typeof setup>>,
  scope: "task" | "project" | "milestone",
) {
  if (scope === "task") return (await env.store.findTask(env.id))!.task;
  if (scope === "milestone")
    return (await env.store.findMilestone(env.id))!.milestone;
  return (await env.store.getProject(env.id))!.project;
}

describe("replying to the current decision", () => {
  it.each(["task", "project", "milestone"] as const)(
    "starts one bound %s turn and rejects stale duplicate replies",
    async (scope) => {
      const env = await setup(scope);
      const before = await current(env, scope);
      const payload = {
        scope,
        id: env.id,
        reportOpportunityId: env.execution.reportOpportunityId,
        message: "Ship the agreed scope.",
      };
      const results = await Promise.allSettled([
        env.workflow.execute({ type: "decision.reply", payload }),
        env.workflow.execute({ type: "decision.reply", payload }),
      ]);
      expect(results.map((result) => result.status).sort()).toEqual([
        "fulfilled",
        "rejected",
      ]);
      const after = await current(env, scope);
      expect(after.currentExecution).toMatchObject({
        status: "running",
        threadId: before.currentExecution!.threadId,
      });
      expect(after.currentExecution!.reportOpportunityId).not.toBe(
        before.currentExecution!.reportOpportunityId,
      );
      expect(after.currentExecution!.turnId).not.toBe(
        before.currentExecution!.turnId,
      );
      if (scope === "task")
        expect(after.currentExecution!.attemptId).toBe(
          before.currentExecution!.attemptId,
        );
    },
  );

  it.each(["task", "project", "milestone"] as const)(
    "rejects a %s reply while the old turn is still finishing",
    async (scope) => {
      const env = await setup(scope);
      const owner = await current(env, scope);
      delete owner.currentExecution!.turnCompletedAt;
      if (scope === "task")
        await env.store.saveTask(
          env.projectId,
          owner as import("../../src/domain/types.js").Task,
        );
      else if (scope === "milestone")
        await env.store.saveMilestone(
          env.projectId,
          owner as import("../../src/domain/milestone.js").Milestone,
        );
      else
        await env.store.saveProject(
          owner as import("../../src/domain/types.js").Project,
        );
      const before = await current(env, scope);
      await expect(
        env.workflow.execute({
          type: "decision.reply",
          payload: {
            scope,
            id: env.id,
            reportOpportunityId: env.execution.reportOpportunityId,
            message: "Ship it.",
          },
        }),
      ).rejects.toThrow(/上一轮/);
      expect(await current(env, scope)).toEqual(before);
    },
  );

  it.each(["task", "project", "milestone"] as const)(
    "preserves the %s question while its conversation has another active turn",
    async (scope) => {
      const env = await setup(scope);
      const before = await current(env, scope);
      if (scope === "task") env.tasks.conversationActive = true;
      else Object.assign(env.planner, { isThreadActive: async () => true });
      await expect(
        env.workflow.execute({
          type: "decision.reply",
          payload: {
            scope,
            id: env.id,
            reportOpportunityId: env.execution.reportOpportunityId,
            message: "Ship it.",
          },
        }),
      ).rejects.toThrow(/仍在处理上一轮/);
      expect(await current(env, scope)).toEqual(before);
    },
  );

  it("restores the original task question when sending fails after resume", async () => {
    const env = await setup("task");
    const before = await current(env, "task");
    env.tasks.beforeStartTurn = async () => {
      throw new Error("Model temporarily unavailable");
    };
    await expect(
      env.workflow.execute({
        type: "decision.reply",
        payload: {
          scope: "task",
          id: env.id,
          reportOpportunityId: env.execution.reportOpportunityId,
          message: "Ship it.",
        },
      }),
    ).rejects.toThrow("Model temporarily unavailable");
    expect(await current(env, "task")).toEqual(before);
    expect(env.tasks.resumed.at(-1)?.threadId).toBe(env.execution.threadId);
  });

  it("keeps a resumed task's report opportunity independent of the answered question", async () => {
    const env = await setup("task");
    const send = vi.spyOn(env.tasks, "replyToDecision");
    await env.workflow.execute({
      type: "decision.reply",
      payload: {
        scope: "task",
        id: env.id,
        reportOpportunityId: env.execution.reportOpportunityId,
        message: "  Ship exactly this scope.  ",
      },
    });
    expect(send).toHaveBeenCalledWith(
      expect.anything(),
      env.execution.threadId,
      "Ship exactly this scope.",
    );
    const task = (await env.store.findTask(env.id))!.task;
    const execution = task.currentExecution!;
    await expect(
      env.workflow.submitReport({
        taskId: env.id,
        attemptId: execution.attemptId,
        reportOpportunityId: env.execution.reportOpportunityId,
        outcome: "needs_input",
        summary: "old answer",
        question: "old question",
      }),
    ).rejects.toThrow(/Report opportunity/);
    await env.workflow.submitReport({
      taskId: env.id,
      attemptId: execution.attemptId,
      reportOpportunityId: execution.reportOpportunityId,
      outcome: "needs_input",
      summary: "One new question",
      question: "Confirm the new evidence?",
    });
    await env.workflow.completeTurn(
      env.id,
      execution.attemptId,
      execution.turnId!,
    );
    expect(
      (await env.store.findTask(env.id))!.task.currentExecution,
    ).toMatchObject({
      status: "waiting_for_input",
      attemptId: execution.attemptId,
    });
    expect(
      (await env.store.listTaskActivities(env.projectId, env.id)).filter(
        (activity) => activity.type === "decision_requested",
      ),
    ).toHaveLength(2);
  });

  it.each(["task", "project", "milestone"] as const)(
    "rejects a reply for paused %s work without changing its decision",
    async (scope) => {
      const env = await setup(scope);
      await env.workflow.execute({
        type: "project.control",
        payload: { projectId: env.projectId, action: "pause" },
      });
      const before = await current(env, scope);
      await expect(
        env.workflow.execute({
          type: "decision.reply",
          payload: {
            scope,
            id: env.id,
            reportOpportunityId: env.execution.reportOpportunityId,
            message: "Ship it.",
          },
        }),
      ).rejects.toThrow();
      expect(await current(env, scope)).toEqual(before);
    },
  );

  it.each(["task", "project", "milestone"] as const)(
    "exposes a valid %s reply target and sends it through the authenticated HTTP command",
    async (scope) => {
      const env = await setup(scope);
      const server = createHttpServer({
        store: env.store,
        workflow: env.workflow,
        accessToken: "decision-test",
        settingsService: {
          read: async () => ({}),
          update: async () => ({}),
          readProject: async () => ({}),
          updateProject: async () => ({}),
        },
      });
      const headers = { "x-codrive-token": "decision-test" };
      try {
        const path =
          scope === "task"
            ? `/api/tasks/${env.id}`
            : `/api/projects/${env.projectId}`;
        const view = (
          await server.inject({ method: "GET", url: path, headers })
        ).json();
        const target =
          scope === "task"
            ? view.decisionReply
            : scope === "project"
              ? view.attention.decisionReply
              : view.milestones.find(
                  (milestone: { id: string }) => milestone.id === env.id,
                ).decisionReply;
        expect(target).toEqual({
          scope,
          id: env.id,
          reportOpportunityId: env.execution.reportOpportunityId,
        });
        const command = {
          type: "decision.reply",
          payload: { ...target, message: "User confirms." },
        };
        expect(
          (
            await server.inject({
              method: "POST",
              url: "/api/commands",
              headers,
              payload: {
                ...command,
                payload: { ...command.payload, message: "   " },
              },
            })
          ).statusCode,
        ).toBe(400);
        const response = await server.inject({
          method: "POST",
          url: "/api/commands",
          headers,
          payload: command,
        });
        expect(response.statusCode).toBe(200);
        const duplicate = await server.inject({
          method: "POST",
          url: "/api/commands",
          headers,
          payload: command,
        });
        expect(duplicate.statusCode).toBe(409);
        const after = (
          await server.inject({ method: "GET", url: path, headers })
        ).json();
        const nextTarget =
          scope === "task"
            ? after.decisionReply
            : scope === "project"
              ? (after.attention?.decisionReply ?? null)
              : after.milestones.find(
                  (milestone: { id: string }) => milestone.id === env.id,
                ).decisionReply;
        expect(nextTarget).toBeNull();
      } finally {
        await server.close();
      }
    },
  );

  it.each(["task", "project", "milestone"] as const)(
    "preserves the original %s decision when the conversation is locked",
    async (scope) => {
      const env = await setup(scope);
      const before = await current(env, scope);
      if (scope === "task")
        env.tasks.beforeResumeThread = async () => {
          throw new Error("Thread thread-id already has an active writer");
        };
      else
        env.planner.beforeStartTurn = async () => {
          throw new Error("Thread thread-id already has an active writer");
        };
      await expect(
        env.workflow.execute({
          type: "decision.reply",
          payload: {
            scope,
            id: env.id,
            reportOpportunityId: env.execution.reportOpportunityId,
            message: "Ship it.",
          },
        }),
      ).rejects.toThrow(/Codex App/);
      expect(await current(env, scope)).toEqual(before);
    },
  );
});
