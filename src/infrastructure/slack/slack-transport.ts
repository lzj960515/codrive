import { App, LogLevel, type BlockStaticSelectAction, type MessageShortcut } from "@slack/bolt";
import type { KnownBlock } from "@slack/types";
import { WebClient } from "@slack/web-api";

import type {
  SlackChannel,
  SlackIncomingMessage,
  SlackIncomingFile,
  SlackLocalFile,
  SlackModelControls,
  SlackModelMenu,
  SlackReplyStream,
  SlackStatusControls,
  SlackStatusView,
  SlackSendProgress,
  SlackTransport,
} from "../../domain/slack.js";
import type { SlackReplyTarget } from "../../domain/work-source.js";
import { postSlackMessages } from "./delivery.js";
import { buildSlackMessages } from "./formatting.js";
import { SlackReply } from "./reply-stream.js";
import { SlackFiles } from "./slack-files.js";

export interface BoltSlackTransportOptions {
  stateDirectory: string;
  botToken: string;
  appToken: string;
  onError(error: unknown): void;
}

export class BoltSlackTransport implements SlackTransport {
  private readonly app: App;
  private readonly client: WebClient;
  private readonly replies = new Set<SlackReply>();
  private onMessage: ((message: SlackIncomingMessage) => Promise<void>) | undefined;
  private modelControls: SlackModelControls | undefined;
  private statusControls: SlackStatusControls | undefined;
  private readonly files: SlackFiles;

  constructor(private readonly options: BoltSlackTransportOptions) {
    this.client = new WebClient(options.botToken);
    this.files = new SlackFiles(options.stateDirectory, options.botToken, this.client);
    this.app = new App({
      token: options.botToken,
      appToken: options.appToken,
      socketMode: true,
      logLevel: LogLevel.WARN,
    });
    this.app.event("message", async ({ event, body, context }) => {
      const incoming = incomingMessage(event, body.event_id, body.team_id ?? context.teamId);
      if (incoming) await this.onMessage?.(incoming);
    });
    this.app.command("/model", async ({ command, ack, respond }) => {
      await ack();
      try {
        const controls = this.requireModelControls();
        const context = { teamId: command.team_id, userId: command.user_id, channelId: command.channel_id };
        const modelId = command.text.trim();
        const menu = modelId ? await controls.select(context, modelId) : await controls.read(context);
        await respond({ response_type: "ephemeral", ...modelMenuMessage(menu, Boolean(modelId)) });
      } catch (error) {
        this.options.onError(error);
        await respond({ response_type: "ephemeral", text: modelErrorMessage(error) });
      }
    });
    this.app.command("/models", async ({ command, ack, respond }) => {
      await ack();
      try {
        const menu = await this.requireModelControls().read({
          teamId: command.team_id, userId: command.user_id, channelId: command.channel_id,
        });
        const choices = menu.models.map(({ id, displayName }) =>
          `• ${displayName} — \`${id}\`${id === menu.primary ? "（当前）" : ""}`,
        );
        const text = [
          `${menu.scopeLabel}可切换的主模型：`,
          ...choices,
          `备用模型：\`${menu.fallback}\`（主模型与备用模型保持不同）。`,
          "使用 `/model <模型 ID>` 切换，或运行 `/model` 打开下拉菜单。模型列表来自本机 Codex 当前目录。",
        ].join("\n");
        await respond({ response_type: "ephemeral", text, blocks: [{ type: "section", text: { type: "mrkdwn", text } }] });
      } catch (error) {
        this.options.onError(error);
        await respond({ response_type: "ephemeral", text: `模型列表读取未完成：${error instanceof Error ? error.message : String(error)}` });
      }
    });
    this.app.action<BlockStaticSelectAction>("codrive-model-select", async ({ body, action, context, ack, respond }) => {
      await ack();
      try {
        const teamId = body.team?.id ?? context.teamId;
        const channelId = body.channel?.id;
        if (!teamId || !channelId) throw new Error("请在私信或已绑定项目频道中运行 /model。");
        const menu = await this.requireModelControls().select(
          { teamId, userId: body.user.id, channelId }, action.selected_option.value,
          action.block_id.slice("codrive-model:".length),
        );
        await respond({ replace_original: true, response_type: "ephemeral", ...modelMenuMessage(menu, true) });
      } catch (error) {
        this.options.onError(error);
        await respond({ replace_original: true, response_type: "ephemeral", text: modelErrorMessage(error), blocks: [] });
      }
    });
    this.app.command("/state", async ({ command, ack, respond }) => {
      await ack();
      try {
        const view = await this.requireStatusControls().read({ teamId: command.team_id, userId: command.user_id, channelId: command.channel_id });
        await respond({ response_type: "ephemeral", ...statusMessage(view) });
      } catch (error) {
        this.options.onError(error);
        await respond({ response_type: "ephemeral", text: statusErrorMessage(error) });
      }
    });
    this.app.action<BlockStaticSelectAction>("codrive-status-select", async ({ body, action, context, ack, respond }) => {
      await ack();
      try {
        const teamId = body.team?.id ?? context.teamId;
        const channelId = body.channel?.id;
        if (!teamId || !channelId) throw new Error("请选择这个 Slack 对话中的既有会话。");
        const view = await this.requireStatusControls().read({ teamId, userId: body.user.id, channelId, conversationId: action.selected_option.value });
        await respond({ replace_original: true, response_type: "ephemeral", ...statusMessage(view) });
      } catch (error) {
        this.options.onError(error);
        await respond({ replace_original: true, response_type: "ephemeral", text: statusErrorMessage(error), blocks: [] });
      }
    });
    this.app.shortcut<MessageShortcut>("codrive-status", async ({ shortcut, context, ack, respond }) => {
      await ack();
      try {
        const teamId = shortcut.team?.id ?? context.teamId;
        if (!teamId) throw new Error("无法确认这条消息所属的 Slack 工作区。");
        const threadTs = typeof shortcut.message.thread_ts === "string" ? shortcut.message.thread_ts : shortcut.message.ts;
        const view = await this.requireStatusControls().read({ teamId, userId: shortcut.user.id, channelId: shortcut.channel.id, threadTs });
        await respond({ response_type: "ephemeral", ...statusMessage(view) });
      } catch (error) {
        this.options.onError(error);
        await respond({ response_type: "ephemeral", text: statusErrorMessage(error) });
      }
    });
    this.app.error(async (error) => { this.options.onError(error); });
  }

