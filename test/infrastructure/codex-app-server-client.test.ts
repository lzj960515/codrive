import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CodexAppServerClient } from "../../src/infrastructure/codex-app-server-client.js";

describe("CodexAppServerClient", () => {
  it("names persistent task threads for Codex App visibility", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codrive-app-server-"));
    const tracePath = join(directory, "requests.ndjson");
    const executable = join(directory, "fake-codex.mjs");
    await writeFile(executable, fakeAppServer(tracePath), "utf8");
    await chmod(executable, 0o755);

    const client = new CodexAppServerClient({ executable });
    try {
      await client.startThread("/workspace/game", "Game task");
    } finally {
      await client.stop();
    }

    const requests = (await readFile(tracePath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { method: string; params: unknown });
    expect(requests.find(({ method }) => method === "thread/name/set")?.params).toEqual({
      threadId: "thread_1",
      name: "Game task",
    });
  });

  it("grants autonomous turns the Git and local API access required by Codrive", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codrive-app-server-"));
    const tracePath = join(directory, "requests.ndjson");
    const executable = join(directory, "fake-codex.mjs");
    await writeFile(executable, fakeAppServer(tracePath), "utf8");
    await chmod(executable, 0o755);

    const client = new CodexAppServerClient({ executable });
    try {
      const threadId = await client.startThread("/workspace/game", "Game task", {
        ephemeral: true,
      });
      await client.resumeThread(threadId, "/workspace/game/.worktrees/task");
      const turnId = await client.startTurn(
        threadId,
        "/workspace/game/.worktrees/task",
        "请使用 $codrive-task 处理任务 task_1 的当前阶段。",
        "gpt-5.6-sol",
      );
      await expect(client.listModels()).resolves.toEqual([
        {
          id: "gpt-5.6-sol",
          displayName: "GPT-5.6-Sol",
          description: "Frontier coding model",
          isDefault: true,
        },
        {
          id: "gpt-5.6-terra",
          displayName: "GPT-5.6-Terra",
          description: "Balanced coding model",
          isDefault: false,
        },
      ]);
      await expect(client.listHooks(["/workspace/game"])).resolves.toEqual([
        {
          eventName: "preToolUse",
          command: 'node "/home/user/.codex/hooks/codrive/codrive-activity-hook.mjs"',
          statusMessage: "Reporting Codrive activity",
          enabled: true,
          trustStatus: "trusted",
        },
      ]);
      await expect(client.isThreadActive(threadId)).resolves.toBe(true);
      await expect(client.readTurnStatus(threadId, turnId)).resolves.toBe(
        "inProgress",
      );
      await expect(client.readTurnSnapshot(threadId, turnId)).resolves.toEqual({
        threadStatus: "active",
        activeTurnIds: ["turn_1"],
        turn: {
          id: "turn_1",
          status: "inProgress",
          items: [{ type: "fileChange", status: "inProgress" }],
        },
      });
      for (const status of ["completed", "interrupted", "failed"] as const) {
        await expect(
          client.readTurnSnapshot(threadId, `turn_${status}`),
        ).resolves.toMatchObject({
          threadStatus: "active",
          activeTurnIds: ["turn_1"],
          turn: { id: `turn_${status}`, status },
        });
      }
      await expect(
        client.readTurnSnapshot(threadId, "turn_missing"),
      ).resolves.toMatchObject({ turn: null });
      await expect(
        client.readTurnSnapshot("thread_not_loaded", "turn_completed"),
      ).resolves.toEqual({
        threadStatus: "notLoaded",
        activeTurnIds: [],
        turn: {
          id: "turn_completed",
          status: "completed",
          items: [],
        },
      });
      await client.interruptTurn(threadId, turnId);
    } finally {
      await client.stop();
    }

    const requests = (await readFile(tracePath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { method: string; params: unknown });
    const startThread = requests.find(({ method }) => method === "thread/start");
    const setThreadName = requests.find(({ method }) => method === "thread/name/set");
    const resumeThread = requests.find(({ method }) => method === "thread/resume");
    const startTurn = requests.find(({ method }) => method === "turn/start");
    const interruptTurn = requests.find(({ method }) => method === "turn/interrupt");
    const readThreads = requests.filter(({ method }) => method === "thread/read");

    expect(startThread?.params).toMatchObject({
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      ephemeral: true,
    });
    expect(setThreadName).toBeUndefined();
    expect(resumeThread?.params).toMatchObject({
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
    expect(startTurn?.params).toMatchObject({
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
      model: "gpt-5.6-sol",
    });
    expect(
      requests
        .filter(({ method }) => method === "model/list")
        .map(({ params }) => params),
    ).toEqual([
      { includeHidden: false },
      { includeHidden: false, cursor: "page_2" },
    ]);
    expect(requests.find(({ method }) => method === "hooks/list")?.params).toEqual({
      cwds: ["/workspace/game"],
    });
    expect(interruptTurn?.params).toEqual({
      threadId: "thread_1",
      turnId: "turn_1",
    });
    expect(readThreads.map(({ params }) => params)).toEqual([
      { threadId: "thread_1" },
      { threadId: "thread_1", includeTurns: true },
      { threadId: "thread_1", includeTurns: true },
      { threadId: "thread_1", includeTurns: true },
      { threadId: "thread_1", includeTurns: true },
      { threadId: "thread_1", includeTurns: true },
      { threadId: "thread_1", includeTurns: true },
      { threadId: "thread_not_loaded", includeTurns: true },
    ]);
  });
});

function fakeAppServer(tracePath: string): string {
  return `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const tracePath = ${JSON.stringify(tracePath)};
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  const request = JSON.parse(line);
  appendFileSync(tracePath, JSON.stringify(request) + "\\n");
  if (!("id" in request)) return;

  let result = {};
  if (request.method === "thread/start") result = { thread: { id: "thread_1" } };
  if (request.method === "thread/resume") result = { thread: { id: request.params.threadId } };
  if (request.method === "turn/start") result = { turn: { id: "turn_1" } };
  if (request.method === "model/list") result = request.params.cursor === "page_2"
    ? {
        data: [
          { id: "gpt-5.6-terra", model: "gpt-5.6-terra", displayName: "GPT-5.6-Terra", description: "Balanced coding model", hidden: false, isDefault: false }
        ],
        nextCursor: null
      }
    : {
        data: [
          { id: "gpt-5.6-sol", model: "gpt-5.6-sol", displayName: "GPT-5.6-Sol", description: "Frontier coding model", hidden: false, isDefault: true }
        ],
        nextCursor: "page_2"
      };
  if (request.method === "hooks/list") result = { data: [{ cwd: request.params.cwds[0], warnings: [], errors: [], hooks: [{ eventName: "preToolUse", command: "node \\\"/home/user/.codex/hooks/codrive/codrive-activity-hook.mjs\\\"", statusMessage: "Reporting Codrive activity", enabled: true, trustStatus: "trusted" }] }] };
  if (request.method === "thread/read") result = request.params.threadId === "thread_not_loaded"
    ? { thread: { status: { type: "notLoaded" }, turns: [
        { id: "turn_completed", status: "completed", startedAt: 1786841900, completedAt: 1786841950, items: [] }
      ] } }
    : { thread: { status: { type: "active", activeFlags: [] }, turns: [
        { id: "turn_1", status: "inProgress", startedAt: 1786842000, completedAt: null, items: [{ type: "fileChange", id: "item_1", changes: [{ path: "SECRET_PATH" }], status: "inProgress" }] },
        { id: "turn_completed", status: "completed", startedAt: 1786841900, completedAt: 1786841950, items: [] },
        { id: "turn_interrupted", status: "interrupted", startedAt: 1786841800, completedAt: 1786841850, items: [] },
        { id: "turn_failed", status: "failed", startedAt: 1786841700, completedAt: 1786841750, items: [] }
      ] } };
  process.stdout.write(JSON.stringify({ id: request.id, result }) + "\\n");
  if (request.method === "thread/start") {
    process.stdout.write(JSON.stringify({ method: "item/started", params: { threadId: "thread_1", turnId: "turn_1", startedAtMs: 1786842001000, item: { type: "commandExecution", id: "item_search", command: "SECRET_QUERY", commandActions: [{ type: "search", command: "SECRET_QUERY", query: "SECRET_QUERY", path: "/workspace" }] } } }) + "\\n");
    process.stdout.write(JSON.stringify({ method: "item/started", params: { threadId: "thread_1", turnId: "turn_1", startedAtMs: 1786842002000, item: { type: "commandExecution", id: "item_test", command: "pnpm test -- SECRET_SUITE", commandActions: [] } } }) + "\\n");
  }
});
`;
}
