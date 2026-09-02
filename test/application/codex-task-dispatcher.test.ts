import { describe, expect, it } from "vitest";

import { CodexTaskDispatcher } from "../../src/application/codex-task-dispatcher.js";
import type { CodexGateway } from "../../src/application/codex-gateway.js";
import type { Project, Task } from "../../src/domain/types.js";

class RecordingGateway implements CodexGateway {
  calls: Array<{ method: string; args: unknown[] }> = [];
  thread = 0;
  turn = 0;
  threadActive = false;

  async startThread(cwd: string, title: string): Promise<string> {
    this.calls.push({ method: "startThread", args: [cwd, title] });
    return `thread_${++this.thread}`;
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
  ): Promise<string> {
    this.calls.push({ method: "startTurn", args: [threadId, cwd, prompt, model] });
    return `turn_${++this.turn}`;
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    this.calls.push({ method: "interruptTurn", args: [threadId, turnId] });
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

  async hasSkill(cwd: string, skillName: string): Promise<boolean> {
    this.calls.push({ method: "hasSkill", args: [cwd, skillName] });
    return false;
  }

  async isThreadActive(): Promise<boolean> {
    return this.threadActive;
  }
}

const timestamp = "2026-08-03T00:00:00.000Z";
const modelRouting = () => ({
  model: "gpt-5.6-sol",
  route: "primary" as const,
  retryCount: 0,
});
const project: Project = {
  id: "project_1",
  name: "Tiny Game",
  repositoryPath: "/workspace/game",
  defaultBranch: "main",
  status: "active",
      scheduling: "running",
      requestedAction: null,
      planning: {
        revision: 1,
        changedAt: timestamp,
        changeReason: "project_registered",
        concurrencyLimit: 4,
      },
      productFacts: {
        revision: 1,
        digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        changedAt: timestamp,
      },
      createdAt: timestamp,
  updatedAt: timestamp,
};

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "task_1",
    projectId: project.id,
    title: "Playable loop",
    description: "Build the loop",
    acceptanceCriteria: [],
    order: 1,
    status: "working",
    requestedAction: "work",
    currentExecution: {
      attemptId: "attempt_1",
      reportOpportunityId: "report_opportunity_attempt_1",
      action: "work",
      status: "pending",
      startedAt: timestamp,
      modelRouting: modelRouting(),
    },
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

function request(currentTask: Task, activity = {}) {
  return {
    project,
    task: currentTask,
    activity: {
      delivery: {},
      conversations: {
        reviewCount: 0,
        ...activity,
      },
      latestDecisionRequest: null,
    },
  };
}

function createDispatcher(
  gateway: CodexGateway,
  semanticAtlas = false,
  codeReviewSkillAvailable = false,
) {
  return new CodexTaskDispatcher(
    gateway,
    {
      read: async () => semanticAtlas
        ? { semanticAtlas: { automaticMaintenance: true } }
        : {},
    },
    { codeReviewSkillAvailable },
  );
}

describe("CodexTaskDispatcher", () => {
  it("loads Semantic Atlas for an ordinary task when automatic maintenance is enabled", async () => {
    const gateway = new RecordingGateway();
    const dispatcher = createDispatcher(gateway, true);
    const currentRequest = request(task());

    const conversation = await dispatcher.attachConversation(currentRequest);
    const turn = await dispatcher.startTurn(currentRequest, conversation.threadId);

    expect({ conversation, turn }).toEqual({
      conversation: { threadId: "thread_1", disposition: "created" },
      turn: { status: "started", turnId: "turn_1" },
    });
    expect(gateway.calls).toEqual([
      {
        method: "startThread",
        args: ["/workspace/game", "Playable loop"],
      },
      {
        method: "startTurn",
        args: [
          "thread_1",
          "/workspace/game",
          "请使用 $codrive-task 处理任务 task_1 的当前阶段，并加载 $semantic-atlas；由该 Skill 根据任务内容决定是否执行业务理解与记录。",
          "gpt-5.6-sol",
        ],
      },
    ]);
  });

  it("labels review conversations and loads the available code-review Skill", async () => {
    const gateway = new RecordingGateway();
    const dispatcher = createDispatcher(gateway, true, true);
    const reviewing = task({
      status: "reviewing",
      requestedAction: "review",
      currentExecution: {
        attemptId: "review_1",
        reportOpportunityId: "report_opportunity_review_1",
        action: "review",
        status: "pending",
        startedAt: timestamp,
        modelRouting: modelRouting(),
      },
    });
    const currentRequest = request(reviewing, {
      workThreadId: "development_thread",
    });

    const conversation = await dispatcher.attachConversation(currentRequest);
    const turn = await dispatcher.startTurn(currentRequest, conversation.threadId);

    expect({ conversation, turn }).toEqual({
      conversation: { threadId: "thread_1", disposition: "created" },
      turn: { status: "started", turnId: "turn_1" },
    });
    expect(gateway.calls).toEqual([
      {
        method: "startThread",
        args: [project.repositoryPath, "[review] Playable loop"],
      },
      {
        method: "startTurn",
        args: [
          "thread_1",
          project.repositoryPath,
          "请使用 $codrive-task 处理任务 task_1 的当前阶段，并加载 $code-review 执行独立审查；同时加载 $semantic-atlas，由该 Skill 根据任务内容决定是否执行业务理解与记录。",
          "gpt-5.6-sol",
        ],
      },
    ]);
  });

  it("keeps review, follow-up work, and integration conversations attached to the project", async () => {
    const gateway = new RecordingGateway();
    const dispatcher = createDispatcher(gateway);
    const reviewing = task({
      status: "reviewing",
      requestedAction: "review",
      currentExecution: {
        attemptId: "review_1",
        reportOpportunityId: "report_opportunity_review_1",
        action: "review",
        status: "pending",
        startedAt: timestamp,
        modelRouting: modelRouting(),
      },
    });
    const followUpWork = task({
      requestedAction: "work",
      currentExecution: {
        attemptId: "rework_1",
        reportOpportunityId: "report_opportunity_rework_1",
        action: "work",
        status: "pending",
        startedAt: timestamp,
        modelRouting: modelRouting(),
      },
    });
    const integrating = task({
      status: "integrating",
      requestedAction: "integrate",
      currentExecution: {
        attemptId: "integrate_1",
        reportOpportunityId: "report_opportunity_integrate_1",
        action: "integrate",
        status: "pending",
        startedAt: timestamp,
        modelRouting: modelRouting(),
      },
    });

    await dispatcher.attachConversation(
      request(reviewing, { workThreadId: "development_thread" }),
    );
    await dispatcher.attachConversation(
      request(followUpWork, { workThreadId: "development_thread" }),
    );
    await dispatcher.attachConversation(
      request(integrating, { workThreadId: "development_thread" }),
    );

    expect(gateway.calls).toEqual([
      {
        method: "startThread",
        args: [
          project.repositoryPath,
          "[review] Playable loop",
        ],
      },
      {
        method: "resumeThread",
        args: ["development_thread", project.repositoryPath],
      },
      {
        method: "resumeThread",
        args: ["development_thread", project.repositoryPath],
      },
    ]);
  });

  it("reuses the saved review conversation for later reviews of the same task", async () => {
    const gateway = new RecordingGateway();
    const dispatcher = createDispatcher(gateway);
    const reviewing = task({
      status: "reviewing",
      requestedAction: "review",
      currentExecution: {
        attemptId: "review_2",
        reportOpportunityId: "report_opportunity_review_2",
        action: "review",
        status: "pending",
        startedAt: timestamp,
        modelRouting: modelRouting(),
      },
    });

    const conversation = await dispatcher.attachConversation(
      request(reviewing, {
        workThreadId: "development_thread",
        reviewThreadId: "review_thread",
        reviewCount: 1,
      }),
    );

    expect(conversation).toEqual({
      threadId: "review_thread",
      disposition: "resumed",
    });
    expect(gateway.calls).toEqual([
      {
        method: "resumeThread",
        args: ["review_thread", project.repositoryPath],
      },
      {
        method: "setThreadName",
        args: ["review_thread", "[review] Playable loop"],
      },
    ]);
  });

  it("does not share a review conversation between different tasks", async () => {
    const gateway = new RecordingGateway();
    const dispatcher = createDispatcher(gateway);
    const reviewing = task({
      status: "reviewing",
      requestedAction: "review",
      currentExecution: {
        attemptId: "review_1",
        reportOpportunityId: "report_opportunity_review_1",
        action: "review",
        status: "pending",
        startedAt: timestamp,
        modelRouting: modelRouting(),
      },
    });
    const otherTask = task({
      id: "task_2",
      title: "Second loop",
      status: "reviewing",
      requestedAction: "review",
      currentExecution: {
        attemptId: "review_1_other",
        reportOpportunityId: "report_opportunity_review_1_other",
        action: "review",
        status: "pending",
        startedAt: timestamp,
        modelRouting: modelRouting(),
      },
    });

    await dispatcher.attachConversation(
      request(reviewing, { reviewThreadId: "task_1_review", reviewCount: 1 }),
    );
    await dispatcher.attachConversation(request(otherTask));

    expect(gateway.calls).toEqual([
      {
        method: "resumeThread",
        args: ["task_1_review", project.repositoryPath],
      },
      {
        method: "setThreadName",
        args: ["task_1_review", "[review] Playable loop"],
      },
      {
        method: "startThread",
        args: [
          project.repositoryPath,
          "[review] Second loop",
        ],
      },
    ]);
  });

  it("reattaches the persisted task thread during interrupted execution recovery", async () => {
    const gateway = new RecordingGateway();
    const dispatcher = createDispatcher(gateway);
    const currentRequest = request(task());

    await dispatcher.resumeThread(currentRequest, "persisted_thread");

    expect(gateway.calls).toEqual([
      {
        method: "resumeThread",
        args: ["persisted_thread", project.repositoryPath],
      },
    ]);
  });

  it("restores the review title during interrupted execution recovery", async () => {
    const gateway = new RecordingGateway();
    const dispatcher = createDispatcher(gateway);
    const reviewing = task({
      status: "reviewing",
      requestedAction: "review",
      currentExecution: {
        attemptId: "review_recovery_1",
        reportOpportunityId: "report_opportunity_review_recovery_1",
        action: "review",
        status: "running",
        startedAt: timestamp,
        modelRouting: modelRouting(),
        threadId: "persisted_review_thread",
        turnId: "interrupted_review_turn",
      },
    });

    await dispatcher.resumeThread(
      request(reviewing),
      "persisted_review_thread",
    );

    expect(gateway.calls).toEqual([
      {
        method: "resumeThread",
        args: ["persisted_review_thread", project.repositoryPath],
      },
      {
        method: "setThreadName",
        args: ["persisted_review_thread", "[review] Playable loop"],
      },
    ]);
  });

  it("starts task and report turns under the project while preserving the task worktree", async () => {
    const gateway = new RecordingGateway();
    const dispatcher = createDispatcher(gateway);
    const currentRequest = request(task());

    await dispatcher.startTurn(currentRequest, "thread_1");
    await dispatcher.requestReport(currentRequest, "thread_1");

    expect(gateway.calls).toEqual([
      {
        method: "startTurn",
        args: [
          "thread_1",
          project.repositoryPath,
          "请使用 $codrive-task 处理任务 task_1 的当前阶段。",
          "gpt-5.6-sol",
        ],
      },
      {
        method: "startTurn",
        args: [
          "thread_1",
          project.repositoryPath,
          "请使用 $codrive-task 汇报任务 task_1 的当前处理结果。",
          "gpt-5.6-sol",
        ],
      },
    ]);
  });

  it("keeps the ordinary task prompt when Semantic Atlas is disabled", async () => {
    const gateway = new RecordingGateway();
    const dispatcher = createDispatcher(gateway);
    const reviewing = task({
      status: "reviewing",
      requestedAction: "review",
      currentExecution: {
        attemptId: "review_1",
        reportOpportunityId: "report_opportunity_review_1",
        action: "review",
        status: "pending",
        startedAt: timestamp,
        modelRouting: modelRouting(),
      },
    });
    const followUpWork = task({
      requestedAction: "work",
      currentExecution: {
        attemptId: "rework_1",
        reportOpportunityId: "report_opportunity_rework_1",
        action: "work",
        status: "pending",
        startedAt: timestamp,
        modelRouting: modelRouting(),
      },
    });

    await dispatcher.startTurn(request(reviewing), "review_thread");
    await dispatcher.startTurn(request(followUpWork), "development_thread");

    expect(gateway.calls).toEqual([
      {
        method: "startTurn",
        args: [
          "review_thread",
          project.repositoryPath,
          "请使用 $codrive-task 处理任务 task_1 的当前阶段。",
          "gpt-5.6-sol",
        ],
      },
      {
        method: "startTurn",
        args: [
          "development_thread",
          project.repositoryPath,
          "请使用 $codrive-task 处理任务 task_1 的当前阶段。",
          "gpt-5.6-sol",
        ],
      },
    ]);
  });

  it("keeps dedicated maintenance tasks on their specialized Skill", async () => {
    const gateway = new RecordingGateway();
    const dispatcher = createDispatcher(gateway, true);
    const maintenance = task({
      origin: {
        kind: "semantic_atlas_maintenance",
        repositoryPath: "/workspace/game/apps/api",
      },
    });

    await dispatcher.startTurn(request(maintenance), "maintenance_thread");

    expect(gateway.calls[0]?.args[2]).toBe(
      "请使用 $codrive-task 处理任务 task_1 的当前阶段，并加载 $semantic-atlas-maintenance 处理该维护任务。",
    );
  });

  it("combines code-review with specialized Semantic Atlas maintenance reviews", async () => {
    const gateway = new RecordingGateway();
    const dispatcher = createDispatcher(gateway, true, true);
    const maintenanceReview = task({
      status: "reviewing",
      requestedAction: "review",
      currentExecution: {
        attemptId: "review_maintenance_1",
        reportOpportunityId: "report_opportunity_review_maintenance_1",
        action: "review",
        status: "pending",
        startedAt: timestamp,
        modelRouting: modelRouting(),
      },
      origin: {
        kind: "semantic_atlas_maintenance",
        repositoryPath: "/workspace/game/apps/api",
      },
    });

    await dispatcher.startTurn(
      request(maintenanceReview),
      "maintenance_review_thread",
    );

    expect(gateway.calls).toEqual([
      {
        method: "startTurn",
        args: [
          "maintenance_review_thread",
          project.repositoryPath,
          "请使用 $codrive-task 处理任务 task_1 的当前阶段，并加载 $code-review 执行独立审查；同时加载 $semantic-atlas-maintenance 处理该维护任务。",
          "gpt-5.6-sol",
        ],
      },
    ]);
  });

  it("uses the saved AI checkpoint and stable task identity for a scheduled resume", async () => {
    const gateway = new RecordingGateway();
    const dispatcher = createDispatcher(gateway, true, true);
    const reviewing = task({
      status: "reviewing",
      requestedAction: "review",
      currentExecution: {
        attemptId: "review_1",
        reportOpportunityId: "report_opportunity_review_1",
        action: "review",
        status: "waiting_for_resume",
        startedAt: timestamp,
        modelRouting: modelRouting(),
      },
    });

    const turn = await dispatcher.resumeScheduledTurn(
      request(reviewing),
      "thread_1",
      "Inspect build 42, retain the current worktree, and continue the review.",
    );

    expect(turn).toEqual({ status: "started", turnId: "turn_1" });
    expect(gateway.calls).toEqual([
      {
        method: "startTurn",
        args: [
          "thread_1",
          project.repositoryPath,
          expect.stringContaining("任务 task_1"),
          "gpt-5.6-sol",
        ],
      },
    ]);
    const prompt = String(gateway.calls[0]!.args[2]);
    expect(prompt).toContain("$codrive-task");
    expect(prompt).toContain("$code-review");
    expect(prompt).toContain("$semantic-atlas");
    expect(prompt).toContain(
      "Inspect build 42, retain the current worktree, and continue the review.",
    );
  });

  it("leaves task and report messages pending while the conversation is active", async () => {
    const gateway = new RecordingGateway();
    gateway.threadActive = true;
    const dispatcher = createDispatcher(gateway);
    const currentRequest = request(
      task({
        currentExecution: {
          attemptId: "attempt_2",
          reportOpportunityId: "report_opportunity_attempt_2",
          action: "work",
          status: "pending",
          startedAt: timestamp,
          modelRouting: modelRouting(),
          threadId: "thread_1",
        },
      }),
      { workThreadId: "thread_1" },
    );

    const taskTurn = await dispatcher.startTurn(currentRequest, "thread_1");
    const reportTurn = await dispatcher.requestReport(currentRequest, "thread_1");

    expect(taskTurn).toEqual({ status: "conversation_active" });
    expect(reportTurn).toEqual({ status: "conversation_active" });
    expect(gateway.calls).toEqual([]);
  });

  it("interrupts the active App Server turn when a task is cancelled", async () => {
    const gateway = new RecordingGateway();
    const dispatcher = createDispatcher(gateway);
    const active = task({
      currentExecution: {
        attemptId: "attempt_1",
        reportOpportunityId: "report_opportunity_attempt_1",
        action: "work",
        status: "running",
        startedAt: timestamp,
        modelRouting: modelRouting(),
        threadId: "thread_1",
        turnId: "turn_1",
      },
    });

    await dispatcher.interrupt(request(active));

    expect(gateway.calls).toEqual([
      { method: "interruptTurn", args: ["thread_1", "turn_1"] },
    ]);
  });
});
