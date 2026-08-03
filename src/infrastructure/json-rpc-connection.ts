import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

export interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

interface JsonRpcResponse {
  id: number;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

export class JsonRpcConnection {
  private readonly events = new EventEmitter();
  private readonly pending = new Map<number, PendingRequest>();
  private readonly lines;
  private nextRequestId = 1;
  private closed = false;

  constructor(
    input: Readable,
    private readonly output: Writable,
  ) {
    this.lines = createInterface({ input, crlfDelay: Infinity });
    this.lines.on("line", (line) => this.receive(line));
    this.lines.on("close", () => this.close(new Error("App Server connection closed")));
  }

  request<T>(method: string, params: unknown): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error("App Server connection is closed"));
    }
    const id = this.nextRequestId++;
    const response = new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
    });
    this.write({ id, method, params });
    return response;
  }

  notify(method: string, params: unknown): void {
    if (this.closed) {
      throw new Error("App Server connection is closed");
    }
    this.write({ method, params });
  }

  onNotification(listener: (notification: JsonRpcNotification) => void): () => void {
    this.events.on("notification", listener);
    return () => this.events.off("notification", listener);
  }

  close(error = new Error("App Server connection closed")): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.lines.close();
    for (const request of this.pending.values()) {
      request.reject(error);
    }
    this.pending.clear();
  }

  private receive(line: string): void {
    if (!line.trim()) {
      return;
    }

    let message: JsonRpcResponse | JsonRpcNotification;
    try {
      message = JSON.parse(line) as JsonRpcResponse | JsonRpcNotification;
    } catch {
      this.events.emit("notification", {
        method: "transport/invalidJson",
        params: { line },
      } satisfies JsonRpcNotification);
      return;
    }

    if ("id" in message) {
      const request = this.pending.get(message.id);
      if (!request) {
        return;
      }
      this.pending.delete(message.id);
      if (message.error) {
        request.reject(
          new Error(
            `App Server request failed${message.error.code ? ` (${message.error.code})` : ""}: ${message.error.message ?? "Unknown error"}`,
          ),
        );
      } else {
        request.resolve(message.result);
      }
      return;
    }

    this.events.emit("notification", message);
  }

  private write(message: unknown): void {
    this.output.write(`${JSON.stringify(message)}\n`);
  }
}
