import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { CodexGateway } from "../../src/application/codex-gateway.js";
import { CodexPlanningExecutor } from "../../src/application/codex-planning-executor.js";
import { WorkflowEngine } from "../../src/application/workflow-engine.js";
import type { Project } from "../../src/domain/types.js";
import { ProjectStore } from "../../src/infrastructure/project-store.js";
import {
  RecordingTaskDispatcher,
  TestRepositoryPathResolver,
  testModels,
} from "../support/recording-executors.js";

class RecordingGateway implements CodexGateway {
  calls: Array<{ method: string; args: unknown[] }> = [];

  async startThread(cwd: string, title: string): Promise<string> {
    this.calls.push({ method: "startThread", args: [cwd, title] });
    return "project_thread";
  }

  async resumeThread(threadId: string, cwd: string): Promise<void> {
    this.calls.push({ method: "resumeThread", args: [threadId, cwd] });
  }

  async setThreadName(threadId: string, name: string): Promise<void> {
    this.calls.push({ method: "setThreadName", args: [threadId, name] });
  }

  async startTurn(
    threadId: string,
    cwd: string,
    prompt: string,
    model: string,
    reasoningEffort?: string,
  ): Promise<string> {
    this.calls.push({
      method: "startTurn",
      args: [
        threadId,
        cwd,
        prompt,
        model,
        ...(reasoningEffort ? [reasoningEffort] : []),
      ],
    });
    return "project_turn";
  }

  async interruptTurn(): Promise<void> {}
  async isThreadActive(): Promise<boolean> {
    return false;
  }
  async readTurnStatus(): Promise<null> {
    return null;
  }
  async readTurnSnapshot() {
    return { threadStatus: "idle" as const, activeTurnIds: [], turn: null };
  }
  async listModels(): Promise<[]> {
    return [];
  }
  async hasSkill(): Promise<boolean> {
    return false;
  }
}

class RestartableGateway extends RecordingGateway {
  loaded = false;
  failNextStart = false;
  private turnCount = 0;

  override async startThread(cwd: string, title: string): Promise<string> {
    if (this.failNextStart) {
      this.failNextStart = false;
      throw new Error("App Server temporarily unavailable");
    }
    this.loaded = true;
    return super.startThread(cwd, title);
  }

  override async resumeThread(threadId: string, cwd: string): Promise<void> {
    this.loaded = true;
    await super.resumeThread(threadId, cwd);
  }

  override async startTurn(
    ...args: Parameters<RecordingGateway["startTurn"]>
  ): Promise<string> {
    if (!this.loaded) throw new Error("Thread is not loaded after restart");
    await super.startTurn(...args);
    return `turn_${++this.turnCount}`;
  }
}

const timestamp = "2026-08-03T00:00:00.000Z";