  async start(onMessage: (message: SlackIncomingMessage) => Promise<void>, modelControls: SlackModelControls, statusControls: SlackStatusControls): Promise<void> {
    this.onMessage = onMessage;
    this.modelControls = modelControls;
    this.statusControls = statusControls;
    await this.app.start();
  }

  async stop(): Promise<void> {
    this.onMessage = undefined;
    this.modelControls = undefined;
    this.statusControls = undefined;
    const results = await Promise.allSettled([...this.replies].map((reply) => reply.close()));
    for (const result of results) {
      if (result.status === "rejected") this.options.onError(result.reason);
    }
    await this.app.stop();
  }

  sendMessage(target: SlackReplyTarget, markdown: string, resume?: SlackSendProgress): Promise<{ messageTs: string }> {
    return postSlackMessages(this.client, target, buildSlackMessages(markdown), resume);
  }

  async getChannel(id: string): Promise<SlackChannel> {
    const result = await this.client.conversations.info({ channel: id });
    if (!result.ok || !result.channel) throw new Error(result.error ?? "Slack channel is unavailable");
    const channel = projectChannel(result.channel);
    if (!channel) throw new Error("Choose a Slack project channel rather than a direct message");
    return channel;
  }

  async listChannels(): Promise<SlackChannel[]> {
    const channels: SlackChannel[] = [];
    let cursor: string | undefined;
    do {
      const result = await this.client.conversations.list({
        types: "public_channel,private_channel",
        exclude_archived: true,
        limit: 200,
        ...(cursor ? { cursor } : {}),
      });
      if (!result.ok) throw new Error(result.error ?? "Slack channels are unavailable");
      for (const item of result.channels ?? []) {
        const channel = projectChannel(item);
        if (channel) channels.push(channel);
      }
      cursor = result.response_metadata?.next_cursor?.trim() || undefined;
    } while (cursor);
    return channels;
  }

  async startReply(target: SlackReplyTarget, recipientUserId: string): Promise<SlackReplyStream> {
    const reply = await SlackReply.start({
      client: this.client,
      target,
      recipientUserId,
      onError: this.options.onError,
      onClosed: () => this.replies.delete(reply),
    });
    this.replies.add(reply);
    return reply;
  }

  downloadFiles(teamId: string, files: SlackIncomingFile[]): Promise<SlackLocalFile[]> {
    return this.files.download(teamId, files);
  }

  sendFile(target: SlackReplyTarget, input: { filePath: string; title?: string; comment?: string }): Promise<{ id: string; name: string; permalink?: string }> {
    return this.files.upload(target, input);
  }

