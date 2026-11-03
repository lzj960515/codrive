import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SlackCodexGateway } from "../../src/application/slack-assistant.js";
import type { CodexThreadStatusReader } from "../../src/application/codex-gateway.js";
import { SlackIntegration } from "../../src/application/slack-integration.js";
import { SystemSettingsService } from "../../src/application/system-settings-service.js";
import { WorkflowEngine } from "../../src/application/workflow-engine.js";
import type { SlackChannel, SlackConfigureInput, SlackIncomingMessage, SlackReplyStream, SlackTransport } from "../../src/domain/slack.js";
import type { SlackReplyTarget, WorkSource } from "../../src/domain/work-source.js";
import { ConfigStore } from "../../src/infrastructure/config-store.js";
import { ProjectStore } from "../../src/infrastructure/project-store.js";
import { SlackStateStore } from "../../src/infrastructure/slack-state-store.js";
import { RecordingProjectExecutor, RecordingTaskDispatcher, TestRepositoryPathResolver, testModels } from "../support/recording-executors.js";

const credentials: SlackConfigureInput = {
  enabled: true, teamId: "T_owner", authorizedUserId: "U_owner",
  botToken: "xoxb-private-owner", appToken: "xapp-private-owner",
};

class TestSlack implements SlackTransport {
  readonly sent: Array<{ target: SlackReplyTarget; markdown: string }> = [];
  readonly channels = new Map<string, SlackChannel>([
    ["C_original", { id: "C_original", name: "原项目", isMember: true, isPrivate: false }],
    ["C_rebound", { id: "C_rebound", name: "新频道", isMember: true, isPrivate: true }],
    ["C_unjoined", { id: "C_unjoined", name: "尚未加入", isMember: false, isPrivate: false }],
    ["D_owner", { id: "D_owner", name: "私信", isMember: true, isPrivate: true }],
  ]);
  connectionError: Error | null = null;
  sendError: Error | null = null;
  sendCompletion: Promise<void> | null = null;
  stopped = false;

  async start(_onMessage: (message: SlackIncomingMessage) => Promise<void>): Promise<void> {
    if (this.connectionError) throw this.connectionError;
  }

  async stop(): Promise<void> { this.stopped = true; }

  async getChannel(id: string): Promise<SlackChannel> {
    const channel = this.channels.get(id);
    if (!channel) throw new Error("频道不存在");
    return channel;
  }

  async listChannels(): Promise<SlackChannel[]> { return [...this.channels.values()]; }
  async downloadFiles() { return []; }
  async sendFile() { return { id: "F_upload", name: "result.txt" }; }

  async sendMessage(target: SlackReplyTarget, markdown: string): Promise<{ messageTs: string }> {
    if (this.sendError) throw this.sendError;
    await this.sendCompletion;
    this.sent.push({ target, markdown });
    return { messageTs: `200.${String(this.sent.length).padStart(6, "0")}` };
  }

  async startReply(): Promise<SlackReplyStream> { throw new Error("本测试不运行普通 Codex 会话"); }
}

const codex: SlackCodexGateway & CodexThreadStatusReader = {
  startThread: async () => { throw new Error("本测试不发起开发或普通会话"); },
  resumeThread: async () => {},
  startTurn: async () => { throw new Error("本测试不发起回合"); },
  isThreadActive: async () => false,
  readTurnSnapshot: async () => ({ threadStatus: "idle", activeTurnIds: [], turn: null }),
  readTurnText: async () => "",
  readThreadRuntime: async (threadId) => ({ threadId, status: "idle", model: null, reasoningEffort: null, cwd: "", approvalPolicy: null, sandboxPolicy: null, tokenUsage: null }),
  onNotification: () => () => {},
};

