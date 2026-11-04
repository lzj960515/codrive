import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { SlackAssistant, type SlackCodexGateway } from "../../src/application/slack-assistant.js";
import { SlackDeliveryService } from "../../src/application/slack-delivery.js";
import type { SlackIncomingMessage, SlackReplyStream, SlackTransport } from "../../src/domain/slack.js";
import type { SlackReplyTarget } from "../../src/domain/work-source.js";
import type { LocalProjectCatalog } from "../../src/domain/local-projects.js";
import { ConfigStore } from "../../src/infrastructure/config-store.js";
import { ProjectStore } from "../../src/infrastructure/project-store.js";
import { SlackStateStore } from "../../src/infrastructure/slack-state-store.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

class TestCodex implements SlackCodexGateway {
  readonly events = new EventEmitter();
  readonly turns: Array<{ threadId: string; cwd: string; prompt: string }> = [];
  readonly threads: string[] = [];
  readonly activeThreads = new Set<string>();
  completeTurns = true;
  async startThread(): Promise<string> {
    const id = `thread-${this.threads.length + 1}`;
    this.threads.push(id);
    return id;
  }
  async resumeThread(): Promise<void> {}
  async isThreadActive(threadId: string): Promise<boolean> { return this.activeThreads.has(threadId); }
  async startTurn(threadId: string, cwd: string, prompt: string): Promise<string> {
    const id = `turn-${this.turns.length + 1}`;
    this.turns.push({ threadId, cwd, prompt });
    if (!this.completeTurns) return id;
    queueMicrotask(() => {
      this.events.emit("event", { method: "item/agentMessage/delta", params: { threadId, turnId: id, delta: "昨天访问量为 120。" } });
      this.events.emit("event", { method: "turn/completed", params: { threadId, turn: { id, status: "completed" } } });
    });
    return id;
  }
  async readTurnSnapshot() {
    return { threadStatus: "idle" as const, activeTurnIds: [], turn: { id: "turn-1", status: "completed" as const, items: [] } };
  }
  async readTurnText(): Promise<string> { return "昨天访问量为 120。"; }
  onNotification(listener: (event: { method: string; params?: unknown }) => void): () => void {
    this.events.on("event", listener);
    return () => { this.events.off("event", listener); };
  }
}

class TestSlack implements SlackTransport {
  readonly sent: Array<{ target: SlackReplyTarget; markdown: string }> = [];
  readonly downloads: Array<{ teamId: string; ids: string[] }> = [];
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async getChannel(id: string) { return { id, name: id, isMember: true, isPrivate: false }; }
  async listChannels() { return []; }
  async createChannel(): Promise<never> { throw new Error("本测试不创建频道"); }
  async inviteToChannel(): Promise<never> { throw new Error("本测试不邀请成员"); }
  async downloadFiles(teamId: string, files: import("../../src/domain/slack.js").SlackIncomingFile[]) {
    this.downloads.push({ teamId, ids: files.map(({ id }) => id) });
    return files.map(({ id, name, mimetype }) => ({ id, name: name ?? id, ...(mimetype ? { mimetype } : {}), path: `/local/slack-files/${id}/${name ?? id}` }));
  }
  async sendFile() { return { id: "uploaded", name: "result.txt" }; }
  async sendMessage(target: SlackReplyTarget, markdown: string) {
    this.sent.push({ target, markdown });
    return { messageTs: `${this.sent.length}.000` };
  }
  async startReply(target: SlackReplyTarget): Promise<SlackReplyStream> {
    let text = "";
    return {
      appendText: (delta) => { text += delta; },
      progress: () => {},
      finish: () => this.sendMessage(target, text),
    };
  }
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "codrive-slack-assistant-"));
  directories.push(directory);
  const configStore = new ConfigStore(directory);
  const config = await configStore.loadOrCreate();
  const projects = new ProjectStore(directory);
  await projects.initialize();
  const repositoryPath = join(directory, "repo");
  await mkdir(repositoryPath);
  const { project } = await projects.createProject({ name: "数据项目", repositoryPath, defaultBranch: "main", productDocument: "# 数据项目\n\n查询数据和维护现有功能。", tasks: [] });
  await configStore.save({ ...config, slack: { enabled: true, teamId: "T1", authorizedUserId: "U1", botToken: "secret-bot", appToken: "secret-app", projectBindings: [{ projectId: project.id, channelId: "C1" }] } });
  const state = new SlackStateStore(directory);
  await state.initialize();
  const codex = new TestCodex();
  const transport = new TestSlack();
  const errors: unknown[] = [];
  const localProjects: LocalProjectCatalog = { read: async () => ({ available: true, projects: [{ name: "本机工作空间", rootPaths: [repositoryPath] }] }) };
  const assistant = new SlackAssistant({ configStore, projects, state, codex, transport, localProjects, deliveries: new SlackDeliveryService(state, transport, "T1"), pendingDecisions: async () => [], onError: (error) => errors.push(error) });
  await assistant.start();
  return { directory, configStore, project, projects, state, codex, transport, assistant, errors, localProjects };
}

