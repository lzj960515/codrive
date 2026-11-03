import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SlackStatus } from "../../src/application/slack-status.js";
import type { CodexThreadRuntimeStatus } from "../../src/application/codex-gateway.js";
import { ConfigStore } from "../../src/infrastructure/config-store.js";
import { ProjectStore } from "../../src/infrastructure/project-store.js";
import { SlackStateStore } from "../../src/infrastructure/slack-state-store.js";

const owner = { teamId: "T_owner", userId: "U_owner", channelId: "D_owner" };
const runtime: CodexThreadRuntimeStatus = {
  threadId: "native-dm", status: "idle", model: "actual-model", reasoningEffort: "high", cwd: "/workspace/project",
  approvalPolicy: "never", sandboxPolicy: "dangerFullAccess",
  tokenUsage: {
    total: { totalTokens: 500000, inputTokens: 450000, cachedInputTokens: 300000, cacheWriteInputTokens: 0, outputTokens: 50000, reasoningOutputTokens: 10000 },
    last: { totalTokens: 12300, inputTokens: 12000, cachedInputTokens: 11000, cacheWriteInputTokens: 0, outputTokens: 300, reasoningOutputTokens: 100 },
    modelContextWindow: 200000,
  },
};

describe("Slack 会话状态", () => {
  let directory: string;
  let configStore: ConfigStore;
  let projects: ProjectStore;
  let state: SlackStateStore;
  let status: SlackStatus;
  let requested: string[];
  let currentRuntime: CodexThreadRuntimeStatus;
  let projectId: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "codrive-slack-status-"));
    configStore = new ConfigStore(directory);
    const config = await configStore.loadOrCreate();
    projects = new ProjectStore(directory);
    const project = await projects.createProject({ name: "项目状态", repositoryPath: join(directory, "project"), defaultBranch: "main", productDocument: "# 项目状态\n", tasks: [] });
    projectId = project.project.id;
    await configStore.save({ ...config, slack: { enabled: true, teamId: owner.teamId, authorizedUserId: owner.userId, botToken: "fake", appToken: "fake", projectBindings: [{ projectId, channelId: "C_project" }] } });
    state = new SlackStateStore(directory);
    const now = "2026-11-03T05:00:00.000Z";
    for (const conversation of [
      { id: "dm-conversation", conversationType: "direct_message" as const, channelId: "D_owner", codexThreadId: "native-dm" },
      { id: "first-conversation", conversationType: "channel_thread" as const, channelId: "C_project", threadTs: "100.1", codexThreadId: "native-first", projectId },
      { id: "second-conversation", conversationType: "channel_thread" as const, channelId: "C_project", threadTs: "100.2", codexThreadId: "native-second", projectId },
      { id: "other-channel-conversation", conversationType: "channel_thread" as const, channelId: "C_other", threadTs: "100.3", codexThreadId: "native-other", projectId },
    ]) await state.saveConversation({ ...conversation, teamId: owner.teamId, createdAt: now, updatedAt: now });
    requested = [];
    currentRuntime = structuredClone(runtime);
    status = new SlackStatus({ configStore, projects, state, codex: { readThreadRuntime: async (threadId) => {
      requested.push(threadId);
      return { ...currentRuntime, threadId };
    } } });
  });

  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  it("私信读取唯一连续会话的真实状态，累计用量不冒充当前上下文占用", async () => {
    const result = await status.read(owner);
    expect(requested).toEqual(["native-dm"]);
    expect(result.conversations).toEqual([]);
    expect(result.text).toContain("实际模型：actual-model");
    expect(result.text).toContain("实际推理强度：high");
    expect(result.text).toContain("完全访问（dangerFullAccess）");
    expect(result.text).toContain("无需审批（never）");
    expect(result.text).toContain("累计 token：500,000");
    expect(result.text).toContain("最近一轮 token：12,300");
    expect(result.text).toContain("上下文窗口：200,000");
    expect(result.text).toContain("按最近一轮估算");
    expect(result.text).toContain("187,700");
  });

  it("频道命令列出已有会话供选择，不猜最近也不读取其他频道", async () => {
    const context = { ...owner, channelId: "C_project" };
    const menu = await status.read(context);
    expect(menu.conversations.map(({ id }) => id).sort()).toEqual(["first-conversation", "second-conversation"]);
    expect(requested).toEqual([]);
    await status.read({ ...context, conversationId: "first-conversation" });
    expect(requested).toEqual(["native-first"]);
    await expect(status.read({ ...context, conversationId: "other-channel-conversation" })).rejects.toThrow();
  });

  it("消息快捷操作按根消息精确读取，找不到会话时不回退到其他讨论串", async () => {
    await status.read({ ...owner, channelId: "C_project", threadTs: "100.2" });
    expect(requested).toEqual(["native-second"]);
    const missing = await status.read({ ...owner, channelId: "C_project", threadTs: "missing-thread" });
    expect(missing.text).toContain("尚未建立");
    expect(requested).toEqual(["native-second"]);
  });

  it("未收到真实用量或权限时显示暂无数据，同时区分下一回合默认配置", async () => {
    currentRuntime = { ...currentRuntime, tokenUsage: null, approvalPolicy: null, sandboxPolicy: null, reasoningEffort: null };
    const result = await status.read(owner);
    expect(result.text).toContain("token 用量：暂无数据");
    expect(result.text).toContain("权限：暂无实际快照");
    expect(result.text).toContain("审批：暂无实际快照");
    expect(result.text).toContain("下一回合默认");
    expect(result.text).not.toContain("0 token");
    expect(result.text).not.toContain("完全访问");
  });

  it("拒绝其他用户或工作区，读取不改变现有配置和会话", async () => {
    const before = await configStore.read();
    const conversations = await state.listConversations();
    for (const context of [{ ...owner, userId: "U_other" }, { ...owner, teamId: "T_other" }]) await expect(status.read(context)).rejects.toThrow();
    expect(requested).toEqual([]);
    await status.read(owner);
    expect(await configStore.read()).toEqual(before);
    expect(await state.listConversations()).toEqual(conversations);
  });
});
