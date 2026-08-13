import { spawn } from "node:child_process";

import { ConfigStore } from "./config-store.js";
import { InstanceLock } from "./instance-lock.js";

export type LocalServiceState = "running" | "starting" | "stopped";

export interface LocalServiceStatus {
  state: LocalServiceState;
  url?: string;
  pid?: number;
}

export interface LocalServiceStartResult {
  outcome: "started" | "already_running";
  url: string;
  pid?: number;
}

export interface LocalServiceStopResult {
  outcome: "stopped" | "already_stopped";
}

export interface SpawnedService {
  readonly exitCode: number | null;
  readonly error?: Error | undefined;
}

export interface LocalServiceManagerOptions {
  entryPath: string;
  stateDirectory?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  healthCheck?: (url: string) => Promise<boolean>;
  readOwnerPid?: () => Promise<number | null>;
  isProcessRunning?: (pid: number) => boolean;
  spawnService?: () => SpawnedService;
  stopProcess?: (pid: number) => void;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

const defaultTimeoutMs = 60_000;
const defaultPollIntervalMs = 100;

export class LocalServiceManager {
  private readonly configStore: ConfigStore;
  private readonly lock: InstanceLock;
  private readonly timeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly healthCheck: (url: string) => Promise<boolean>;
  private readonly readOwnerPid: () => Promise<number | null>;
  private readonly isProcessRunning: (pid: number) => boolean;
  private readonly spawnService: () => SpawnedService;
  private readonly stopProcess: (pid: number) => void;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(private readonly options: LocalServiceManagerOptions) {
    this.configStore = new ConfigStore(options.stateDirectory);
    this.lock = new InstanceLock(this.configStore.stateDirectory);
    this.timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
    this.pollIntervalMs = options.pollIntervalMs ?? defaultPollIntervalMs;
    this.healthCheck = options.healthCheck ?? defaultHealthCheck;
    this.readOwnerPid = options.readOwnerPid ?? (() => this.lock.readOwnerPid());
    this.isProcessRunning = options.isProcessRunning ?? processIsRunning;
    this.spawnService = options.spawnService ?? (() => this.spawnDetachedService());
    this.stopProcess = options.stopProcess ?? ((pid) => process.kill(pid, "SIGTERM"));
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? wait;
  }

  async status(): Promise<LocalServiceStatus> {
    let config;
    try {
      config = await this.configStore.read();
    } catch (error) {
      if (isMissingFile(error)) return { state: "stopped" };
      throw error;
    }
    const url = `http://${config.host}:${config.port}`;
    const pid = await this.readOwnerPid();
    const processRunning = pid !== null && this.isProcessRunning(pid);
    if (await this.healthCheck(url)) {
      return {
        state: "running",
        url,
        ...(pid === null ? {} : { pid }),
      };
    }
    if (processRunning) return { state: "starting", url, pid: pid! };
    return { state: "stopped", url };
  }

  async start(): Promise<LocalServiceStartResult> {
    await this.configStore.loadOrCreate();
    const current = await this.status();
    if (current.state === "running") {
      return {
        outcome: "already_running",
        url: current.url!,
        ...(current.pid === undefined ? {} : { pid: current.pid }),
      };
    }

    const spawned = current.state === "starting" ? undefined : this.spawnService();
    const running = await this.waitForState("running", spawned);
    return {
      outcome: "started",
      url: running.url!,
      ...(running.pid === undefined ? {} : { pid: running.pid }),
    };
  }

  async stop(): Promise<LocalServiceStopResult> {
    const current = await this.status();
    if (current.state === "stopped") return { outcome: "already_stopped" };
    if (current.pid === undefined) {
      throw new Error("Codrive is healthy but its service process cannot be identified");
    }
    this.stopProcess(current.pid);
    try {
      await this.waitForState("stopped");
    } catch {
      throw new Error(
        "Codrive could not be stopped; an external service manager may be restarting it",
      );
    }
    return { outcome: "stopped" };
  }

  async restart(): Promise<LocalServiceStartResult> {
    await this.stop();
    return this.start();
  }

  private async waitForState(
    expected: LocalServiceState,
    spawned?: SpawnedService,
  ): Promise<LocalServiceStatus> {
    const deadline = this.now() + this.timeoutMs;
    while (this.now() <= deadline) {
      const status = await this.status();
      if (status.state === expected) return status;
      if (spawned?.error) throw spawned.error;
      if (spawned?.exitCode !== null && spawned?.exitCode !== undefined) {
        throw new Error(`Codrive service exited with code ${spawned.exitCode}`);
      }
      await this.sleep(this.pollIntervalMs);
    }
    throw new Error(`Timed out waiting for Codrive to become ${expected}`);
  }

  private spawnDetachedService(): SpawnedService {
    let spawnError: Error | undefined;
    const child = spawn(process.execPath, [this.options.entryPath, "serve"], {
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        CODEDRIVE_HOME: this.configStore.stateDirectory,
      },
    });
    child.once("error", (error) => {
      spawnError = error;
    });
    child.unref();
    return {
      get exitCode() {
        return child.exitCode;
      },
      get error() {
        return spawnError;
      },
    };
  }
}

async function defaultHealthCheck(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/api/health`, {
      signal: AbortSignal.timeout(1_000),
    });
    if (!response.ok) return false;
    const health = (await response.json()) as { status?: string };
    return health.status === "ok";
  } catch {
    return false;
  }
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
