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
      );
      await expect(client.isThreadActive(threadId)).resolves.toBe(true);
      await expect(client.readTurnStatus(threadId, turnId)).resolves.toBe(
        "inProgress",
      );
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
    });
    expect(interruptTurn?.params).toEqual({
      threadId: "thread_1",
      turnId: "turn_1",
    });
    expect(readThreads.map(({ params }) => params)).toEqual([
      { threadId: "thread_1" },
      { threadId: "thread_1", includeTurns: true },
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
  if (request.method === "thread/read") result = { thread: { status: { type: "active", activeFlags: [] }, turns: [{ id: "turn_1", status: "inProgress" }] } };
  process.stdout.write(JSON.stringify({ id: request.id, result }) + "\\n");
});
`;
}
