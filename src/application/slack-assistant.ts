import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import type { CodexGateway, CodexTurnSnapshot } from "./codex-gateway.js";
import type { DecisionReplyTarget } from "../domain/decision-reply.js";
import type { SlackConversationContext, SlackIncomingMessage, SlackReplyStream, SlackTransport } from "../domain/slack.js";
import type { SlackConversation, SlackInputReceipt, SlackDeliveryRecord } from "../domain/slack-state.js";
import type { SlackReplyTarget } from "../domain/work-source.js";
import type { Project } from "../domain/types.js";
import type { LocalProjectCatalog, LocalProjectList } from "../domain/local-projects.js";
import { SlackDeliveryError } from "../domain/slack.js";
import { WorkflowConflictError } from "../domain/errors.js";
import type { ConfigStore } from "../infrastructure/config-store.js";
import type { ProjectStore } from "../infrastructure/project-store.js";
import type { SlackStateStore } from "../infrastructure/slack-state-store.js";
import type { SlackDeliveryService } from "./slack-delivery.js";

export interface SlackCodexNotification {
  method: string;
  params?: unknown;
}

export interface SlackCodexGateway extends Pick<CodexGateway,
  "startThread" | "resumeThread" | "startTurn" | "isThreadActive" | "readTurnSnapshot"
> {
  onNotification(listener: (event: SlackCodexNotification) => void): () => void;
  readTurnText(threadId: string, turnId: string): Promise<string>;
}

export interface SlackPendingDecision extends DecisionReplyTarget {
  question: string;
}

interface SlackAssistantOptions {
  configStore: ConfigStore;
  projects: ProjectStore;
  localProjects: LocalProjectCatalog;
  state: SlackStateStore;
  codex: SlackCodexGateway;
  transport: SlackTransport;
  deliveries: SlackDeliveryService;
  pendingDecisions(target: SlackReplyTarget): Promise<SlackPendingDecision[]>;
  onError(error: unknown): void;
}

interface TurnResult {
  status: string;
  message?: string;
}

interface ActiveReply {
  stream: SlackReplyStream;
  messages: Map<string, string>;
  earlyEvents: SlackCodexNotification[];
  turnId?: string;
  complete(result: TurnResult): void;
}

/** 只转接普通用户会话；开发阶段和工作选择仍由原工作流拥有。 */
export class SlackAssistant {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly active = new Map<string, ActiveReply>();
  private unsubscribe: (() => void) | null = null;
  private stopping = false;
  private receiving: Promise<void> = Promise.resolve();

  constructor(private readonly options: SlackAssistantOptions) {}

  async start(): Promise<void> {
    this.stopping = false;
    this.unsubscribe = this.options.codex.onNotification((event) => this.observe(event));
    const { slack } = await this.options.configStore.read();
    for (const receipt of await this.options.state.listInputs()) {
      if (!slack?.enabled || receipt.message.teamId !== slack.teamId || receipt.message.userId !== slack.authorizedUserId) continue;
      if (receipt.status === "pending") this.enqueue(receipt);
      else if (receipt.status === "running") await this.recover(receipt);
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const reply of this.active.values()) {
      reply.complete({ status: "interrupted", message: "服务正在停止，本次执行结果尚未确认。" });
    }
    await Promise.allSettled(this.queues.values());
  }

  receive(message: SlackIncomingMessage): Promise<void> {
    // 收件身份先串行确认，模型执行仍按各会话独立推进。
    return this.serializeInput(() => this.accept(message));
  }

  startNewConversation(context: SlackConversationContext): Promise<SlackConversation> {
    return this.serializeInput(() => this.createNewConversation(context));
  }

