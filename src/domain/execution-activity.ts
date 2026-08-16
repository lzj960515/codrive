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

export type ExecutionActivitySource = "app_server" | "hook";

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
  source: ExecutionActivitySource;
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

const labels: Record<ExecutionActivityCategory, string> = {
  reading: "正在读取源码",
  searching: "正在搜索",
  editing: "正在编辑文件",
  running_command: "正在运行命令",
  running_tests: "正在运行测试",
  calling_tool: "正在调用工具",
  waiting_input: "正在等待输入",
  preparing_response: "正在整理回复",
};

export function executionActivityLabel(
  category: ExecutionActivityCategory,
): string {
  return labels[category];
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
