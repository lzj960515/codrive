import type { ThreadReadResponse } from "./app-server-protocol/v2/ThreadReadResponse.js";
import type { ThreadResumeResponse } from "./app-server-protocol/v2/ThreadResumeResponse.js";
import type { ThreadUnsubscribeResponse } from "./app-server-protocol/v2/ThreadUnsubscribeResponse.js";
import type { TurnStartParams } from "./app-server-protocol/v2/TurnStartParams.js";
import type { TurnStartResponse } from "./app-server-protocol/v2/TurnStartResponse.js";
import type { JsonRpcConnection } from "./json-rpc-connection.js";

// App Server 自身关闭最多等待 10 秒，额外留出通知传输时间。
const threadCloseTimeoutMs = 15_000;

/** 一个连接对原会话的订阅与回合生命周期。 */
export class CodexThreadSession {
  private operations: Promise<void> = Promise.resolve();
  private turnId: string | undefined;
  private closing: { resolve(): void; reject(error: Error): void } | undefined;

  constructor(
    private readonly connection: JsonRpcConnection,
    private readonly threadId: string,
    private subscribed = false,
  ) {}

  resume(cwd: string): Promise<void> {
    return this.serialize(() => this.subscribe(cwd));
  }

  startTurn(cwd: string, params: TurnStartParams): Promise<string> {
    return this.serialize(async () => {
      if (!this.subscribed) await this.subscribe(cwd);
      try {
        const response = await this.connection.request<TurnStartResponse>("turn/start", params);
        this.turnId = response.turn.id;
        return response.turn.id;
      } catch (error) {
        await this.releaseAfterFailedStart(error);
        throw error;
      }
    });
  }

  releaseCompletedTurn(turnId: string): Promise<void> {
    return this.serialize(async () => {
      // 完成通知可能迟到或重复；只能释放最后一次派发的回合。
      if (!this.subscribed || this.turnId !== turnId) return;
      this.turnId = undefined;
      await this.unsubscribe();
    });
  }

  closed(): void {
    this.subscribed = false;
    this.turnId = undefined;
    this.closing?.resolve();
  }

  disconnected(error: Error): void {
    this.subscribed = false;
    this.closing?.reject(error);
  }

  private async subscribe(cwd: string): Promise<void> {
    const response = await this.connection.request<ThreadResumeResponse>("thread/resume", {
      threadId: this.threadId,
      cwd,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
    this.subscribed = true;
    const activeTurn = response.thread.turns?.find((turn) => turn.status === "inProgress");
    // 恢复快照可能已终止，但对应完成通知仍在队列中等待释放。
    if (activeTurn) this.turnId = activeTurn.id;
  }

  private async releaseAfterFailedStart(startError: unknown): Promise<void> {
    try {
      const snapshot = await this.connection.request<ThreadReadResponse>("thread/read", {
        threadId: this.threadId,
        includeTurns: true,
      });
      const hasActiveTurn = snapshot.thread.turns.some((turn) => turn.status === "inProgress");
      if (snapshot.thread.status.type === "idle" && !hasActiveTurn) await this.unsubscribe();
    } catch (releaseError) {
      const message = startError instanceof Error ? startError.message : String(startError);
      throw new Error(`${message}; failed to release idle conversation: ${releaseError instanceof Error ? releaseError.message : String(releaseError)}`, { cause: startError });
    }
  }

  private async unsubscribe(): Promise<void> {
    const closed = new Promise<void>((resolve, reject) => {
      this.closing = { resolve, reject };
    });
    const timer = setTimeout(() => {
      this.closing?.reject(new Error(`Timed out waiting for thread ${this.threadId} to close after unsubscribe`));
    }, threadCloseTimeoutMs);
    try {
      // 先登记关闭通知，再发请求；返回 unsubscribed 不等于已经释放写入锁。
      const unsubscribe = this.connection.request<ThreadUnsubscribeResponse>("thread/unsubscribe", {
        threadId: this.threadId,
      }).then((response) => {
        this.subscribed = false;
        if (response.status === "notLoaded") this.closed();
      });
      await Promise.all([unsubscribe, closed]);
    } finally {
      clearTimeout(timer);
      this.closing = undefined;
    }
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operations.then(operation);
    // 调用方接收错误；队列仍允许下一次恢复原会话。
    this.operations = result.then(() => undefined, () => undefined);
    return result;
  }
}
