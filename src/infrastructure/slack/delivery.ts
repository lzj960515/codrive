import type { WebClient } from "@slack/web-api";

import { SlackDeliveryError, type SlackSendProgress } from "../../domain/slack.js";
import type { SlackReplyTarget } from "../../domain/work-source.js";
import type { SlackFormattedMessage } from "./formatting-types.js";

/** 已成功分段的回执供调用方持久保存，重试从下一段继续。 */
export async function postSlackMessages(
  client: WebClient,
  target: SlackReplyTarget,
  messages: SlackFormattedMessage[],
  resume?: SlackSendProgress,
): Promise<{ messageTs: string }> {
  if (messages.length === 0) throw new Error("Slack message is empty");
  const start = resume?.nextMessageIndex ?? 0;
  if (!Number.isInteger(start) || start < 0 || start > messages.length) {
    throw new Error("Invalid Slack message continuation");
  }
  let messageTs = resume?.messageTs;
  for (let index = start; index < messages.length; index++) {
    const message = messages[index]!;
    try {
      const threadTs = target.threadTs ?? messageTs;
      const result = await client.chat.postMessage({
        channel: target.channelId,
        ...(threadTs ? { thread_ts: threadTs } : {}),
        text: message.text,
        blocks: message.blocks,
        unfurl_links: false,
        unfurl_media: false,
      });
      if (!result.ok || !result.ts) throw new Error(result.error ?? "Slack did not acknowledge the message");
      messageTs ??= result.ts;
    } catch (error) {
      const progress = messageTs ? { messageTs, nextMessageIndex: index } : undefined;
      throw new SlackDeliveryError(
        `Slack message delivery failed: ${error instanceof Error ? error.message : String(error)}`,
        progress,
        { cause: error },
      );
    }
  }
  if (!messageTs) throw new Error("Slack did not return a message timestamp");
  return { messageTs };
}
