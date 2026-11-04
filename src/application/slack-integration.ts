import { isDeepStrictEqual } from "node:util";

import { WorkflowConflictError } from "../domain/errors.js";
import {
  SlackProjectChannelError,
  type SlackChannel,
  type SlackConfig,
  type SlackConfigureInput,
  type SlackCreateProjectChannelInput,
  type SlackIncomingMessage,
  type SlackProjectBinding,
  type SlackProjectBindingStatus,
  type SlackProjectChannelFailure,
  type SlackProjectChannelResult,
  type SlackTransport,
} from "../domain/slack.js";
import type { SlackDeliveryRecord } from "../domain/slack-state.js";
import { isSlackReplyTarget, isWorkSource, type SlackReplyTarget, type WorkSource } from "../domain/work-source.js";
import type { ConfigStore } from "../infrastructure/config-store.js";
import type { ProjectStore } from "../infrastructure/project-store.js";
import type { SlackStateStore } from "../infrastructure/slack-state-store.js";
import { SlackAssistant, type SlackCodexGateway } from "./slack-assistant.js";
import { SlackDeliveryService } from "./slack-delivery.js";
import { SlackNotifications } from "./slack-notifications.js";
import { SlackModelCommands } from "./slack-model-commands.js";
import { SlackStatus } from "./slack-status.js";
import type { CodexThreadStatusReader } from "./codex-gateway.js";
import type { SystemSettingsService } from "./system-settings-service.js";
import type { LocalProjectCatalog } from "../domain/local-projects.js";

interface SlackIntegrationOptions {
  configStore: ConfigStore;
  settings: SystemSettingsService;
  projects: ProjectStore;
  state: SlackStateStore;
  codex: SlackCodexGateway & CodexThreadStatusReader;
  localProjects: LocalProjectCatalog;
  createTransport(config: SlackConfig): SlackTransport;
  onError(error: unknown): void;
}

interface SlackRuntime {
  config: SlackConfig;
  transport: SlackTransport;
  deliveries: SlackDeliveryService;
  assistant: SlackAssistant;
  notifications: SlackNotifications;
  connected: boolean;
  accepting: boolean;
}

interface SlackReportInput {
  projectId: string;
  requestId: string;
  markdown: string;
  source: WorkSource;
}

/** 统一拥有 Slack 连接、普通会话、业务通知与发送恢复的生命周期。 */
export class SlackIntegration {
  private runtime: SlackRuntime | null = null;
  private lastConnectionError: string | null = null;
  private lifecycle: Promise<void> = Promise.resolve();
  private retryTimer: ReturnType<typeof setInterval> | null = null;
  private flushing: Promise<void> | null = null;
  private readonly incoming = new Set<Promise<unknown>>();
  private readonly reports = new Map<string, Promise<SlackDeliveryRecord>>();

  constructor(private readonly options: SlackIntegrationOptions) {}

  start(): Promise<void> {
    return this.changeLifecycle(async () => {
      if (this.runtime) return;
      const { slack } = await this.options.configStore.read();
      if (!slack?.enabled) return;
      // 接入故障不应阻止本机 HTTP 与既有开发工作流启动。
      try {
        await this.connect(slack);
      } catch {
        // connect 已保存脱敏错误并完整释放本次接入资源。
      }
    });
  }

  stop(): Promise<void> {
    return this.changeLifecycle(() => this.disconnect());
  }

  async readStatus() {
    return {
      ...await this.options.settings.readSlack(),
      connected: this.runtime?.connected ?? false,
      lastError: this.lastConnectionError,
    };
  }

  configure(input: SlackConfigureInput) {
    return this.changeLifecycle(async () => {
      await this.options.settings.configureSlack(input);
      await this.disconnect();
      this.lastConnectionError = null;
      const { slack } = await this.options.configStore.read();
      // 显式配置请求必须得到真实连接结果，失败由 HTTP 调用方处理。
      if (slack?.enabled) await this.connect(slack);
      return this.readStatus();
    });
  }

