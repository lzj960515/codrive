import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";

import type {
  CodexGateway,
  CodexModelOption,
  CodexTurnSnapshot,
  CodexTurnStatus,
} from "../application/codex-gateway.js";
import type { InitializeResponse } from "./app-server-protocol/InitializeResponse.js";
import type { ModelListResponse } from "./app-server-protocol/v2/ModelListResponse.js";
import type { ThreadResumeResponse } from "./app-server-protocol/v2/ThreadResumeResponse.js";
import type { ThreadReadResponse } from "./app-server-protocol/v2/ThreadReadResponse.js";
import type { ThreadStartResponse } from "./app-server-protocol/v2/ThreadStartResponse.js";
import type { TurnStartResponse } from "./app-server-protocol/v2/TurnStartResponse.js";
import {
  JsonRpcConnection,
  type JsonRpcNotification,
} from "./json-rpc-connection.js";

export interface CodexAppServerOptions {
  executable?: string;
  version?: string;
  onStderr?: (text: string) => void;
  env?: NodeJS.ProcessEnv;
}

export class CodexAppServerClient implements CodexGateway {
  private process: ChildProcessWithoutNullStreams | null = null;
  private connection: JsonRpcConnection | null = null;
  private readonly notifications = new EventEmitter();
  private starting: Promise<void> | null = null;
  private stopping = false;

  constructor(private readonly options: CodexAppServerOptions = {}) {}

  async start(): Promise<void> {
    if (this.connection) {
      return;
    }
    if (this.starting) {
      return this.starting;
    }
    this.stopping = false;
    this.starting = this.startProcess();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private async startProcess(): Promise<void> {
    const command = resolveCodexCommand(this.options.executable);
    this.process = spawn(command.executable, [...command.args, "app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: this.options.env ?? process.env,
    });
    this.process.stderr.on("data", (data: Buffer) => {
      this.options.onStderr?.(data.toString("utf8"));
    });
    this.connection = new JsonRpcConnection(this.process.stdout, this.process.stdin);
    this.connection.onNotification((notification) => {
      this.notifications.emit("notification", notification);
    });
    this.process.once("exit", (code, signal) => {
      this.connection?.close(
        new Error(`Codex App Server exited (${code ?? signal ?? "unknown"})`),
      );
      this.connection = null;
      this.process = null;
      if (!this.stopping) {
        this.notifications.emit("notification", {
          method: "transport/disconnected",
          params: { code, signal },
        } satisfies JsonRpcNotification);
      }
    });

    await this.connection.request<InitializeResponse>("initialize", {
      clientInfo: {
        name: "codrive",
        title: "Codrive",
        version: this.options.version ?? "0.1.0",
      },
      capabilities: {
        experimentalApi: false,
        requestAttestation: false,
      },
    });
    this.connection.notify("initialized", {});
  }

  async startThread(
    cwd: string,
    title: string,
    options: { ephemeral?: boolean } = {},
  ): Promise<string> {
    await this.start();
    const connection = this.requireConnection();
    const response = await connection.request<ThreadStartResponse>("thread/start", {
      cwd,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      serviceName: "codrive",
      ephemeral: options.ephemeral ?? false,
    });
    if (!options.ephemeral) {
      await connection.request("thread/name/set", {
        threadId: response.thread.id,
        name: title,
      });
    }
    return response.thread.id;
  }

  async resumeThread(threadId: string, cwd: string): Promise<void> {
    await this.start();
    await this.requireConnection().request<ThreadResumeResponse>("thread/resume", {
      threadId,
      cwd,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
  }

  async startTurn(
    threadId: string,
    cwd: string,
    prompt: string,
    model: string,
  ): Promise<string> {
    await this.start();
    const response = await this.requireConnection().request<TurnStartResponse>(
      "turn/start",
      {
        threadId,
        cwd,
        approvalPolicy: "never",
        sandboxPolicy: { type: "dangerFullAccess" },
        model,
        input: [{ type: "text", text: prompt, text_elements: [] }],
      },
    );
    return response.turn.id;
  }

  async listModels(): Promise<CodexModelOption[]> {
    await this.start();
    const models: CodexModelOption[] = [];
    let cursor: string | undefined;
    do {
      const response = await this.requireConnection().request<ModelListResponse>(
        "model/list",
        {
          includeHidden: false,
          ...(cursor === undefined ? {} : { cursor }),
        },
      );
      models.push(
        ...response.data.map(({ id, displayName, description, isDefault }) => ({
          id,
          displayName,
          description,
          isDefault,
        })),
      );
      cursor = response.nextCursor ?? undefined;
    } while (cursor !== undefined);
    return models;
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    await this.start();
    await this.requireConnection().request("turn/interrupt", { threadId, turnId });
  }

  async isThreadActive(threadId: string): Promise<boolean> {
    await this.start();
    const response = await this.requireConnection().request<ThreadReadResponse>(
      "thread/read",
      { threadId },
    );
    return response.thread.status.type === "active";
  }

  async readTurnStatus(
    threadId: string,
    turnId: string,
  ): Promise<CodexTurnStatus | null> {
    await this.start();
    const response = await this.requireConnection().request<ThreadReadResponse>(
      "thread/read",
      { threadId, includeTurns: true },
    );
    return response.thread.turns.find(({ id }) => id === turnId)?.status ?? null;
  }

  async readTurnSnapshot(
    threadId: string,
    turnId: string,
  ): Promise<CodexTurnSnapshot> {
    await this.start();
    const response = await this.requireConnection().request<ThreadReadResponse>(
      "thread/read",
      { threadId, includeTurns: true },
    );
    const turn = response.thread.turns.find(({ id }) => id === turnId);
    return {
      threadStatus: response.thread.status.type,
      activeTurnIds: response.thread.turns
        .filter(({ status }) => status === "inProgress")
        .map(({ id }) => id),
      turn: turn
        ? {
            id: turn.id,
            status: turn.status,
            items: turn.items.map((item) => ({
              type: item.type,
              status: safeItemStatus(item),
            })),
          }
        : null,
    };
  }

  onNotification(listener: (notification: JsonRpcNotification) => void): () => void {
    this.notifications.on("notification", listener);
    return () => this.notifications.off("notification", listener);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const child = this.process;
    this.connection?.close();
    this.connection = null;
    this.process = null;
    if (!child || child.exitCode !== null) {
      return;
    }
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.kill("SIGTERM");
    });
  }

  private requireConnection(): JsonRpcConnection {
    if (!this.connection) {
      throw new Error("Codex App Server is not running");
    }
    return this.connection;
  }
}

function safeItemStatus(item: unknown): string | null {
  if (!isRecord(item)) return null;
  return stringValue(item.status);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function resolveCodexCommand(executable?: string): {
  executable: string;
  args: string[];
} {
  if (executable) {
    return { executable, args: [] };
  }
  const require = createRequire(import.meta.url);
  const script = require.resolve("@openai/codex/bin/codex.js");
  return { executable: process.execPath, args: [script] };
}
