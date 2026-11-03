import type { DecisionReplyTarget } from "./decision-reply.js";
import type { SlackIncomingMessage, SlackSendProgress } from "./slack.js";
import type { SlackReplyTarget, WorkSource } from "./work-source.js";

export interface SlackConversation {
  id: string;
  conversationType: "direct_message" | "channel_thread";
  teamId: string;
  channelId: string;
  threadTs?: string;
  projectId?: string;
  codexThreadId: string;
  createdAt: string;
  updatedAt: string;
}

export interface SlackInputReceipt {
  id: string;
  message: SlackIncomingMessage;
  target: SlackReplyTarget;
  conversationId: string;
  projectId?: string;
  status: "pending" | "running" | "completed" | "failed";
  turnId?: string;
  replyText?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SlackDeliveryRecord {
  id: string;
  target: SlackReplyTarget;
  markdown: string;
  createdAt: string;
  projectId?: string;
  source?: WorkSource;
  decision?: DecisionReplyTarget;
  messageTs?: string;
  sentAt?: string;
  error?: string;
  progress?: SlackSendProgress;
}