  bind(input: SlackProjectBinding): Promise<SlackProjectBinding> {
    return this.changeLifecycle(async () => {
      const projectId = input.projectId.trim();
      const channelId = input.channelId.trim();
      if (!await this.options.projects.getProject(projectId)) {
        throw new WorkflowConflictError("项目不存在，请先登记项目。");
      }
      const runtime = this.requireConnection();
      const channel = await runtime.transport.getChannel(channelId);
      return this.bindProjectChannel(projectId, channel);
    });
  }

  createProjectChannel(input: SlackCreateProjectChannelInput): Promise<SlackProjectChannelResult> {
    return this.changeLifecycle(async () => {
      const projectId = input.projectId.trim();
      if (!await this.options.projects.getProject(projectId)) {
        throw new WorkflowConflictError("项目不存在，请先登记项目。");
      }
      const name = input.name.trim();
      if (!/^(?=.*[a-z0-9])[a-z0-9_-]{1,80}$/.test(name)) {
        throw new WorkflowConflictError("频道名需要包含小写字母或数字，只使用小写字母、数字、连字符和下划线，长度不超过 80。");
      }
      const runtime = this.requireConnection();
      const isPrivate = input.isPrivate ?? false;
      const { channel, created } = await this.resolveProjectChannel(projectId, name, isPrivate, input.channelId, runtime);
      try {
        await runtime.transport.inviteToChannel(channel.id, runtime.config.authorizedUserId);
      } catch (error) {
        if (slackErrorCode(error) !== "already_in_channel") {
          throw this.projectChannelFailure(error, runtime, {
            stage: "invite", created, channel,
          }, isPrivate);
        }
      }
      let binding: SlackProjectBinding;
      try {
        binding = await this.bindProjectChannel(projectId, channel);
      } catch (error) {
        throw this.projectChannelFailure(error, runtime, {
          stage: "bind", created, channel,
        }, isPrivate);
      }
      return { channel, binding, created, invitedUserId: runtime.config.authorizedUserId };
    });
  }

  async report(input: SlackReportInput) {
    if (!input.requestId.trim() || !isWorkSource(input.source) || input.source.requestId !== input.requestId) {
      throw new WorkflowConflictError("报告来源必须使用本次报告的请求身份。");
    }
    const id = `report:${input.requestId}`;
    const previous = this.reports.get(id);
    const operation = (previous ? previous.catch(() => undefined) : Promise.resolve())
      .then(() => this.deliverReport(id, input));
    this.reports.set(id, operation);
    let delivery: SlackDeliveryRecord;
    try {
      delivery = await operation;
    } finally {
      if (this.reports.get(id) === operation) this.reports.delete(id);
    }
    if (!delivery.sentAt || !delivery.messageTs) {
      throw new Error("Slack 尚未确认本次报告的消息位置。");
    }
    return {
      requestId: input.requestId,
      projectId: delivery.projectId!,
      source: delivery.source!,
      replyTarget: { ...delivery.target, threadTs: delivery.target.threadTs ?? delivery.messageTs },
      messageTs: delivery.messageTs,
    };
  }

  async listChannels() {
    return this.requireConnection().transport.listChannels();
  }

  readLocalProjects() {
    return this.options.localProjects.read();
  }

  async readProjectBinding(projectId: string): Promise<SlackProjectBindingStatus> {
    const { slack } = await this.options.configStore.read();
    const binding = slack?.projectBindings.find((entry) => entry.projectId === projectId) ?? null;
    const runtime = this.runtime;
    let channel: SlackChannel | null = null;
    if (binding && runtime?.connected) {
      try {
        channel = await runtime.transport.getChannel(binding.channelId);
      } catch (error) {
        // 频道详情暂不可读时，仍展示已保存的绑定身份。
        this.recordError(error, runtime.config);
      }
    }
    return { binding, channel, teamId: slack?.teamId ?? null };
  }

