import type { ReasoningEffort } from "../domain/types.js";

export type CodexTurnStatus =
  | "completed"
  | "interrupted"
  | "failed"
  | "inProgress";

export interface CodexAgentMessage {
  text: string;
  phase?: "commentary" | "final_answer" | null;
}

export interface CodexModelOption {
  id: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  supportedReasoningEfforts: Array<{ reasoningEffort: ReasoningEffort; description: string }>;
  defaultReasoningEffort: ReasoningEffort;
}

export interface CodexTurnSnapshot {
  threadStatus: "notLoaded" | "idle" | "systemError" | "active";
  activeTurnIds: string[];
  turn: {
    id: string;
    status: CodexTurnStatus;
    items: Array<{ type: string; status: string | null }>;
  } | null;
}

export interface CodexTokenUsageBreakdown {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface CodexThreadRuntimeStatus {
  threadId: string;
  status: string;
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  cwd: string;
  approvalPolicy: string | null;
  sandboxPolicy: string | null;
  tokenUsage: {
    total: CodexTokenUsageBreakdown;
    last: CodexTokenUsageBreakdown;
    modelContextWindow: number | null;
  } | null;
}

export interface CodexThreadStatusReader {
  readThreadRuntime(threadId: string): Promise<CodexThreadRuntimeStatus>;
}

export interface CodexGateway {
  startThread(
    cwd: string,
    title: string,
  ): Promise<string>;
  resumeThread(threadId: string, cwd: string): Promise<void>;
  setThreadName(threadId: string, name: string): Promise<void>;
  startTurn(
    threadId: string,
    cwd: string,
    prompt: string,
    model: string,
    reasoningEffort?: ReasoningEffort,
  ): Promise<string>;
  hasSkill(cwd: string, skillName: string): Promise<boolean>;
  listModels(): Promise<CodexModelOption[]>;
  interruptTurn(threadId: string, turnId: string): Promise<void>;
  isThreadActive(threadId: string): Promise<boolean>;
  readTurnStatus(threadId: string, turnId: string): Promise<CodexTurnStatus | null>;
  readTurnSnapshot(threadId: string, turnId: string): Promise<CodexTurnSnapshot>;
}
