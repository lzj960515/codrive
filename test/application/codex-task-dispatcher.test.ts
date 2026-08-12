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

  async listModels(): Promise<[]> {
    return [];
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
    status: "developing",
    requestedAction: "develop",
    currentExecution: {
      attemptId: "attempt_1",
      action: "develop",
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
      reviewCount: 0,
      latestDecisionRequest: null,
      ...activity,
    },
  };
}

describe("CodexTaskDispatcher", () => {
  it("creates a development task and sends only its Skill reference", async () => {
    const gateway = new RecordingGateway();
    const dispatcher = new CodexTaskDispatcher(gateway);
    const currentRequest = request(task());

    const threadId = await dispatcher.openThread(currentRequest);
    const turn = await dispatcher.startTurn(currentRequest, threadId);

    expect({ threadId, turn }).toEqual({
      threadId: "thread_1",
      turn: { status: "started", turnId: "turn_1" },
    });
    expect(gateway.calls).toEqual([
      {
        method: "startThread",
        args: ["/workspace/game", "[Codrive] Tiny Game · Playable loop"],
      },
      {
        method: "startTurn",
        args: [
          "thread_1",
          "/workspace/game",
          "请使用 $codrive-task 处理任务 task_1 的当前阶段。",
          "gpt-5.6-sol",
        ],
      },
    ]);
  });

  it("keeps review, rework, and integration conversations attached to the project", async () => {
    const gateway = new RecordingGateway();
    const dispatcher = new CodexTaskDispatcher(gateway);
    const reviewing = task({
      status: "reviewing",
      requestedAction: "review",
      currentExecution: {
        attemptId: "review_1",
        action: "review",
        status: "pending",
        startedAt: timestamp,
        modelRouting: modelRouting(),
      },
    });
    const reworking = task({
      requestedAction: "rework",
      currentExecution: {
        attemptId: "rework_1",
        action: "rework",
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
        action: "integrate",
        status: "pending",
        startedAt: timestamp,
        modelRouting: modelRouting(),
      },
    });

    await dispatcher.openThread(request(reviewing, { developmentThreadId: "development_thread" }));
    await dispatcher.openThread(request(reworking, { developmentThreadId: "development_thread" }));
    await dispatcher.openThread(request(integrating, { developmentThreadId: "development_thread" }));

    expect(gateway.calls).toEqual([
      {
        method: "startThread",
        args: [
          project.repositoryPath,
          "[Codrive Review #1] Tiny Game · Playable loop",
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

  it("resumes a persisted execution under the project even when it has a worktree", async () => {
    const gateway = new RecordingGateway();
    const dispatcher = new CodexTaskDispatcher(gateway);
    const persisted = task({
      currentExecution: {
        attemptId: "attempt_1",
        action: "develop",
        status: "pending",
        startedAt: timestamp,
        modelRouting: modelRouting(),
        threadId: "persisted_thread",
      },
    });

    await dispatcher.openThread(request(persisted));

    expect(gateway.calls).toEqual([
      {
        method: "resumeThread",
        args: ["persisted_thread", "/workspace/game"],
      },
    ]);
  });

  it("starts task and report turns under the project while preserving the task worktree", async () => {
    const gateway = new RecordingGateway();
    const dispatcher = new CodexTaskDispatcher(gateway);
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

  it("leaves task and report messages pending while the conversation is active", async () => {
    const gateway = new RecordingGateway();
    gateway.threadActive = true;
    const dispatcher = new CodexTaskDispatcher(gateway);
    const currentRequest = request(
      task({
        currentExecution: {
          attemptId: "attempt_2",
          action: "rework",
          status: "pending",
          startedAt: timestamp,
          modelRouting: modelRouting(),
          threadId: "thread_1",
        },
      }),
      { developmentThreadId: "thread_1" },
    );

    const taskTurn = await dispatcher.startTurn(currentRequest, "thread_1");
    const reportTurn = await dispatcher.requestReport(currentRequest, "thread_1");

    expect(taskTurn).toEqual({ status: "conversation_active" });
    expect(reportTurn).toEqual({ status: "conversation_active" });
    expect(gateway.calls).toEqual([]);
  });

  it("interrupts the active App Server turn when a task is cancelled", async () => {
    const gateway = new RecordingGateway();
    const dispatcher = new CodexTaskDispatcher(gateway);
    const active = task({
      currentExecution: {
        attemptId: "attempt_1",
        action: "develop",
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
