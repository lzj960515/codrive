import type { DecisionReplyTarget } from "./decision-reply.js";
import type { SlackReplyTarget, WorkSource } from "./work-source.js";

export interface SlackPendingDecision extends DecisionReplyTarget {
  question: string;
}

export interface SlackInputContext {
  codexThreadId: string;
  conversationType: "direct_message" | "channel_thread";
  projectId: string | null;
  projectName: string | null;
  repositoryPath: string | null;
  source: WorkSource;
  replyTarget: SlackReplyTarget;
}

export interface SlackProjectBinding {
  projectId: string;
  channelId: string;
}

export interface SlackProjectBindingStatus {
  binding: SlackProjectBinding | null;
  channel: SlackChannel | null;
  teamId: string | null;
}

export interface SlackConfig {
  enabled: boolean;
  teamId: string;
  authorizedUserId: string;
  botToken: string;
  appToken: string;
  projectBindings: SlackProjectBinding[];
}

export type SlackConfigureInput = Omit<SlackConfig, "projectBindings">;

export interface SlackIncomingFile {
  id: string;
  name?: string;
  mimetype?: string;
  url_private?: string;
  url_private_download?: string;
}

export interface SlackLocalFile {
  id: string;
  name: string;
  mimetype?: string;
  path: string;
}

export interface SlackIncomingMessage {
  eventId: string;
  teamId: string;
  channelId: string;
  channelType: "im" | "channel" | "group";
  userId: string;
  text: string;
  messageTs: string;
  threadTs?: string;
  files?: SlackIncomingFile[];
}

export interface SlackChannel {
  id: string;
  name: string;
  isMember: boolean;
  isPrivate: boolean;
}

export interface SlackCreateProjectChannelInput {
  projectId: string;
  name: string;
  isPrivate?: boolean;
  channelId?: string;
}

export interface SlackProjectChannelResult {
  channel: SlackChannel;
  binding: SlackProjectBinding;
  created: boolean;
  invitedUserId: string;
}

export interface SlackProjectChannelFailure {
  stage: "create" | "invite" | "bind";
  created: boolean;
  channel?: SlackChannel;
  slackError?: string;
  requiredScope?: string;
  candidates?: SlackChannel[];
}

/** 保留远端已创建频道的回执，使后续重试能明确续办。 */
export class SlackProjectChannelError extends Error {
  override readonly name = "SlackProjectChannelError";

  constructor(message: string, readonly details: SlackProjectChannelFailure) {
    super(message);
  }
}

export interface SlackModelContext {
  teamId: string;
  userId: string;
  channelId: string;
}

export interface SlackModelMenu {
  scopeId: string;
  scopeLabel: string;
  primary: string;
  fallback: string;
  models: Array<{ id: string; displayName: string }>;
}

export interface SlackModelControls {
  read(context: SlackModelContext): Promise<SlackModelMenu>;
  select(context: SlackModelContext, modelId: string, expectedScopeId?: string): Promise<SlackModelMenu>;
}

export interface SlackStatusContext extends SlackModelContext {
  threadTs?: string;
  conversationId?: string;
}

export interface SlackStatusView {
  text: string;
  conversations: Array<{ id: string; label: string }>;
}

export interface SlackStatusControls {
  read(context: SlackStatusContext): Promise<SlackStatusView>;
}

export interface SlackConversationContext {
  teamId: string;
  userId: string;
  channelId: string;
}

export interface SlackConversationControls {
  startNew(context: SlackConversationContext): Promise<void>;
}

export interface SlackProgress {
  id: string;
  title: string;
  status: "in_progress" | "complete" | "error";
  details?: string;
}

export interface SlackReplyStream {
  appendText(text: string): void;
  progress(update: SlackProgress): void;
  finish(): Promise<{ messageTs: string }>;
}

export interface SlackSendProgress {
  messageTs: string;
  nextMessageIndex: number;
}

export class SlackDeliveryError extends Error {
  constructor(message: string, readonly progress?: SlackSendProgress, options?: ErrorOptions) {
    super(message, options);
    this.name = "SlackDeliveryError";
  }
}

export interface SlackTransport {
  start(onMessage: (message: SlackIncomingMessage) => Promise<void>, modelControls: SlackModelControls, statusControls: SlackStatusControls, conversationControls: SlackConversationControls): Promise<void>;
  stop(): Promise<void>;
  sendMessage(target: SlackReplyTarget, markdown: string, resume?: SlackSendProgress): Promise<{ messageTs: string }>;
  getChannel(id: string): Promise<SlackChannel>;
  listChannels(): Promise<SlackChannel[]>;
  createChannel(input: { name: string; isPrivate: boolean }): Promise<SlackChannel>;
  inviteToChannel(channelId: string, userId: string): Promise<void>;
  startReply(target: SlackReplyTarget, recipientUserId: string): Promise<SlackReplyStream>;
  downloadFiles(teamId: string, files: SlackIncomingFile[]): Promise<SlackLocalFile[]>;
  sendFile(target: SlackReplyTarget, input: { filePath: string; title?: string; comment?: string }): Promise<{ id: string; name: string; permalink?: string }>;
}
