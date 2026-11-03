import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
import { createHttpServer } from "../../src/interfaces/http/server.js";
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
  readonly createdChannels: Array<{ name: string; isPrivate: boolean }> = [];
  readonly channelInvites: Array<{ channelId: string; userId: string }> = [];
  createError: Error | null = null;
  inviteError: Error | null = null;
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

  async createChannel(input: { name: string; isPrivate: boolean }): Promise<SlackChannel> {
    this.createdChannels.push(input);
    if (this.createError) throw this.createError;
    const channel = { id: `C_created_${this.createdChannels.length}`, ...input, isMember: true };
    this.channels.set(channel.id, channel);
    return channel;
  }

  async inviteToChannel(channelId: string, userId: string): Promise<void> {
    this.channelInvites.push({ channelId, userId });
    if (this.inviteError) throw this.inviteError;
  }

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

  it("creates the project channel, invites the configured owner and saves the actual binding", async () => {
    await integration.configure(credentials);
    const result = await integration.createProjectChannel({ projectId, name: "login-service" });
    expect(result).toEqual({
      channel: { id: "C_created_1", name: "login-service", isPrivate: false, isMember: true },
      binding: { projectId, channelId: "C_created_1" },
      created: true, invitedUserId: "U_owner",
    });
    expect(slack.createdChannels).toEqual([{ name: "login-service", isPrivate: false }]);
    expect(slack.channelInvites).toEqual([{ channelId: "C_created_1", userId: "U_owner" }]);
    expect((await integration.readStatus()).projectBindings).toEqual([result.binding]);
    expect((await projects.getProject(projectId))?.tasks).toEqual([]);
  });

  it("verifies the local project and channel name before any remote side effect", async () => {
    await integration.configure(credentials);
    await expect(integration.createProjectChannel({ projectId: "project_missing", name: "missing" })).rejects.toThrow("项目不存在");
    await expect(integration.createProjectChannel({ projectId, name: "Not A Channel" })).rejects.toThrow("频道名");
    expect(slack.createdChannels).toEqual([]);
    expect(slack.channelInvites).toEqual([]);
    expect((await integration.readStatus()).projectBindings).toEqual([]);
  });

  it("reuses the same bound channel on repeat requests and accepts an owner already in the channel", async () => {
    await integration.configure(credentials);
    const first = await integration.createProjectChannel({ projectId, name: "login-service", isPrivate: true });
    slack.inviteError = platformError("already_in_channel");
    const repeated = await integration.createProjectChannel({ projectId, name: "login-service", isPrivate: true });
    expect(repeated).toEqual({ ...first, created: false });
    expect(slack.createdChannels).toHaveLength(1);
    expect((await integration.readStatus()).projectBindings).toEqual([first.binding]);
    await expect(integration.createProjectChannel({ projectId, name: "different-channel", isPrivate: true })).rejects.toThrow("已绑定");
    expect(slack.createdChannels).toHaveLength(1);
  });

  it("reports name_taken with visible candidates without inviting or rebinding another channel", async () => {
    await integration.configure(credentials);
    await integration.bind({ projectId: otherProjectId, channelId: "C_original" });
    slack.channels.set("C_matching", { id: "C_matching", name: "login-service", isPrivate: false, isMember: true });
    slack.createError = platformError("name_taken");
    await expect(integration.createProjectChannel({ projectId, name: "login-service" })).rejects.toMatchObject({
      details: {
        stage: "create", created: false, slackError: "name_taken",
        candidates: [{ id: "C_matching", name: "login-service", isPrivate: false, isMember: true }],
      },
    });
    expect(slack.createdChannels).toHaveLength(1);
    expect(slack.channelInvites).toEqual([]);
    expect((await integration.readStatus()).projectBindings).toEqual([{ projectId: otherProjectId, channelId: "C_original" }]);
  });

  it("preserves a created channel on invite failure and resumes explicitly without creating another one", async () => {
    await integration.configure(credentials);
    slack.inviteError = platformError("missing_scope");
    await expect(integration.createProjectChannel({ projectId, name: "private-login", isPrivate: true })).rejects.toMatchObject({
      details: {
        stage: "invite", created: true, requiredScope: "groups:write", slackError: "missing_scope",
        channel: { id: "C_created_1", name: "private-login", isPrivate: true },
      },
    });
    expect((await integration.readStatus()).projectBindings).toEqual([]);
    slack.inviteError = null;
    const resumed = await integration.createProjectChannel({ projectId, name: "private-login", isPrivate: true, channelId: "C_created_1" });
    expect(resumed).toMatchObject({ channel: { id: "C_created_1" }, created: false, invitedUserId: "U_owner" });
    expect(slack.createdChannels).toHaveLength(1);
    expect((await integration.readStatus()).projectBindings).toEqual([resumed.binding]);
  });

  it("names the Bot scope required for public creation without claiming that a channel exists", async () => {
    await integration.configure(credentials);
    slack.createError = platformError("missing_scope");
    await expect(integration.createProjectChannel({ projectId, name: "login-service" })).rejects.toMatchObject({
      message: expect.stringContaining("channels:manage"),
      details: { stage: "create", created: false, requiredScope: "channels:manage", slackError: "missing_scope" },
    });
    expect(slack.channelInvites).toEqual([]);
    expect((await integration.readStatus()).projectBindings).toEqual([]);
  });

  it("does not use explicit recovery to take a channel already bound to another project", async () => {
    await integration.configure(credentials);
    slack.channels.set("C_existing", { id: "C_existing", name: "login-service", isPrivate: false, isMember: true });
    await integration.bind({ projectId: otherProjectId, channelId: "C_existing" });
    await expect(integration.createProjectChannel({ projectId, name: "login-service", channelId: "C_existing" })).rejects.toThrow("其他项目");
    expect(slack.createdChannels).toEqual([]);
    expect(slack.channelInvites).toEqual([]);
    expect((await integration.readStatus()).projectBindings).toEqual([{ projectId: otherProjectId, channelId: "C_existing" }]);
  });

  it("preserves channel identity when saving the final binding fails", async () => {
    await integration.configure(credentials);
    vi.spyOn(settings, "bindSlackProject").mockRejectedValueOnce(new Error("配置暂时不可写"));
    await expect(integration.createProjectChannel({ projectId, name: "login-service" })).rejects.toMatchObject({
      details: { stage: "bind", created: true, channel: { id: "C_created_1" } },
    });
    expect(slack.channelInvites).toEqual([{ channelId: "C_created_1", userId: "U_owner" }]);
    expect((await integration.readStatus()).projectBindings).toEqual([]);
    await expect(integration.createProjectChannel({ projectId, name: "login-service", channelId: "C_created_1" })).resolves.toMatchObject({
      created: false, binding: { projectId, channelId: "C_created_1" },
    });
    expect(slack.createdChannels).toHaveLength(1);
  });

  it("returns a usable partial receipt from the command API and prevents choosing another invite recipient", async () => {
    await integration.configure(credentials);
    const workflow = new WorkflowEngine(
      projects, new RecordingTaskDispatcher(), { maxConcurrentTasks: 4, models: testModels },
      new TestRepositoryPathResolver(), new RecordingProjectExecutor(),
    );
    const server = createHttpServer({
      store: projects, workflow, settingsService: settings, slack: integration, accessToken: "local-test-token",
    });
    const payload = { projectId, name: "private-login", isPrivate: true };
    try {
      const rejected = await server.inject({
        method: "POST", url: "/api/commands", headers: { "x-codrive-token": "local-test-token" },
        payload: { type: "slack.create_project_channel", payload: { ...payload, userId: "U_other" } },
      });
      expect(rejected.statusCode).toBe(400);
      expect(slack.createdChannels).toEqual([]);
      slack.inviteError = platformError("missing_scope");
      const response = await server.inject({
        method: "POST", url: "/api/commands", headers: { "x-codrive-token": "local-test-token" },
        payload: { type: "slack.create_project_channel", payload },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        error: expect.stringContaining("groups:write"),
        details: { stage: "invite", created: true, requiredScope: "groups:write", channel: { id: "C_created_1" } },
      });
      expect(JSON.stringify(response.json())).not.toContain(credentials.botToken);
      expect((await integration.readStatus()).projectBindings).toEqual([]);
    } finally {
      await server.close();
    }
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

function platformError(error: string): Error {
  return Object.assign(new Error(error), { data: { error } });
}