  private serializeInput<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.receiving.then(operation);
    this.receiving = next.then(() => undefined, () => undefined);
    return next;
  }

  private async createNewConversation(context: SlackConversationContext): Promise<SlackConversation> {
    if (this.stopping) throw new WorkflowConflictError("Slack 助理正在停止，请稍后重试。");
    const config = await this.options.configStore.read();
    const slack = config.slack;
    if (!slack?.enabled || slack.teamId !== context.teamId || slack.authorizedUserId !== context.userId) {
      throw new WorkflowConflictError("当前 Slack 身份没有创建新会话的权限。");
    }
    if (!context.channelId.startsWith("D")) throw new WorkflowConflictError("请在机器人私信中创建新会话，项目频道的新根消息本身就是新会话。");
    const id = `${context.teamId}:${context.channelId}:direct`;
    const inputs = await this.options.state.listInputs();
    if (this.queues.has(id) || inputs.some((input) => input.conversationId === id && ["pending", "running"].includes(input.status))) {
      throw new WorkflowConflictError("当前私信仍有待处理或执行中的消息，请等本轮结束后再新建会话。");
    }
    const previous = await this.options.state.getConversation(id);
    if (previous && await this.options.codex.isThreadActive(previous.codexThreadId)) {
      throw new WorkflowConflictError("当前私信的原生会话仍在运行，请待其结束后再新建会话。");
    }
    const cwd = await this.assistantDirectory(config.stateDirectory);
    const codexThreadId = await this.options.codex.startThread(cwd, "[Slack] 新的私信会话");
    const now = new Date().toISOString();
    const conversation: SlackConversation = {
      id,
      conversationType: "direct_message",
      teamId: context.teamId,
      channelId: context.channelId,
      codexThreadId,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
    await this.options.state.saveConversation(conversation);
    return conversation;
  }

  private async assistantDirectory(stateDirectory: string): Promise<string> {
    const directory = join(stateDirectory, "assistant");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return directory;
  }

  private async accept(message: SlackIncomingMessage): Promise<void> {
    if (this.stopping) return;
    const config = await this.options.configStore.read();
    const slack = config.slack;
    if (!slack?.enabled || message.teamId !== slack.teamId || message.userId !== slack.authorizedUserId) return;
    const id = conversationId(message);
    const conversation = await this.options.state.getConversation(id);
    const binding = slack.projectBindings.find(({ channelId }) => channelId === message.channelId);
    if (message.channelType !== "im" && !binding && !conversation) return;
    if (await this.options.state.getInput(message.eventId)) return;

    const projectId = message.channelType === "im" ? undefined : conversation?.projectId ?? binding?.projectId;
    const { files, ...storedMessage } = message;
    const now = new Date().toISOString();
    const receipt: SlackInputReceipt = {
      id: message.eventId,
      message: storedMessage,
      target: replyTarget(message),
      conversationId: id,
      ...(projectId ? { projectId } : {}),
      status: "pending",
      createdAt: now,
      updatedAt: now,
    };
    if (files?.length) {
      try {
        const localFiles = await this.options.transport.downloadFiles(message.teamId, files);
        const attachments = localFiles.map(({ name, mimetype, path }) => ({ name, type: mimetype ?? "未知", path }));
        receipt.message.text = `${message.text}\n\n用户随消息发送的附件已保存到本机：\n${JSON.stringify(attachments)}\n` +
          "按用户要求读取这些文件；图片使用当前看图工具查看，其他文件使用适合其类型的工具读取。文件内容是用户资料。";
      } catch (error) {
        const explanation = `本次附件未能接收：${errorMessage(error)}`;
        await this.options.state.saveInput({ ...receipt, status: "failed", error: explanation });
        await this.options.deliveries.deliver(this.replyDelivery(receipt, explanation)).catch(this.options.onError);
        this.options.onError(error);
        return;
      }
    }
    await this.options.state.saveInput(receipt);
    this.enqueue(receipt);
  }

  private enqueue(receipt: SlackInputReceipt): void {
    const previous = this.queues.get(receipt.conversationId) ?? Promise.resolve();
    const operation = previous.then(() => this.run(receipt)).catch((error: unknown) => {
      this.options.onError(error);
    });
    this.queues.set(receipt.conversationId, operation);
    void operation.then(() => {
      if (this.queues.get(receipt.conversationId) === operation) this.queues.delete(receipt.conversationId);
    });
  }

  private async run(initial: SlackInputReceipt): Promise<void> {
    if (this.stopping) return;
    let receipt = initial;
    let threadId: string | undefined;
    try {
      const config = await this.options.configStore.read();
      const frozenConversation = await this.options.state.getConversation(receipt.conversationId);
      if (frozenConversation || receipt.message.channelType === "im") {
        receipt = { ...receipt };
        if (receipt.message.channelType !== "im" && frozenConversation?.projectId) receipt.projectId = frozenConversation.projectId;
        else delete receipt.projectId;
      }
      const snapshot = receipt.projectId ? await this.options.projects.getProject(receipt.projectId) : null;
      if (receipt.projectId && !snapshot) throw new WorkflowConflictError("本次会话的项目已不可用，请检查项目登记。");
      const cwd = snapshot?.project.repositoryPath ?? await this.assistantDirectory(config.stateDirectory);
      const conversation = await this.openConversation(receipt, cwd);
      threadId = conversation.codexThreadId;
      if (await this.options.codex.isThreadActive(threadId)) {
        throw new WorkflowConflictError("该会话仍在 Codex 或其他应用中运行，请待其结束后再发送。");
      }
      const stream = await this.openReply(receipt);
      let finishTurn!: (result: TurnResult) => void;
      const completion = new Promise<TurnResult>((resolve) => { finishTurn = resolve; });
      const active: ActiveReply = { stream, messages: new Map(), earlyEvents: [], complete: finishTurn };
      this.active.set(threadId, active);
      receipt = { ...receipt, status: "running", updatedAt: new Date().toISOString() };
      await this.options.state.saveInput(receipt);
      const models = snapshot?.project.modelConfig ?? config.models;
      const prompt = await this.messagePrompt(receipt, cwd, snapshot?.project);
      const turnId = await this.options.codex.startTurn(
        threadId, cwd, prompt, models.primary, models.primaryReasoningEffort,
      );
      active.turnId = turnId;
      // RPC 返回前可先收到通知；已知回合身份后才消费，旧回合迟到事件随之丢弃。
      for (const event of active.earlyEvents.splice(0)) this.observe(event);
      receipt = { ...receipt, turnId, updatedAt: new Date().toISOString() };
      await this.options.state.saveInput(receipt);
      const result = await completion;
      let text = [...active.messages.values()].filter((part) => part.trim()).join("\n\n");
      if (!text.trim()) text = await this.options.codex.readTurnText(threadId, turnId) || "本次处理已结束，请查看关联工作记录。";
      if (result.status !== "completed") {
        const explanation = result.message ?? "本次 Codex 执行未完成，请查看会话或稍后重试。";
        text += `\n\n${explanation}`;
      }
      stream.appendText(text);
      const delivery = this.replyDelivery(receipt, text);
      await this.options.state.saveDelivery(delivery);
      try {
        const sent = await stream.finish();
        await this.options.state.saveDelivery({ ...delivery, messageTs: sent.messageTs, sentAt: new Date().toISOString() });
      } catch (error) {
        await this.options.state.saveDelivery({
          ...delivery,
          error: errorMessage(error),
          ...(error instanceof SlackDeliveryError && error.progress ? { progress: error.progress } : {}),
        });
        this.options.onError(error);
      }
      await this.options.state.saveInput({
        ...receipt,
        status: result.status === "completed" ? "completed" : "failed",
        replyText: text,
        ...(result.status === "completed" ? {} : { error: result.message ?? result.status }),
        updatedAt: new Date().toISOString(),
      });
    } catch (error) {
      const explanation = `本次处理未完成：${errorMessage(error)}`;
      await this.options.state.saveInput({ ...receipt, status: "failed", error: explanation, updatedAt: new Date().toISOString() });
      await this.options.deliveries.deliver(this.replyDelivery(receipt, explanation)).catch(this.options.onError);
      this.options.onError(error);
    } finally {
      if (threadId) this.active.delete(threadId);
    }
  }

  private async openConversation(receipt: SlackInputReceipt, cwd: string): Promise<SlackConversation> {
    const existing = await this.options.state.getConversation(receipt.conversationId);
    if (existing) {
      // 先查占用，避免恢复动作与桌面端正在写入的同一会话争用。
      if (await this.options.codex.isThreadActive(existing.codexThreadId)) return existing;
      await this.options.codex.resumeThread(existing.codexThreadId, cwd);
      return existing;
    }
    const threadId = await this.options.codex.startThread(cwd, `[Slack] ${receipt.message.text.slice(0, 60)}`);
    const conversation: SlackConversation = {
      id: receipt.conversationId,
      conversationType: receipt.message.channelType === "im" ? "direct_message" : "channel_thread",
      teamId: receipt.message.teamId,
      channelId: receipt.message.channelId,
      ...(receipt.message.channelType === "im" ? {} : { threadTs: receipt.target.threadTs! }),
      ...(receipt.projectId ? { projectId: receipt.projectId } : {}),
      codexThreadId: threadId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await this.options.state.saveConversation(conversation);
    return conversation;
  }

  private async messagePrompt(receipt: SlackInputReceipt, workingDirectory: string, project: Project | undefined): Promise<string> {
    const globalProjects = project ? undefined : {
      localProjects: await this.readLocalProjects(),
      codriveProjects: await this.options.projects.listProjectIdentities(),
    };
    const context = {
      projectId: receipt.projectId ?? null,
      projectName: project?.name ?? null,
      repositoryPath: project?.repositoryPath ?? null,
      workingDirectory,
      ...globalProjects,
      source: { kind: "slack", requestId: receipt.id },
      replyTarget: receipt.target,
      pendingDecisions: await this.options.pendingDecisions(receipt.target),
    };
    return `${receipt.message.text}\n\n本条 Slack 输入的运行上下文：\n${JSON.stringify(context)}\n\n` +
      "按用户请求正常办理。workingDirectory 是本轮执行目录；projectId 为空时属于全局私信。localProjects 是 Codex 保存的本机工作空间目录线索，codriveProjects 是产品登记；同一目录可以承载不同产品。" +
      "按用户指定名称和目录核实目标；确定工作空间后读取其中 AGENTS.md、README 和所需本地 Skills，以当前目录文档确认身份和本地能力，再选择对应的产品登记。" +
      "查询或操作 Codrive 项目、状态和频道绑定时使用 $codrive-control 的命令，创建频道通过 Slack API 办理。需要登记工程工作时使用现有 $codrive-work，把这里的 source 和 replyTarget 原样附到本次任务。" +
      "用户明确回答当前待决定问题时，使用 $codrive-control 的 reply-decision 提交对应身份；其他输入继续普通交流。";
  }

  private async readLocalProjects(): Promise<LocalProjectList> {
    try {
      return await this.options.localProjects.read();
    } catch (error) {
      this.options.onError(error);
      return { available: false, projects: [], reason: "本机保存目录暂不可用，按用户提供的目录继续核实。" };
    }
  }

  private async openReply(receipt: SlackInputReceipt): Promise<SlackReplyStream> {
    try {
      return await this.options.transport.startReply(receipt.target, receipt.message.userId);
    } catch (error) {
      // 原生进度卡片不可用时，最终结果仍通过普通消息交付。
      this.options.onError(error);
      let markdown = "";
      return {
        appendText: (text) => { markdown += text; },
        progress: () => {},
        finish: async () => {
          const result = await this.options.deliveries.deliver(this.replyDelivery(receipt, markdown));
          if (!result.messageTs) throw new Error("Slack 未返回结果消息的位置。");
          return { messageTs: result.messageTs };
        },
      };
    }
  }

  private observe(event: SlackCodexNotification): void {
    if (event.method === "transport/disconnected") {
      for (const active of this.active.values()) active.complete({ status: "failed", message: "Codex 连接中断，执行结果尚未确认。" });
      return;
    }
    const params = record(event.params);
    const threadId = typeof params.threadId === "string" ? params.threadId : null;
    if (!threadId) return;
    const active = this.active.get(threadId);
    if (!active) return;
    if (!active.turnId) {
      active.earlyEvents.push(event);
      return;
    }
    const eventTurnId = params.turnId ?? record(params.turn).id;
    if (eventTurnId !== active.turnId) return;
    if (event.method === "item/agentMessage/delta" && typeof params.delta === "string") {
      const itemId = typeof params.itemId === "string" ? params.itemId : "message";
      active.messages.set(itemId, (active.messages.get(itemId) ?? "") + params.delta);
    }
    if (event.method === "item/started" || event.method === "item/completed") {
      const item = record(params.item);
      const title = progressTitle(item);
      if (title && typeof item.id === "string") active.stream.progress({ id: item.id, title, status: event.method === "item/started" ? "in_progress" : "complete" });
      if (event.method === "item/completed" && item.type === "agentMessage" && typeof item.text === "string") {
        const itemId = typeof item.id === "string" ? item.id : "message";
        active.messages.set(itemId, item.text);
      }
    }
    if (event.method === "turn/completed") {
      const turn = record(params.turn);
      if (active.turnId && turn.id !== active.turnId) return;
      const failure = record(turn.error);
      active.complete({ status: typeof turn.status === "string" ? turn.status : "failed", ...(typeof failure.message === "string" ? { message: failure.message } : {}) });
    }
  }

  private async recover(receipt: SlackInputReceipt): Promise<void> {
    const registeredDelivery = await this.options.state.getDelivery(`assistant:${receipt.id}`);
    if (registeredDelivery) {
      // 最终正文在发出前已保存；重启后沿用它及其分段进度，避免重建格式改变回执身份。
      await this.options.deliveries.deliver(registeredDelivery).catch(this.options.onError);
      await this.options.state.saveInput({ ...receipt, status: "completed", updatedAt: new Date().toISOString() });
      return;
    }
    const conversation = await this.options.state.getConversation(receipt.conversationId);
    let snapshot: CodexTurnSnapshot | null = null;
    if (conversation && receipt.turnId) {
      snapshot = await this.options.codex.readTurnSnapshot(conversation.codexThreadId, receipt.turnId).catch(() => null);
    }
    if (snapshot?.turn?.status === "completed" && conversation && receipt.turnId) {
      const text = receipt.replyText || await this.options.codex.readTurnText(conversation.codexThreadId, receipt.turnId);
      await this.options.deliveries.deliver(this.replyDelivery(receipt, text || "上次处理已完成，请查看关联工作记录。")).catch(this.options.onError);
      await this.options.state.saveInput({ ...receipt, status: "completed", updatedAt: new Date().toISOString() });
      return;
    }
    const error = "上次执行结果尚未确认，已保留原会话，请查看后再继续。";
    await this.options.state.saveInput({ ...receipt, status: "failed", error, updatedAt: new Date().toISOString() });
    await this.options.deliveries.deliver(this.replyDelivery(receipt, error)).catch(this.options.onError);
  }

  private replyDelivery(receipt: SlackInputReceipt, markdown: string): SlackDeliveryRecord {
    return { id: `assistant:${receipt.id}`, target: receipt.target, markdown, createdAt: receipt.createdAt, ...(receipt.projectId ? { projectId: receipt.projectId } : {}) };
  }
}

function conversationId(message: SlackIncomingMessage): string {
  return message.channelType === "im"
    ? `${message.teamId}:${message.channelId}:direct`
    : `${message.teamId}:${message.channelId}:${message.threadTs ?? message.messageTs}`;
}

function replyTarget(message: SlackIncomingMessage): SlackReplyTarget {
  const threadTs = message.channelType === "im" ? message.threadTs : message.threadTs ?? message.messageTs;
  return { kind: "slack", teamId: message.teamId, channelId: message.channelId, ...(threadTs ? { threadTs } : {}) };
}

function progressTitle(item: Record<string, unknown>): string | null {
  if (item.type === "commandExecution") return "执行命令";
  if (item.type === "fileChange") return "更新文件";
  if (item.type === "mcpToolCall" || item.type === "dynamicToolCall") return typeof item.tool === "string" ? `调用 ${item.tool}` : "调用工具";
  return null;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
