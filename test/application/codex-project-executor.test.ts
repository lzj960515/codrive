import { describe, expect, it } from "vitest";

import type { CodexGateway } from "../../src/application/codex-gateway.js";
import { CodexProjectExecutor } from "../../src/application/codex-project-executor.js";
import type { Project } from "../../src/domain/types.js";

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

  async startTurn(
    threadId: string,
    cwd: string,
    prompt: string,
    model: string,
  ): Promise<string> {
    this.calls.push({ method: "startTurn", args: [threadId, cwd, prompt, model] });
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
        digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        changedAt: timestamp,
    },
    currentExecution: {
      attemptId: "project_attempt_1",
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

describe("CodexProjectExecutor", () => {
  it("runs task selection in a temporary Codex task", async () => {
    const gateway = new RecordingGateway();
    const executor = new CodexProjectExecutor(gateway);
    const current = project();

    const threadId = await executor.openThread(current);
    await executor.startTurn(current, threadId);

    expect(gateway.calls).toEqual([
      {
        method: "startThread",
        args: ["/workspace/game", "[Codrive Selection] Tiny Game", { ephemeral: true }],
      },
      {
        method: "startTurn",
        args: ["project_thread", "/workspace/game", "请使用 $codrive-task 为项目 project_1 选择当前适合开始的任务。", "gpt-5.6-sol"],
      },
    ]);
  });
});
