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
