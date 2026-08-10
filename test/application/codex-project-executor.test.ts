import { describe, expect, it } from "vitest";

import type { CodexGateway } from "../../src/application/codex-gateway.js";
import { CodexProjectExecutor } from "../../src/application/codex-project-executor.js";
import type { Project, ProjectAction } from "../../src/domain/types.js";

class RecordingGateway implements CodexGateway {
  calls: Array<{ method: string; args: unknown[] }> = [];

  async startThread(
    cwd: string,
    title: string,
    options?: { ephemeral?: boolean },
  ): Promise<string> {
    this.calls.push({ method: "startThread", args: [cwd, title, options] });
    return "project_thread";
  }

  async resumeThread(threadId: string, cwd: string): Promise<void> {
    this.calls.push({ method: "resumeThread", args: [threadId, cwd] });
  }

  async startTurn(threadId: string, cwd: string, prompt: string): Promise<string> {
    this.calls.push({ method: "startTurn", args: [threadId, cwd, prompt] });
    return "project_turn";
  }

  async interruptTurn(): Promise<void> {}
  async isThreadActive(): Promise<boolean> {
    return false;
  }
  async readTurnStatus(): Promise<null> {
    return null;
  }
}

const timestamp = "2026-08-03T00:00:00.000Z";

function project(action: ProjectAction): Project {
  return {
    id: "project_1",
    name: "Tiny Game",
    repositoryPath: "/workspace/game",
    defaultBranch: "main",
    status: action === "select_tasks" ? "active" : "evaluating",
    scheduling: "running",
    requestedAction: action,
    planning: {
      revision: 1,
      changedAt: timestamp,
      changeReason: "project_registered",
      concurrencyLimit: 4,
    },
    currentExecution: {
      attemptId: "project_attempt_1",
      action,
      status: "pending",
      startedAt: timestamp,
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

describe("CodexProjectExecutor", () => {
  it.each([
    {
      action: "select_tasks" as const,
      title: "[Codrive Selection] Tiny Game",
      prompt: "请使用 $codrive-task 为项目 project_1 选择当前适合开始的任务。",
    },
    {
      action: "evaluate_product" as const,
      title: "[Codrive Evaluation] Tiny Game",
      prompt: "请使用 $codrive-task 验收项目 project_1 的产品完成状态。",
    },
  ])("runs $action in a temporary Codex task", async ({ action, title, prompt }) => {
    const gateway = new RecordingGateway();
    const executor = new CodexProjectExecutor(gateway);
    const current = project(action);

    const threadId = await executor.openThread(current);
    await executor.startTurn(current, threadId);

    expect(gateway.calls).toEqual([
      {
        method: "startThread",
        args: ["/workspace/game", title, { ephemeral: true }],
      },
      {
        method: "startTurn",
        args: ["project_thread", "/workspace/game", prompt],
      },
    ]);
  });
});
