import type { ExecutionActivityCategory } from "../domain/execution-activity.js";

export type CodexTurnStatus =
  | "completed"
  | "interrupted"
  | "failed"
  | "inProgress";

export interface CodexModelOption {
  id: string;
  displayName: string;
  description: string;
  isDefault: boolean;
}

export type CodexActivityEvent =
  | {
      type: "activity";
      threadId: string;
      turnId: string;
      category: ExecutionActivityCategory;
      occurredAt: string;
    }
  | {
      type: "turn_ended";
      threadId: string;
      turnId: string;
      occurredAt: string;
    };

export interface CodexTurnActivity {
  status: CodexTurnStatus;
  activity: {
    category: ExecutionActivityCategory;
    occurredAt: string;
  } | null;
}

export interface CodexActivityGateway {
  readTurnActivity(
    threadId: string,
    turnId: string,
  ): Promise<CodexTurnActivity | null>;
  onActivity(listener: (event: CodexActivityEvent) => void): () => void;
}

export interface CodexGateway {
  startThread(
    cwd: string,
    title: string,
    options?: { ephemeral?: boolean },
  ): Promise<string>;
  resumeThread(threadId: string, cwd: string): Promise<void>;
  startTurn(
    threadId: string,
    cwd: string,
    prompt: string,
    model: string,
  ): Promise<string>;
  listModels(): Promise<CodexModelOption[]>;
  interruptTurn(threadId: string, turnId: string): Promise<void>;
  isThreadActive(threadId: string): Promise<boolean>;
  readTurnStatus(threadId: string, turnId: string): Promise<CodexTurnStatus | null>;
}