  private requireModelControls(): SlackModelControls {
    if (!this.modelControls) throw new Error("模型设置尚未就绪，请稍后重试。");
    return this.modelControls;
  }

  private requireStatusControls(): SlackStatusControls {
    if (!this.statusControls) throw new Error("会话状态尚未就绪，请稍后重试。");
    return this.statusControls;
  }
}

function statusMessage(view: SlackStatusView): { text: string; blocks: KnownBlock[] } {
  return {
    text: view.text,
    blocks: [
      { type: "section", text: { type: "plain_text", text: view.text } },
      ...(view.conversations.length ? [{
        type: "actions" as const,
        elements: [{
          type: "static_select" as const, action_id: "codrive-status-select",
          placeholder: { type: "plain_text" as const, text: "选择已有会话" },
          options: view.conversations.slice(0, 100).map(({ id, label }) => ({
            text: { type: "plain_text" as const, text: label.slice(0, 75) }, value: id,
          })),
        }],
      }] : []),
    ],
  };
}

function statusErrorMessage(error: unknown): string {
  return `会话状态读取未完成：${error instanceof Error ? error.message : String(error)}`;
}

function modelMenuMessage(menu: SlackModelMenu, changed: boolean): { text: string; blocks: KnownBlock[] } {
  const text = `${changed ? "已更新" : "当前"}${menu.scopeLabel}模型：${menu.primary}。备用模型：${menu.fallback}。从下一回合生效，正在执行的回合保持原模型。`;
  const options = menu.models.slice(0, 100).map(({ id, displayName }) => ({
    text: { type: "plain_text" as const, text: `${displayName} (${id})`.slice(0, 75) }, value: id,
  }));
  const current = options.find(({ value }) => value === menu.primary);
  return {
    text,
    blocks: [
      { type: "section", text: { type: "plain_text", text } },
      ...(options.length ? [{
        type: "actions" as const, block_id: `codrive-model:${menu.scopeId}`,
        elements: [{
          type: "static_select" as const, action_id: "codrive-model-select",
          placeholder: { type: "plain_text" as const, text: "选择主模型" }, options,
          ...(current ? { initial_option: current } : {}),
        }],
      }] : []),
    ],
  };
}

function modelErrorMessage(error: unknown): string {
  return `模型设置未完成：${error instanceof Error ? error.message : String(error)}`;
}

interface ChannelDetails {
  id?: string;
  name?: string;
  is_im?: boolean;
  is_mpim?: boolean;
  is_member?: boolean;
  is_private?: boolean;
}

function projectChannel(channel: ChannelDetails): SlackChannel | null {
  if (!channel.id || channel.is_im || channel.is_mpim) return null;
  return {
    id: channel.id,
    name: channel.name ?? channel.id,
    isMember: channel.is_member ?? false,
    isPrivate: channel.is_private ?? false,
  };
}

function incomingMessage(event: unknown, eventId: unknown, teamId: unknown): SlackIncomingMessage | null {
  if (typeof event !== "object" || event === null) return null;
  const message = event as Record<string, unknown>;
  if (message.type !== "message" || message.bot_id) return null;
  if (message.subtype !== undefined && message.subtype !== "file_share") return null;
  if (!["im", "channel", "group"].includes(String(message.channel_type))) return null;
  const files = Array.isArray(message.files) ? message.files.flatMap((value) => {
    if (typeof value !== "object" || value === null || typeof value.id !== "string") return [];
    return [{
      id: value.id,
      ...(typeof value.name === "string" ? { name: value.name } : {}),
      ...(typeof value.mimetype === "string" ? { mimetype: value.mimetype } : {}),
      ...(typeof value.url_private === "string" ? { url_private: value.url_private } : {}),
      ...(typeof value.url_private_download === "string" ? { url_private_download: value.url_private_download } : {}),
    }];
  }) : [];
  const text = typeof message.text === "string" ? message.text : "";
  if (
    typeof eventId !== "string" || typeof teamId !== "string" ||
    typeof message.channel !== "string" || typeof message.user !== "string" ||
    (!text.trim() && files.length === 0) || typeof message.ts !== "string"
  ) return null;
  return {
    eventId,
    teamId,
    channelId: message.channel,
    channelType: message.channel_type as SlackIncomingMessage["channelType"],
    userId: message.user,
    text,
    messageTs: message.ts,
    ...(typeof message.thread_ts === "string" ? { threadTs: message.thread_ts } : {}),
    ...(files.length ? { files } : {}),
  };
}