  async sendFile(input: { replyTarget: SlackReplyTarget; filePath: string; title?: string; comment?: string }) {
    const runtime = this.requireConnection();
    if (!isSlackReplyTarget(input.replyTarget) || input.replyTarget.teamId !== runtime.config.teamId) {
      throw new WorkflowConflictError("文件发送位置必须属于当前 Slack 工作区。");
    }
    const operation = runtime.transport.sendFile(input.replyTarget, {
      filePath: input.filePath,
      ...(input.title ? { title: input.title } : {}),
      ...(input.comment ? { comment: input.comment } : {}),
    });
    this.incoming.add(operation);
    try {
      return await operation;
    } catch (error) {
      throw this.recordError(error, runtime.config);
    } finally {
      this.incoming.delete(operation);
    }
  }

  private async resolveProjectChannel(
    projectId: string,
    name: string,
    isPrivate: boolean,
    requestedChannelId: string | undefined,
    runtime: SlackRuntime,
  ): Promise<{ channel: SlackChannel; created: boolean }> {
    const { slack } = await this.options.configStore.read();
    const bindings = slack?.projectBindings ?? [];
    const existing = bindings.find((binding) => binding.projectId === projectId);
    const channelId = requestedChannelId?.trim() || existing?.channelId;
    if (existing && channelId !== existing.channelId) {
      throw new WorkflowConflictError(`项目已绑定频道 ${existing.channelId}；需要改绑时请使用已有绑定命令。`);
    }
    if (channelId) {
      if (bindings.some((binding) => binding.channelId === channelId && binding.projectId !== projectId)) {
        throw new WorkflowConflictError("该频道已绑定其他项目，请核实频道归属后再操作。");
      }
      const channel = await runtime.transport.getChannel(channelId);
      if (channel.name !== name || channel.isPrivate !== isPrivate) {
        const context = existing ? "项目已绑定的频道" : "续办频道";
        throw new WorkflowConflictError(`${context} ${channel.id} 的名称或公开范围与请求不一致，请核实实际频道。`);
      }
      this.assertProjectChannel(channel);
      return { channel, created: false };
    }
    try {
      const channel = await runtime.transport.createChannel({ name, isPrivate });
      return { channel, created: true };
    } catch (error) {
      let candidates: SlackChannel[] | undefined;
      if (slackErrorCode(error) === "name_taken") {
        try {
          candidates = (await runtime.transport.listChannels()).filter(
            (channel) => channel.name === name && channel.isPrivate === isPrivate,
          );
        } catch {
          // 名称冲突仍是本次失败原因；候选查询失败不覆盖创建失败。
        }
      }
      throw this.projectChannelFailure(error, runtime, {
        stage: "create", created: false,
        ...(candidates ? { candidates } : {}),
      }, isPrivate);
    }
  }

  private async bindProjectChannel(projectId: string, channel: SlackChannel): Promise<SlackProjectBinding> {
    this.assertProjectChannel(channel);
    const binding = { projectId, channelId: channel.id };
    await this.options.settings.bindSlackProject(binding);
    return binding;
  }

  private assertProjectChannel(channel: SlackChannel): void {
    if (channel.id.startsWith("D") || !channel.isMember) {
      throw new WorkflowConflictError("项目只能绑定机器人已经加入的公开或私有频道。");
    }
  }

  private projectChannelFailure(
    error: unknown,
    runtime: SlackRuntime,
    details: SlackProjectChannelFailure,
    isPrivate: boolean,
  ): SlackProjectChannelError {
    const slackError = slackErrorCode(error);
    const requiredScope = slackError === "missing_scope" ? (isPrivate ? "groups:write" : "channels:manage") : undefined;
    const safe = this.recordError(error, runtime.config);
    const step = { create: "创建频道", invite: "邀请用户", bind: "保存项目绑定" }[details.stage];
    const explanation = requiredScope
      ? `需要 Bot 权限 ${requiredScope}；请更新应用权限并重新授权后，通过 API 重试。`
      : slackError === "name_taken"
        ? "频道名已被使用；请核实可见候选，明确选择实际频道后使用 channelId 续办。"
        : safe.message;
    const receipt = details.channel
      ? ` 频道 ${details.channel.id} 已存在，请保留该 ID 续办，当前项目绑定尚未更新。`
      : "";
    return new SlackProjectChannelError(`${step}未完成：${explanation}${receipt}`, {
      ...details,
      ...(slackError ? { slackError } : {}),
      ...(requiredScope ? { requiredScope } : {}),
    });
  }