function project(): Project {
  return {
    id: "project_1",
    name: "Tiny Game",
    repositoryPath: "/workspace/game",
    defaultBranch: "main",
    status: "active",
    scheduling: "running",
    requestedAction: "select_tasks",
    planning: {
      revision: 1,
      changedAt: timestamp,
      changeReason: "project_registered",
      concurrencyLimit: 4,
    },
    productFacts: {
      revision: 1,
      digest:
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      changedAt: timestamp,
    },
    currentExecution: {
      attemptId: "project_attempt_1",
      reportOpportunityId: "project_report_1",
      action: "select_tasks",
      status: "pending",
      startedAt: timestamp,
      modelRouting: {
        model: "gpt-5.6-sol",
        route: "primary",
        retryCount: 0,
      },
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

describe("CodexPlanningExecutor", () => {
  const directories: string[] = [];
  afterEach(async () => {
    await Promise.all(
      directories
        .splice(0)
        .map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  it.each(["project", "milestone"] as const)(
    "resumes the persisted %s conversation before recovering after an App Server restart",
    async (role) => {
      const directory = await mkdtemp(
        join(tmpdir(), "codrive-planning-recovery-"),
      );
      directories.push(directory);
      const store = new ProjectStore(directory);
      const gateway = new RestartableGateway();
      const createWorkflow = () =>
        new WorkflowEngine(
          store,
          new RecordingTaskDispatcher(),
          { maxConcurrentTasks: 2, models: testModels },
          new TestRepositoryPathResolver(),
          new CodexPlanningExecutor(gateway),
        );
      const snapshot = await createWorkflow().registerProject({
        name: "Migration",
        repositoryPath: "/workspace/migration",
        defaultBranch: "main",
        productDocument: "# Migration\n",
        tasks:
          role === "project"
            ? [
                {
                  title: "Find readers",
                  description: "Inspect existing readers",
                  acceptanceCriteria: ["Existing readers are listed"],
                },
              ]
            : [],
        milestones:
          role === "milestone"
            ? [
                {
                  title: "Migrate search",
                  description: "Preserve search results",
                  acceptanceCriteria: ["No old readers"],
                },
              ]
            : [],
      });
      const owner =
        role === "project" ? snapshot.project : snapshot.milestones[0]!;
      const before = owner.currentExecution!;
      expect(before.status).toBe("running");
      gateway.loaded = false;
      gateway.calls = [];

      const recoveredWorkflow = createWorkflow();
      if (role === "project") {
        await recoveredWorkflow.restartProjectAfterInterruption(
          owner.id,
          before.attemptId,
        );
      } else {
        await recoveredWorkflow.recoverMilestoneExecution(
          owner.id,
          before.attemptId,
          before.turnId,
          "recover",
        );
      }

      const restored = (await store.getProject(snapshot.project.id))!;
      const execution = (
        role === "project" ? restored.project : restored.milestones[0]!
      ).currentExecution!;
      expect(execution).toMatchObject({
        attemptId: before.attemptId,
        reportOpportunityId: before.reportOpportunityId,
        threadId: before.threadId,
        status: "running",
      });
      expect(execution.turnId).not.toBe(before.turnId);
      expect(gateway.calls.map((call) => call.method)).toEqual([
        "resumeThread",
        "setThreadName",
        "startTurn",
      ]);
    },
  );

  it("replans a milestone whose first conversation could not be created", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codrive-planning-replan-"));
    directories.push(directory);
    const store = new ProjectStore(directory);
    const gateway = new RestartableGateway();
    gateway.failNextStart = true;
    const workflow = new WorkflowEngine(
      store,
      new RecordingTaskDispatcher(),
      { maxConcurrentTasks: 2, models: testModels },
      new TestRepositoryPathResolver(),
      new CodexPlanningExecutor(gateway),
    );
    const snapshot = await workflow.registerProject({
      name: "Migration",
      repositoryPath: "/workspace/migration",
      defaultBranch: "main",
      productDocument: "# Migration\n",
      tasks: [],
      milestones: [
        {
          title: "Migrate search",
          description: "Preserve search results",
          acceptanceCriteria: ["No old readers"],
        },
      ],
    });
    const failed = snapshot.milestones[0]!;
    expect(failed.currentExecution?.status).toBe("failed");
    expect(failed.threadId).toBeUndefined();
    expect(failed.planning.evaluatedRevision).toBe(failed.planning.revision);

    await workflow.controlProject(snapshot.project.id, "replan");

    const recovered = (await store.findMilestone(failed.id))!.milestone;
    expect(recovered.currentExecution?.status).toBe("running");
    expect(recovered.currentExecution?.attemptId).not.toBe(
      failed.currentExecution?.attemptId,
    );
    expect(recovered.threadId).toBe("project_thread");
    expect(recovered.planning.revision).toBeGreaterThan(
      failed.planning.revision,
    );
  });

  it("preserves configured effort for task selection and report reminders", async () => {
    const gateway = new RecordingGateway();
    const executor = new CodexPlanningExecutor(gateway);
    const current = project();
    current.currentExecution!.modelRouting.reasoningEffort = "high";

    await executor.startTurn({ project: current }, "project_thread");
    await executor.requestReport({ project: current }, "project_thread");

    expect(gateway.calls.map(({ args }) => args.slice(3))).toEqual([
      ["gpt-5.6-sol", "high"],
      ["gpt-5.6-sol", "high"],
    ]);
  });

  it("reuses the project conversation across new planning attempts", async () => {
    const gateway = new RecordingGateway();
    const executor = new CodexPlanningExecutor(gateway);
    const current = {
      ...project(),
      planningThreadId: "earlier_planning_thread",
    };

    expect(await executor.openThread({ project: current })).toBe(
      "earlier_planning_thread",
    );
    expect(gateway.calls).toEqual([
      {
        method: "resumeThread",
        args: ["earlier_planning_thread", "/workspace/game"],
      },
      {
        method: "setThreadName",
        args: ["earlier_planning_thread", "[调度] Tiny Game"],
      },
    ]);
  });

  it("runs task selection in a visible persistent project conversation", async () => {
    const gateway = new RecordingGateway();
    const executor = new CodexPlanningExecutor(gateway);
    const current = project();

    const threadId = await executor.openThread({ project: current });
    await executor.startTurn({ project: current }, threadId);

    expect(gateway.calls).toEqual([
      {
        method: "startThread",
        args: ["/workspace/game", "[调度] Tiny Game"],
      },
      {
        method: "startTurn",
        args: [
          "project_thread",
          "/workspace/game",
          "请使用 $codrive-task 为项目 project_1选择当前适合开始的任务。先读取当前 context 中的执行身份与事实。",
          "gpt-5.6-sol",
        ],
      },
    ]);
  });
});
