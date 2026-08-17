import type { TaskAction } from "./types.js";

export type ExecutionActivityCategory =
  | "reading"
  | "searching"
  | "editing"
  | "running_command"
  | "running_tests"
  | "calling_tool"
  | "waiting_input"
  | "preparing_response";

export interface ExecutionActivitySignal {
  projectId: string;
  taskId: string;
  action: TaskAction;
  attemptId: string;
  threadId: string;
  turnId: string;
  category: ExecutionActivityCategory;
  label: string;
  occurredAt: string;
  source: "hook";
}

export interface ExecutionActivityUpdate {
  taskId: string;
  activity: ExecutionActivitySignal | null;
}

export interface HookActivityInput {
  schemaVersion: 1;
  sessionId: string;
  turnId: string;
  event: "UserPromptSubmit" | "PreToolUse" | "PostToolUse" | "Stop";
  toolName?: string;
  occurredAt: string;
}

export function classifyActivityTool(
  toolName?: string,
): ExecutionActivityCategory {
  const name = toolName?.toLowerCase() ?? "";
  if (/test|vitest|jest/.test(name)) return "running_tests";
  if (/apply_patch|edit|write/.test(name)) return "editing";
  if (/search|grep|glob|find/.test(name)) return "searching";
  if (/read|view/.test(name)) return "reading";
  if (/request.*input|ask/.test(name)) return "waiting_input";
  if (/bash|exec|command|write_stdin/.test(name)) return "running_command";
  return "calling_tool";
}

export function describeHookActivity(
  event: HookActivityInput["event"],
  toolName?: string,
): { category: ExecutionActivityCategory; label: string } | null {
  if (event === "Stop") return null;
  if (event === "UserPromptSubmit") {
    return { category: "preparing_response", label: "正在处理任务" };
  }
  const displayName = toolName ?? "工具";
  return {
    category: classifyActivityTool(toolName),
    label: event === "PreToolUse"
      ? `正在调用 ${displayName}`
      : `正在处理 ${displayName} 的结果`,
  };
}
