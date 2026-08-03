import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";

import type {
  CodexGateway,
  CodexTurnStatus,
} from "../application/codex-gateway.js";
import type { InitializeResponse } from "./app-server-protocol/InitializeResponse.js";
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
      env: process.env,
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

  async startTurn(threadId: string, cwd: string, prompt: string): Promise<string> {
    await this.start();
    const response = await this.requireConnection().request<TurnStartResponse>(
      "turn/start",
      {
        threadId,
        cwd,
        approvalPolicy: "never",
        sandboxPolicy: { type: "dangerFullAccess" },
        input: [{ type: "text", text: prompt, text_elements: [] }],
      },
    );
    return response.turn.id;
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    await this.start();
    await this.requireConnection().request("turn/interrupt", { threadId, turnId });
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
