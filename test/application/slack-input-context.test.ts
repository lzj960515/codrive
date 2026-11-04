import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { SlackAssistant, type SlackCodexGateway } from "../../src/application/slack-assistant.js";
import { SlackDeliveryService } from "../../src/application/slack-delivery.js";
import type { SlackIncomingMessage, SlackTransport } from "../../src/domain/slack.js";
import { ConfigStore } from "../../src/infrastructure/config-store.js";
import { ProjectStore } from "../../src/infrastructure/project-store.js";
import { SlackStateStore } from "../../src/infrastructure/slack-state-store.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "codrive-slack-input-context-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const configStore = new ConfigStore(directory);
  const config = await configStore.loadOrCreate();
  const projects = new ProjectStore(directory);
  const repositoryPath = join(directory, "repository");
  await mkdir(repositoryPath);
  const { project } = await projects.createProject({ name: "当前项目", repositoryPath, defaultBranch: "main", productDocument: "# 当前项目", tasks: [] });
  await configStore.save({ ...config, slack: { enabled: true, teamId: "T1", authorizedUserId: "U1", botToken: "test-bot", appToken: "test-app", projectBindings: [{ projectId: project.id, channelId: "C1" }] } });
  const state = new SlackStateStore(directory);
  const events = new EventEmitter();
  let threadCount = 0;
  const turns: Array<{ threadId: string; turnId: string; prompt: string }> = [];
  const codex: SlackCodexGateway = {
    startThread: async () => `thread-${++threadCount}`,
    resumeThread: async () => {},
    isThreadActive: async () => false,
    startTurn: async (threadId, _cwd, prompt) => {
      const turnId = `turn-${turns.length + 1}`;
      turns.push({ threadId, turnId, prompt });
      return turnId;
    },
    readTurnSnapshot: async () => ({ threadStatus: "idle", activeTurnIds: [], turn: null }),
    readTurnText: async () => "处理完成。",
    onNotification: (listener) => { events.on("event", listener); return () => { events.off("event", listener); }; },
  };
  const transport: SlackTransport = {
    start: async () => {}, stop: async () => {},
    sendMessage: async () => ({ messageTs: "result.000" }),
    getChannel: async (id) => ({ id, name: id, isMember: true, isPrivate: false }),
    listChannels: async () => [],
    createChannel: async () => { throw new Error("本测试不创建频道"); },
    inviteToChannel: async () => {},
    startReply: async () => ({ appendText: () => {}, progress: () => {}, finish: async () => ({ messageTs: "result.000" }) }),
    downloadFiles: async () => [], sendFile: async () => ({ id: "file", name: "file" }),
  };
  const errors: unknown[] = [];
  const assistant = new SlackAssistant({ configStore, projects, state, codex, transport, deliveries: new SlackDeliveryService(state, transport, "T1"), onError: (error) => errors.push(error) });
  await assistant.start();
  cleanups.push(() => assistant.stop());
  function complete(index: number) {
    const turn = turns[index]!;
    events.emit("event", { method: "turn/completed", params: { threadId: turn.threadId, turn: { id: turn.turnId, status: "completed" } } });
  }
  return { assistant, state, configStore, project, turns, complete, errors };
}

function message(eventId: string, overrides: Partial<SlackIncomingMessage> = {}): SlackIncomingMessage {
  return { eventId, teamId: "T1", channelId: "C1", channelType: "channel", userId: "U1", text: "修复这个问题", messageTs: eventId, ...overrides };
}

describe("Slack 按需输入上下文", () => {
  it("同一仓库的并行讨论串按原生线程取得各自当前来源和回复位置", async () => {
    const f = await fixture();
    await f.assistant.receive(message("first"));
    await f.assistant.receive(message("second"));
    await expect.poll(() => f.turns.length).toBe(2);
    const first = await f.assistant.readContext(f.turns[0]!.threadId);
    const second = await f.assistant.readContext(f.turns[1]!.threadId);
    expect(first).toMatchObject({
      codexThreadId: f.turns[0]!.threadId, conversationType: "channel_thread",
      projectId: f.project.id, projectName: f.project.name, repositoryPath: f.project.repositoryPath,
      source: { kind: "slack", requestId: "first" },
      replyTarget: { kind: "slack", teamId: "T1", channelId: "C1", threadTs: "first" },
    });
    expect(second.source.requestId).toBe("second");
    expect(second.replyTarget.threadTs).toBe("second");
    expect(f.turns.map(({ prompt }) => prompt)).toEqual(["修复这个问题", "修复这个问题"]);
    expect(f.errors).toEqual([]);
  });

  it("排队追问使用正在执行的输入，结束后由下一轮接替，空闲时不返回旧输入", async () => {
    const f = await fixture();
    await f.assistant.receive(message("root"));
    await expect.poll(() => f.turns.length).toBe(1);
    await f.assistant.receive(message("follow-up", { threadTs: "root", text: "继续修复" }));
    expect((await f.assistant.readContext(f.turns[0]!.threadId)).source.requestId).toBe("root");
    f.complete(0);
    await expect.poll(() => f.turns.length).toBe(2);
    expect(await f.assistant.readContext(f.turns[1]!.threadId)).toMatchObject({ source: { requestId: "follow-up" }, replyTarget: { threadTs: "root" } });
    f.complete(1);
    await expect.poll(async () => (await f.state.getInput("follow-up"))?.status).toBe("completed");
    await expect(f.assistant.readContext(f.turns[1]!.threadId)).rejects.toThrow(/正在处理|执行中的/);
  });

  it("私信保持全局身份，新会话后旧原生线程和无关线程均不能取得上下文", async () => {
    const f = await fixture();
    await f.assistant.receive(message("direct", { channelId: "D1", channelType: "im" }));
    await expect.poll(() => f.turns.length).toBe(1);
    const oldThreadId = f.turns[0]!.threadId;
    expect(await f.assistant.readContext(oldThreadId)).toMatchObject({ projectId: null, projectName: null, repositoryPath: null, replyTarget: { channelId: "D1" } });
    f.complete(0);
    await expect.poll(async () => (await f.state.getInput("direct"))?.status).toBe("completed");
    await f.assistant.startNewConversation({ teamId: "T1", userId: "U1", channelId: "D1" });
    await expect(f.assistant.readContext(oldThreadId)).rejects.toThrow(/关联|正在处理/);
    await expect(f.assistant.readContext("unrelated-thread")).rejects.toThrow(/关联|正在处理/);
  });
});