function message(eventId: string, overrides: Partial<SlackIncomingMessage> = {}): SlackIncomingMessage {
  return { eventId, teamId: "T1", channelId: "C1", channelType: "channel", userId: "U1", text: "查看昨天的数据", messageTs: eventId, ...overrides };
}

describe("Slack 普通会话", () => {
  it("接收无正文的图片和文件，授权后下载并将可读本机路径保存为文本上下文", async () => {
    const f = await fixture();
    const input = message("file-event", { text: "", files: [
      { id: "F_image", name: "screen.png", mimetype: "image/png", url_private_download: "https://files.slack.com/private-image" },
      { id: "F_data", name: "report.csv", mimetype: "text/csv", url_private_download: "https://files.slack.com/private-data" },
    ] });
    try {
      await f.assistant.receive({ ...input, eventId: "other-user-file", userId: "U2" });
      expect(f.transport.downloads).toEqual([]);
      await f.assistant.receive(input);
      await f.assistant.receive(input);
      await expect.poll(() => f.transport.sent.length).toBe(1);
      expect(f.transport.downloads).toEqual([{ teamId: "T1", ids: ["F_image", "F_data"] }]);
      expect(f.codex.turns[0]?.prompt).toContain("/local/slack-files/F_image/screen.png");
      expect(f.codex.turns[0]?.prompt).toContain("/local/slack-files/F_data/report.csv");
      const receipt = (await f.state.getInput(input.eventId))!;
      expect(receipt.message.files).toBeUndefined();
      expect(receipt.message.text).toContain("image/png");
      expect(JSON.stringify(receipt)).not.toContain("files.slack.com");
      expect((await f.projects.getProject(f.project.id))!.tasks).toEqual([]);
    } finally { await f.assistant.stop(); }
  });

  it("附件下载失败时向原串说明失败，保留已失败输入而不把空消息交给模型", async () => {
    const f = await fixture();
    f.transport.downloadFiles = async () => { throw new Error("文件下载暂时不可用"); };
    try {
      await f.assistant.receive(message("file-failed", { text: "", files: [{ id: "F_failed" }] }));
      await expect.poll(() => f.transport.sent.length).toBe(1);
      expect(f.transport.sent[0]?.markdown).toContain("文件下载暂时不可用");
      expect(f.transport.sent[0]?.target.threadTs).toBe("file-failed");
      expect(f.codex.turns).toEqual([]);
      expect((await f.state.getInput("file-failed"))?.status).toBe("failed");
    } finally { await f.assistant.stop(); }
  });

  it("频道无需艾特即可查询，同根追问连续、新根独立，结果不产生开发任务", async () => {
    const f = await fixture();
    try {
      await f.assistant.receive(message("1.000"));
      await expect.poll(() => f.transport.sent.length).toBe(1);
      await f.assistant.receive(message("2.000", { threadTs: "1.000", text: "再解释一下" }));
      await expect.poll(() => f.transport.sent.length).toBe(2);
      await f.assistant.receive(message("3.000"));
      await expect.poll(() => f.transport.sent.length).toBe(3);
      expect(f.codex.threads).toHaveLength(2);
      expect(f.codex.turns[0]?.threadId).toBe(f.codex.turns[1]?.threadId);
      expect(f.codex.turns[2]?.threadId).not.toBe(f.codex.turns[0]?.threadId);
      expect(f.transport.sent.map(({ target }) => target.threadTs)).toEqual(["1.000", "1.000", "3.000"]);
      expect(f.codex.turns.every(({ cwd }) => cwd === f.project.repositoryPath)).toBe(true);
      expect(f.codex.turns[0]?.prompt).toContain(`"projectName":"${f.project.name}"`);
      expect(f.codex.turns[0]?.prompt).toContain(`"repositoryPath":"${f.project.repositoryPath}"`);
      expect((await f.projects.getProject(f.project.id))?.tasks).toEqual([]);
      expect(f.errors).toEqual([]);
    } finally { await f.assistant.stop(); }
  });

  it("私信连续交流，排除其他用户、其他工作区、未绑定频道及重复事件", async () => {
    const f = await fixture();
    try {
      await f.assistant.receive(message("unauthorized", { userId: "U2" }));
      await f.assistant.receive(message("other-team", { teamId: "T2" }));
      await f.assistant.receive(message("unbound", { channelId: "C2" }));
      const first = message("dm-1", { channelId: "D1", channelType: "im", text: "列出项目" });
      await f.assistant.receive(first);
      await f.assistant.receive(first);
      await expect.poll(() => f.transport.sent.length).toBe(1);
      await f.assistant.receive(message("dm-2", { channelId: "D1", channelType: "im", text: "绑定这个项目" }));
      await expect.poll(() => f.transport.sent.length).toBe(2);
      expect(f.codex.threads).toHaveLength(1);
      const assistantDirectory = join(f.directory, "assistant");
      expect(f.codex.turns.every(({ cwd }) => cwd === assistantDirectory)).toBe(true);
      expect((await stat(assistantDirectory)).mode & 0o777).toBe(0o700);
      expect(f.codex.turns[0]?.prompt).toContain(`"workingDirectory":"${assistantDirectory}"`);
      expect(f.codex.turns[0]?.prompt).toContain('"repositoryPath":null');
      expect(f.codex.turns[0]?.prompt).toContain('"projectName":null');
      expect(f.transport.sent.every(({ target }) => target.channelId === "D1" && target.threadTs === undefined)).toBe(true);
      expect(f.errors).toEqual([]);
    } finally { await f.assistant.stop(); }
  });

  it("每轮全局私信分开提供本机工作空间与产品身份，不传任务或里程碑正文", async () => {
    const f = await fixture();
    const secret = "不应进入目录上下文的产品长正文";
    await f.projects.createProject({ name: "同目录业务产品", repositoryPath: f.project.repositoryPath, defaultBranch: "main", productDocument: `# 业务产品\n${secret}`, tasks: [], milestones: [{ title: "内部目标", description: secret, acceptanceCriteria: [secret] }] });
    try {
      await f.assistant.receive(message("catalog-1", { channelId: "D1", channelType: "im", text: "有哪些项目？" }));
      await expect.poll(() => f.transport.sent.length).toBe(1);
      expect(f.codex.turns[0]?.prompt).toContain('"localProjects":{"available":true');
      expect(f.codex.turns[0]?.prompt).toContain('"name":"本机工作空间"');
      expect(f.codex.turns[0]?.prompt).toContain('"codriveProjects":[');
      expect(f.codex.turns[0]?.prompt).toContain('"name":"同目录业务产品"');
      expect(f.codex.turns[0]?.prompt).not.toContain(secret);
      expect(f.codex.turns[0]?.prompt).toContain("AGENTS.md");
      f.localProjects.read = async () => ({ available: true, projects: [{ name: "新保存的工作空间", rootPaths: [f.project.repositoryPath] }] });
      await f.assistant.receive(message("catalog-2", { channelId: "D1", channelType: "im" }));
      await expect.poll(() => f.transport.sent.length).toBe(2);
      expect(f.codex.turns[1]?.prompt).toContain("新保存的工作空间");
      expect(f.codex.turns[1]?.prompt).not.toContain('"name":"本机工作空间"');
    } finally { await f.assistant.stop(); }
  });

  it("本机保存目录不可用时说明缺口并继续普通聊天", async () => {
    const f = await fixture();
    f.localProjects.read = async () => { throw new Error("桌面目录不可读"); };
    try {
      await f.assistant.receive(message("catalog-unavailable", { channelId: "D1", channelType: "im", text: "你好" }));
      await expect.poll(() => f.transport.sent.length).toBe(1);
      expect(f.codex.turns[0]?.prompt).toContain('"available":false');
      expect(f.transport.sent[0]?.markdown).toBe("昨天访问量为 120。");
      expect((await f.state.getInput("catalog-unavailable"))?.status).toBe("completed");
    } finally { await f.assistant.stop(); }
  });

  it("私信新会话切换原生thread，保留旧thread且后续消息使用新会话", async () => {
    const f = await fixture();
    try {
      await f.assistant.receive(message("before-new", { channelId: "D1", channelType: "im", text: "记住旧会话口令" }));
      await expect.poll(async () => (await f.state.getInput("before-new"))?.status).toBe("completed");
      const previous = f.codex.turns[0]!.threadId;
      const next = await f.assistant.startNewConversation({ teamId: "T1", userId: "U1", channelId: "D1" });
      expect(next.codexThreadId).not.toBe(previous);
      expect(f.codex.threads).toContain(previous);
      expect((await f.state.getConversation("T1:D1:direct"))?.codexThreadId).toBe(next.codexThreadId);
      await f.assistant.receive(message("after-new", { channelId: "D1", channelType: "im", text: "当前是什么会话？" }));
      await expect.poll(() => f.transport.sent.length).toBe(2);
      expect(f.codex.turns[1]?.threadId).toBe(next.codexThreadId);
      expect(f.codex.turns[1]?.prompt).not.toContain("旧会话口令");
      expect(f.codex.turns[1]?.cwd).toBe(join(f.directory, "assistant"));
      expect(f.codex.threads).toHaveLength(2);
    } finally { await f.assistant.stop(); }
  });

  it.each([
    { teamId: "T2", userId: "U1", channelId: "D1" },
    { teamId: "T1", userId: "U2", channelId: "D1" },
    { teamId: "T1", userId: "U1", channelId: "C1" },
  ])("拒绝非授权工作区、用户或频道执行私信新会话：%j", async (context) => {
    const f = await fixture();
    try {
      await expect(f.assistant.startNewConversation(context)).rejects.toThrow();
      expect(f.codex.threads).toEqual([]);
      expect(await f.state.listConversations()).toEqual([]);
    } finally { await f.assistant.stop(); }
  });

  it("私信执行中收到新会话命令时拒绝，避免切断在途结果", async () => {
    const f = await fixture();
    f.codex.completeTurns = false;
    try {
      await f.assistant.receive(message("in-flight", { channelId: "D1", channelType: "im" }));
      await expect.poll(() => f.codex.turns.length).toBe(1);
      await expect(f.assistant.startNewConversation({ teamId: "T1", userId: "U1", channelId: "D1" })).rejects.toThrow(/处理|执行|运行/);
      expect(f.codex.threads).toHaveLength(1);
    } finally { await f.assistant.stop(); }
  });

  it("保存的待处理输入或外部活跃native回合阻止新会话", async () => {
    const f = await fixture();
    try {
      await f.assistant.receive(message("before-busy", { channelId: "D1", channelType: "im" }));
      await expect.poll(async () => (await f.state.getInput("before-busy"))?.status).toBe("completed");
      const conversation = (await f.state.getConversation("T1:D1:direct"))!;
      f.codex.activeThreads.add(conversation.codexThreadId);
      await expect(f.assistant.startNewConversation({ teamId: "T1", userId: "U1", channelId: "D1" })).rejects.toThrow(/处理|执行|运行/);
      f.codex.activeThreads.clear();
      const receipt = (await f.state.getInput("before-busy"))!;
      await f.state.saveInput({ ...receipt, id: "saved-pending", status: "pending" });
      await expect(f.assistant.startNewConversation({ teamId: "T1", userId: "U1", channelId: "D1" })).rejects.toThrow(/处理|执行|运行/);
      expect(f.codex.threads).toHaveLength(1);
    } finally { await f.assistant.stop(); }
  });

  it("新回合返回前只接收属于该回合的回复，旧完成事件不会提前结束请求", async () => {
    const f = await fixture();
    f.codex.startTurn = async (threadId, cwd, prompt) => {
      f.codex.turns.push({ threadId, cwd, prompt });
      queueMicrotask(() => {
        f.codex.events.emit("event", { method: "item/agentMessage/delta", params: { threadId, turnId: "old-turn", itemId: "old", delta: "旧答案" } });
        f.codex.events.emit("event", { method: "turn/completed", params: { threadId, turn: { id: "old-turn", status: "completed" } } });
        f.codex.events.emit("event", { method: "item/agentMessage/delta", params: { threadId, turnId: "new-turn", itemId: "new", delta: "当前答案" } });
        f.codex.events.emit("event", { method: "turn/completed", params: { threadId, turn: { id: "new-turn", status: "completed" } } });
      });
      return "new-turn";
    };
    try {
      await f.assistant.receive(message("early-events"));
      await expect.poll(() => f.transport.sent.length).toBe(1);
      expect(f.transport.sent[0]?.markdown).toBe("当前答案");
      expect(f.errors).toEqual([]);
    } finally { await f.assistant.stop(); }
  });

  it("已有进展文字时仍保留没有增量事件的完整最终答案", async () => {
    const f = await fixture();
    f.codex.startTurn = async (threadId, cwd, prompt) => {
      f.codex.turns.push({ threadId, cwd, prompt });
      queueMicrotask(() => {
        f.codex.events.emit("event", { method: "item/agentMessage/delta", params: { threadId, turnId: "turn-1", itemId: "comment", delta: "正在查询。" } });
        f.codex.events.emit("event", { method: "item/completed", params: { threadId, turnId: "turn-1", item: { id: "final", type: "agentMessage", text: "最终报告：访问量为120。" } } });
        f.codex.events.emit("event", { method: "turn/completed", params: { threadId, turn: { id: "turn-1", status: "completed" } } });
      });
      return "turn-1";
    };
    try {
      await f.assistant.receive(message("multipart"));
      await expect.poll(() => f.transport.sent.length).toBe(1);
      expect(f.transport.sent[0]?.markdown).toBe("正在查询。\n\n最终报告：访问量为120。");
    } finally { await f.assistant.stop(); }
  });

  it("重启恢复沿用已登记的最终正文，不因重建文本不同重复发送或丢失回执", async () => {
    const f = await fixture();
    try {
      await f.assistant.receive(message("recovery"));
      await expect.poll(async () => (await f.state.getInput("recovery"))?.status).toBe("completed");
      await f.assistant.stop();
      const receipt = (await f.state.getInput("recovery"))!;
      const interrupted = { ...receipt, status: "running" as const };
      delete interrupted.replyText;
      await f.state.saveInput(interrupted);
      f.codex.readTurnText = async () => "重建后分段不同的正文";
      await f.assistant.start();
      expect(f.transport.sent).toHaveLength(1);
      expect(f.errors).toEqual([]);
      expect((await f.state.getInput("recovery"))?.status).toBe("completed");
    } finally { await f.assistant.stop(); }
  });
});
