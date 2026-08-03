export type CodexTurnStatus =
  | "completed"
  | "interrupted"
  | "failed"
  | "inProgress";

export interface CodexGateway {
  startThread(
    cwd: string,
    title: string,
    options?: { ephemeral?: boolean },
  ): Promise<string>;
  resumeThread(threadId: string, cwd: string): Promise<void>;
  startTurn(threadId: string, cwd: string, prompt: string): Promise<string>;
  interruptTurn(threadId: string, turnId: string): Promise<void>;
  readTurnStatus(threadId: string, turnId: string): Promise<CodexTurnStatus | null>;
}
