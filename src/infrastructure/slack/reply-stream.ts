import type { AnyChunk } from "@slack/types";
import type { WebClient } from "@slack/web-api";

import type { SlackProgress, SlackReplyStream } from "../../domain/slack.js";
import type { SlackReplyTarget } from "../../domain/work-source.js";
import { buildSlackMessages } from "./formatting.js";
import { postSlackMessages } from "./delivery.js";

interface ReplyOptions {
  client: WebClient;
  target: SlackReplyTarget;
  recipientUserId: string;
  onError(error: unknown): void;
  onClosed(): void;
}

const processingId = "codrive-reply";
const flushIntervalMs = 1_000;

/** 工具进度实时展示；正文在结束时转为原生 Markdown 和表格，保持单条回复。 */
export class SlackReply implements SlackReplyStream {
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly pending = new Map<string, SlackProgress>();
  private readonly progressItems = new Map<string, SlackProgress>();
  private operations: Promise<void> = Promise.resolve();
  private markdown = "";
  private dirty = false;
  private closed = false;
  private finishing: Promise<{ messageTs: string }> | undefined;

  private constructor(
    private readonly options: ReplyOptions,
    private readonly messageTs: string,
    private readonly nativeStream: boolean,
  ) {
    this.timer = setInterval(() => {
      this.operations = this.operations.then(() => this.flushProgress()).catch((error: unknown) => {
        // 进度失败有日志边界，最终正文仍通过 finish 独立完成送达。
        clearInterval(this.timer);
        this.options.onError(error);
      });
    }, flushIntervalMs);
    this.timer.unref();
  }

  static async start(options: ReplyOptions): Promise<SlackReply> {
    const { client, target, recipientUserId } = options;
    if (target.threadTs) {
      const result = await client.chat.startStream({
        channel: target.channelId,
        thread_ts: target.threadTs,
        recipient_team_id: target.teamId,
        recipient_user_id: recipientUserId,
        task_display_mode: "plan",
        chunks: [
          { type: "plan_update", title: "处理中" },
          { type: "task_update", id: processingId, title: "处理请求", status: "in_progress" },
        ],
      });
      if (!result.ok || !result.ts) throw new Error(result.error ?? "Slack did not start the reply stream");
      return new SlackReply(options, result.ts, true);
    }

    // Slack 原生 stream 必须带 thread_ts；普通私信使用原地更新，保留连续对话。
    const result = await client.chat.postMessage({ channel: target.channelId, text: "正在处理…" });
    if (!result.ok || !result.ts) throw new Error(result.error ?? "Slack did not acknowledge the reply");
    return new SlackReply(options, result.ts, false);
  }

  appendText(text: string): void {
    if (this.closed || this.finishing) return;
    this.markdown += text;
  }

  progress(update: SlackProgress): void {
    if (this.closed || this.finishing) return;
    this.pending.set(update.id, update);
    this.progressItems.set(update.id, update);
    this.dirty = true;
  }

  finish(): Promise<{ messageTs: string }> {
    this.finishing ??= this.finishReply();
    return this.finishing;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    if (this.finishing) {
      await this.finishing;
      return;
    }
    clearInterval(this.timer);
    await this.operations;
    try {
      if (this.nativeStream) {
        await this.options.client.chat.stopStream({ channel: this.options.target.channelId, ts: this.messageTs });
      } else {
        await this.options.client.chat.update({ channel: this.options.target.channelId, ts: this.messageTs, text: "本地连接已暂停。" });
      }
    } finally {
      this.markClosed();
    }
  }

  private async finishReply(): Promise<{ messageTs: string }> {
    clearInterval(this.timer);
    await this.operations;
    const messages = buildSlackMessages(this.markdown);
    const first = messages[0];
    try {
      if (this.nativeStream) {
        const chunks: AnyChunk[] = [
          ...this.takeProgressChunks(),
          { type: "task_update", id: processingId, title: "本轮回复", status: "complete" },
          { type: "plan_update", title: "本轮回复" },
        ];
        const result = await this.options.client.chat.stopStream({
          channel: this.options.target.channelId,
          ts: this.messageTs,
          chunks,
          ...(first ? { blocks: first.blocks } : {}),
        });
        if (!result.ok) throw new Error(result.error ?? "Slack did not finish the reply stream");
      } else {
        const result = await this.options.client.chat.update({
          channel: this.options.target.channelId,
          ts: this.messageTs,
          text: first?.text ?? "本轮处理已结束。",
          ...(first ? { blocks: first.blocks } : {}),
        });
        if (!result.ok) throw new Error(result.error ?? "Slack did not finish the reply");
      }
      if (messages.length > 1) {
        await postSlackMessages(this.options.client, this.options.target, messages, {
          messageTs: this.messageTs,
          nextMessageIndex: 1,
        });
      }
      return { messageTs: this.messageTs };
    } finally {
      this.markClosed();
    }
  }

  private async flushProgress(): Promise<void> {
    if (this.closed || !this.dirty) return;
    if (this.nativeStream) {
      const chunks = this.takeProgressChunks();
      const result = await this.options.client.chat.appendStream({ channel: this.options.target.channelId, ts: this.messageTs, chunks });
      if (!result.ok) throw new Error(result.error ?? "Slack did not acknowledge reply progress");
    } else {
      const lines = [...this.progressItems.values()].map(({ title, status, details }) => {
        const marker = status === "complete" ? "✓" : status === "error" ? "!" : "…";
        return `${marker} ${title}${details ? `：${details}` : ""}`;
      });
      const result = await this.options.client.chat.update({
        channel: this.options.target.channelId,
        ts: this.messageTs,
        text: lines.join("\n").slice(0, 4_000) || "正在处理…",
      });
      if (!result.ok) throw new Error(result.error ?? "Slack did not acknowledge reply progress");
      this.pending.clear();
      this.dirty = false;
    }
  }

  private takeProgressChunks(): AnyChunk[] {
    const updates = [...this.pending.values()];
    this.pending.clear();
    this.dirty = false;
    return updates.map((update) => ({ type: "task_update", ...update }));
  }

  private markClosed(): void {
    clearInterval(this.timer);
    this.closed = true;
    this.options.onClosed();
  }
}