  private changeLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.lifecycle.then(operation);
    this.lifecycle = next.then(() => undefined, () => undefined);
    return next;
  }

  private async connect(config: SlackConfig): Promise<void> {
    let releaseMessages!: () => void;
    const ready = new Promise<void>((resolve) => { releaseMessages = resolve; });
    let transport: SlackTransport | null = null;
    try {
      transport = this.options.createTransport(config);
      const deliveries = new SlackDeliveryService(this.options.state, transport, config.teamId);
      const onError = (error: unknown) => { this.recordError(error, config); };
      const notifications = new SlackNotifications({
        projects: this.options.projects, configStore: this.options.configStore,
        state: this.options.state, deliveries, onError,
      });
      const assistant = new SlackAssistant({
        configStore: this.options.configStore, projects: this.options.projects,
        state: this.options.state, codex: this.options.codex, transport, deliveries,
        localProjects: this.options.localProjects,
        pendingDecisions: (target) => notifications.pendingDecisions(target), onError,
      });
      const runtime: SlackRuntime = {
        config, transport, deliveries, notifications, assistant, connected: false, accepting: true,
      };
      this.runtime = runtime;
      const modelCommands = new SlackModelCommands({
        configStore: this.options.configStore, projects: this.options.projects, settings: this.options.settings,
      });
      const status = new SlackStatus({
        configStore: this.options.configStore, projects: this.options.projects,
        state: this.options.state, codex: this.options.codex,
      });
      await transport.start((message) => this.receive(runtime, ready, message), {
        read: (context) => this.receiveControl(runtime, ready, () => modelCommands.read(context)),
        select: (context, modelId, expectedScopeId) => this.receiveControl(runtime, ready, () => modelCommands.select(context, modelId, expectedScopeId)),
      }, {
        read: (context) => this.receiveControl(runtime, ready, () => status.read(context)),
      }, {
        startNew: (context) => this.receiveControl(runtime, ready, async () => {
          await assistant.startNewConversation(context);
        }),
      });
      await assistant.start();
      await notifications.start();
      runtime.connected = true;
      this.lastConnectionError = null;
      releaseMessages();
      await this.flushPending(runtime);
      this.retryTimer = setInterval(() => {
        void this.flushPending(runtime).catch(onError);
      }, 30_000);
      this.retryTimer.unref();
    } catch (error) {
      if (this.runtime) this.runtime.accepting = false;
      releaseMessages();
      if (this.runtime) await this.disconnect().catch((cleanupError: unknown) => this.recordError(cleanupError, config));
      else if (transport) await transport.stop().catch((cleanupError: unknown) => this.recordError(cleanupError, config));
      const failure = this.recordError(error, config);
      this.lastConnectionError = failure.message;
      throw failure;
    }
  }

  private async disconnect(): Promise<void> {
    const runtime = this.runtime;
    if (!runtime) return;
    this.runtime = null;
    runtime.accepting = false;
    runtime.connected = false;
    if (this.retryTimer) clearInterval(this.retryTimer);
    this.retryTimer = null;
    await Promise.allSettled(this.incoming);
    const stopped = await Promise.allSettled([runtime.assistant.stop(), runtime.notifications.stop()]);
    await Promise.allSettled([...this.reports.values(), ...(this.flushing ? [this.flushing] : [])]);
    await runtime.transport.stop();
    // 报告失败已返回原调用方；停机仍需暴露自身队列停止失败。
    for (const result of stopped) {
      if (result.status === "rejected") throw result.reason;
    }
  }

  private async receive(runtime: SlackRuntime, ready: Promise<void>, message: SlackIncomingMessage): Promise<void> {
    if (!runtime.accepting) return;
    const operation = ready.then(async () => {
      if (runtime.accepting) await runtime.assistant.receive(message);
    }).catch((error: unknown) => { this.recordError(error, runtime.config); });
    this.incoming.add(operation);
    try {
      await operation;
    } finally {
      this.incoming.delete(operation);
    }
  }

  private async receiveControl<T>(runtime: SlackRuntime, ready: Promise<void>, operation: () => Promise<T>): Promise<T> {
    const accepted = ready.then(async () => {
      if (!runtime.accepting) throw new WorkflowConflictError("Slack 连接正在更新，请稍后重试。");
      return operation();
    });
    this.incoming.add(accepted);
    try {
      return await accepted;
    } catch (error) {
      throw this.recordError(error, runtime.config);
    } finally {
      this.incoming.delete(accepted);
    }
  }

  private flushPending(runtime: SlackRuntime): Promise<void> {
    if (this.flushing) return this.flushing;
    const operation = runtime.deliveries.flushPending((error) => { this.recordError(error, runtime.config); });
    const tracked = operation.finally(() => {
      if (this.flushing === tracked) this.flushing = null;
    });
    this.flushing = tracked;
    return tracked;
  }

  private async deliverReport(id: string, input: SlackReportInput): Promise<SlackDeliveryRecord> {
    const existing = await this.options.state.getDelivery(id);
    if (existing && (
      existing.projectId !== input.projectId || existing.markdown !== input.markdown ||
      !isDeepStrictEqual(existing.source, input.source)
    )) {
      throw new WorkflowConflictError("该报告请求已经关联其他项目、来源或正文。");
    }
    if (existing) {
      const { slack } = await this.options.configStore.read();
      if (existing.target.teamId !== slack?.teamId) {
        throw new WorkflowConflictError("该报告属于原 Slack 工作区，请恢复原接入配置后重试。");
      }
    }
    if (existing?.sentAt) return existing;
    const runtime = this.requireConnection();
    const delivery = existing ?? await this.createReport(id, input, runtime);
    try {
      return await runtime.deliveries.deliver(delivery);
    } catch (error) {
      throw this.recordError(error, runtime.config);
    }
  }

  private async createReport(id: string, input: SlackReportInput, runtime: SlackRuntime): Promise<SlackDeliveryRecord> {
    const { slack } = await this.options.configStore.read();
    if (!slack?.enabled || slack.teamId !== runtime.config.teamId) {
      throw new WorkflowConflictError("Slack 配置正在更新，请在连接完成后重试。");
    }
    const binding = slack.projectBindings.find(({ projectId }) => projectId === input.projectId);
    if (!binding) throw new WorkflowConflictError("项目尚未绑定 Slack 频道，请先配置报告目的地。");
    return {
      id, projectId: input.projectId, source: input.source, markdown: input.markdown,
      target: { kind: "slack", teamId: slack.teamId, channelId: binding.channelId },
      createdAt: new Date().toISOString(),
    };
  }

  private requireConnection(): SlackRuntime {
    if (!this.runtime?.connected) throw new WorkflowConflictError("Slack 尚未连接，请先检查接入配置。");
    return this.runtime;
  }

  private recordError(error: unknown, config: SlackConfig): Error {
    let message = error instanceof Error ? error.message : String(error);
    for (const secret of [config.botToken, config.appToken]) {
      if (secret) message = message.split(secret).join("[已隐藏]");
    }
    const safe = new Error(message);
    this.options.onError(safe);
    return safe;
  }
}

function slackErrorCode(error: unknown): string | null {
  if (error === null || typeof error !== "object" || !("data" in error)) return null;
  const data = error.data;
  if (data === null || typeof data !== "object" || !("error" in data)) return null;
  return typeof data.error === "string" ? data.error : null;
}
