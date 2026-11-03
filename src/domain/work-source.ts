import { WorkflowConflictError } from "./errors.js";

export interface WorkSource {
  kind: "slack" | "codex_native";
  requestId: string;
}

export interface SlackReplyTarget {
  kind: "slack";
  teamId: string;
  channelId: string;
  threadTs?: string;
}

export interface WorkCommunication {
  source?: WorkSource;
  replyTarget?: SlackReplyTarget;
}

/** 来源与回复位置一起保存，保证登记后的工作始终知道向哪里回报。 */
export function assertWorkCommunication(input: WorkCommunication): void {
  if (input.source === undefined && input.replyTarget === undefined) return;
  if (!isWorkSource(input.source) || !isSlackReplyTarget(input.replyTarget)) {
    throw new WorkflowConflictError(
      "A valid work source and Slack reply destination must be supplied together",
    );
  }
}

export function isWorkSource(value: unknown): value is WorkSource {
  if (!isRecord(value)) return false;
  return (value.kind === "slack" || value.kind === "codex_native") &&
    nonemptyString(value.requestId);
}

export function isSlackReplyTarget(value: unknown): value is SlackReplyTarget {
  if (!isRecord(value)) return false;
  return value.kind === "slack" && nonemptyString(value.teamId) &&
    nonemptyString(value.channelId) &&
    // 一对一私信以 D 开头；项目频道的任务结果始终回到已保存的根消息下。
    (value.threadTs === undefined ? value.channelId.startsWith("D") : nonemptyString(value.threadTs));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
