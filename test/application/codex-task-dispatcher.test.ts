import { describe, expect, it } from "vitest";

import { CodexTaskDispatcher } from "../../src/application/codex-task-dispatcher.js";
import type { CodexGateway } from "../../src/application/codex-gateway.js";
import type { Project, Task } from "../../src/domain/types.js";

class RecordingGateway implements CodexGateway {
  calls: Array<{ method: string; args: unknown[] }> = [];
  thread = 0;
  turn = 0;

  async startThread(cwd: string, title: string): Promise<string> {
    this.calls.push({ method: "startThread", args: [cwd, title] });
    return `thread_${++this.thread}`;
  }

  async resumeThread(threadId: string, cwd: string): Promise<void> {
    this.calls.push({ method: "resumeThread", args: [threadId, cwd] });
  }

  async startTurn(threadId: string, cwd: string, prompt: string): Promise<string> {
    this.calls.push({ method: "startTurn", args: [threadId, cwd, prompt] });
    return `turn_${++this.turn}`;
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    this.calls.push({ method: "interruptTurn", args: [threadId, turnId] });
  }

  async readTurnStatus(): Promise<null> {
    return null;
  }
}

const timestamp = "2026-08-03T00:00:00.000Z";
const project: Project = {
  id: "project_1",
  name: "Tiny Game",
  repositoryPath: "/workspace/game",
  defaultBranch: "main",
  status: "active",
  scheduling: "running",
  requestedAction: null,
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
    reviewAttempts: [],
    currentExecution: {
      attemptId: "attempt_1",
      action: "develop",
      status: "pending",
      startedAt: timestamp,
    },
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

describe("CodexTaskDispatcher", () => {
  it("creates a development task and sends only its Skill reference", async () => {
    const gateway = new RecordingGateway();
    const dispatcher = new CodexTaskDispatcher(gateway);
    const request = { project, task: task() };

    const threadId = await dispatcher.openThread(request);
    const turnId = await dispatcher.startTurn(request, threadId);

    expect({ threadId, turnId }).toEqual({
      threadId: "thread_1",
      turnId: "turn_1",
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
        ],
      },
    ]);
  });

  it("creates every review in a fresh thread and resumes development for rework", async () => {
    const gateway = new RecordingGateway();
    const dispatcher = new CodexTaskDispatcher(gateway);
    const workspacePath = "/workspace/game/.worktrees/task_1";
    const reviewing = task({
      status: "reviewing",
      requestedAction: "review",
      developmentThreadId: "development_thread",
      workspacePath,
      currentExecution: {
        attemptId: "review_1",
        action: "review",
        status: "pending",
        startedAt: timestamp,
      },
      reviewAttempts: [{ attemptId: "review_1", createdAt: timestamp }],
    });
    const reworking = task({
      requestedAction: "rework",
      developmentThreadId: "development_thread",
      workspacePath,
      currentExecution: {
        attemptId: "rework_1",
        action: "rework",
        status: "pending",
        startedAt: timestamp,
      },
    });

    await dispatcher.openThread({ project, task: reviewing });
    await dispatcher.openThread({ project, task: reworking });

    expect(gateway.calls).toEqual([
      {
        method: "startThread",
        args: [
          workspacePath,
          "[Codrive Review #1] Tiny Game · Playable loop",
        ],
      },
      {
        method: "resumeThread",
        args: ["development_thread", workspacePath],
      },
    ]);
  });

  it("resumes an execution whose thread ID was already persisted", async () => {
    const gateway = new RecordingGateway();
    const dispatcher = new CodexTaskDispatcher(gateway);
    const persisted = task({
      currentExecution: {
        attemptId: "attempt_1",
        action: "develop",
        status: "pending",
        startedAt: timestamp,
        threadId: "persisted_thread",
      },
    });

    await dispatcher.openThread({ project, task: persisted });

    expect(gateway.calls).toEqual([
      {
        method: "resumeThread",
        args: ["persisted_thread", "/workspace/game"],
      },
    ]);
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
        threadId: "thread_1",
        turnId: "turn_1",
      },
    });

    await dispatcher.interrupt({ project, task: active });

    expect(gateway.calls).toEqual([
      { method: "interruptTurn", args: ["thread_1", "turn_1"] },
    ]);
  });
});