describe("SlackIntegration", () => {
  let directory: string;
  let configStore: ConfigStore;
  let projects: ProjectStore;
  let state: SlackStateStore;
  let settings: SystemSettingsService;
  let slack: TestSlack;
  let integration: SlackIntegration;
  let errors: unknown[];
  let projectId: string;
  let otherProjectId: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "codrive-slack-integration-"));
    configStore = new ConfigStore(directory);
    await configStore.loadOrCreate();
    projects = new ProjectStore(directory);
    const project = await projects.createProject({
      name: "登录服务", repositoryPath: join(directory, "login"), defaultBranch: "main",
      productDocument: "# 登录服务\n", tasks: [],
    });
    projectId = project.project.id;
    const other = await projects.createProject({
      name: "数据服务", repositoryPath: join(directory, "data"), defaultBranch: "main",
      productDocument: "# 数据服务\n", tasks: [],
    });
    otherProjectId = other.project.id;
    const workflow = new WorkflowEngine(
      projects, new RecordingTaskDispatcher(), { maxConcurrentTasks: 4, models: testModels },
      new TestRepositoryPathResolver(), new RecordingProjectExecutor(),
    );
    settings = new SystemSettingsService(configStore, workflow, { listModels: async () => [] });
    state = new SlackStateStore(directory);
    errors = [];
    slack = new TestSlack();
    integration = createIntegration();
  });

  afterEach(async () => {
    await integration.stop();
    await rm(directory, { recursive: true, force: true });
  });

  function createIntegration() {
    return new SlackIntegration({
      configStore, projects, settings, state, codex,
      createTransport: () => slack,
      onError: (error) => errors.push(error),
    });
  }

  function report(requestId = "native-check") {
    return {
      projectId, requestId, markdown: "检查：提交登录。预期：进入首页。实际：仍停留登录页。",
      source: { kind: "codex_native", requestId } satisfies WorkSource,
    };
  }

  async function connectAndBind() {
    await integration.start();
    await integration.configure(credentials);
    await integration.bind({ projectId, channelId: "C_original" });
  }

  it("keeps a disabled installation configurable and exposes only credential-free status", async () => {
    await integration.start();
    expect(await integration.readStatus()).toMatchObject({
      enabled: false, configured: false, connected: false, lastError: null,
    });
    await integration.configure(credentials);
    const status = await integration.readStatus();
    expect(status).toMatchObject({ enabled: true, configured: true, connected: true, teamId: "T_owner", lastError: null });
    expect(JSON.stringify(status)).not.toContain(credentials.botToken);
    expect(JSON.stringify(status)).not.toContain(credentials.appToken);
    expect((await configStore.read()).slack?.botToken).toBe(credentials.botToken);
    expect(errors).toEqual([]);
  });

  it("keeps startup available on connection failure and reports explicit reconfiguration failure without secrets", async () => {
    await settings.configureSlack(credentials);
    slack.connectionError = new Error(`连接失败 ${credentials.botToken} ${credentials.appToken}`);
    await expect(integration.start()).resolves.toBeUndefined();
    const failedStatus = await integration.readStatus();
    expect(failedStatus).toMatchObject({ configured: true, connected: false, lastError: expect.stringContaining("连接失败") });
    expect(JSON.stringify(failedStatus)).not.toContain(credentials.botToken);
    expect(JSON.stringify(failedStatus)).not.toContain(credentials.appToken);
    await expect(integration.configure(credentials)).rejects.toThrow("连接失败");
    expect(errors).toHaveLength(2);
    expect(errors.map(String).join("\n")).not.toContain(credentials.botToken);
    expect(errors.map(String).join("\n")).not.toContain(credentials.appToken);
    slack.connectionError = null;
    await integration.configure(credentials);
    expect(await integration.readStatus()).toMatchObject({ connected: true, lastError: null });
  });

  it("binds an existing project only to a joined project channel and preserves configuration after rejection", async () => {
    await integration.configure(credentials);
    const binding = { projectId, channelId: "C_original" };
    expect(await integration.bind(binding)).toEqual(binding);
    for (const input of [
      { projectId: "project_missing", channelId: "C_rebound" },
      { projectId, channelId: "C_unjoined" },
      { projectId, channelId: "D_owner" },
    ]) await expect(integration.bind(input)).rejects.toThrow();
    expect((await integration.readStatus()).projectBindings).toEqual([binding]);
    expect((await projects.getProject(projectId))?.tasks).toEqual([]);
  });

  it("returns one actual report receipt across concurrent retries and freezes its destination after rebinding", async () => {
    await connectAndBind();
    const [first, repeated] = await Promise.all([integration.report(report()), integration.report(report())]);
    const originalTarget = { kind: "slack", teamId: "T_owner", channelId: "C_original", threadTs: "200.000001" };
    expect(first).toEqual({ requestId: "native-check", projectId, source: report().source, replyTarget: originalTarget, messageTs: "200.000001" });
    expect(repeated).toEqual(first);
    await integration.bind({ projectId, channelId: "C_rebound" });
    expect(await integration.report(report())).toEqual(first);
    expect(slack.sent).toHaveLength(1);
    expect(await state.getDelivery("report:native-check")).toMatchObject({ projectId, source: report().source, target: { kind: "slack", teamId: "T_owner", channelId: "C_original" }, sentAt: expect.any(String) });
    expect((await projects.getProject(projectId))?.tasks).toEqual([]);
    await integration.report(report("next-check"));
    expect(slack.sent[1]?.target.channelId).toBe("C_rebound");
  });

  it("rejects reusing a request for another project, source or report body", async () => {
    await connectAndBind();
    await integration.report(report());
    for (const changed of [
      { ...report(), projectId: otherProjectId },
      { ...report(), source: { kind: "slack", requestId: "native-check" } as const },
      { ...report(), markdown: "另一个报告" },
      { ...report(), source: { kind: "codex_native", requestId: "different-check" } as const },
    ]) await expect(integration.report(changed)).rejects.toThrow();
    expect(slack.sent).toHaveLength(1);
  });

  it("preserves a failed report for restart recovery and returns its original location after rebinding", async () => {
    await connectAndBind();
    slack.sendError = new Error("Slack 暂时不可用");
    await expect(integration.report(report())).rejects.toThrow("Slack 暂时不可用");
    expect(await state.getDelivery("report:native-check")).toMatchObject({ projectId, source: report().source, error: "Slack 暂时不可用" });
    expect((await state.getDelivery("report:native-check"))?.sentAt).toBeUndefined();
    expect((await projects.getProject(projectId))?.tasks).toEqual([]);
    await integration.bind({ projectId, channelId: "C_rebound" });
    await integration.stop();

    state = new SlackStateStore(directory);
    slack = new TestSlack();
    integration = createIntegration();
    await integration.start();
    const recovered = await integration.report(report());
    expect(recovered.replyTarget).toMatchObject({ channelId: "C_original", threadTs: "200.000001" });
    expect(slack.sent).toHaveLength(1);
    expect((await state.getDelivery("report:native-check"))?.sentAt).toEqual(expect.any(String));
  });

  it("does not claim delivery without a configured project destination", async () => {
    await integration.configure(credentials);
    await expect(integration.report(report())).rejects.toThrow();
    expect(slack.sent).toEqual([]);
    expect(await state.listDeliveries()).toEqual([]);
  });

  it("keeps a delivered report in its original workspace when the configured workspace changes", async () => {
    await connectAndBind();
    await integration.report(report());
    const original = await state.getDelivery("report:native-check");
    await integration.configure({ ...credentials, teamId: "T_replacement" });
    await expect(integration.report(report())).rejects.toThrow();
    expect(slack.sent).toHaveLength(1);
    expect(await state.getDelivery("report:native-check")).toEqual(original);
  });

  it("finishes an accepted report before disconnecting and reuses its receipt even when disabled", async () => {
    await connectAndBind();
    let release!: () => void;
    slack.sendCompletion = new Promise<void>((resolve) => { release = resolve; });
    const delivery = integration.report(report());
    await expect.poll(async () => Boolean(await state.getDelivery("report:native-check"))).toBe(true);
    const stopping = integration.stop();
    await Promise.resolve();
    expect(slack.stopped).toBe(false);
    release();
    const sent = await delivery;
    await stopping;
    expect(slack.stopped).toBe(true);
    await integration.configure({ ...credentials, enabled: false });
    expect(await integration.report(report())).toEqual(sent);
    expect(await integration.readStatus()).toMatchObject({ enabled: false, connected: false });
  });
});
