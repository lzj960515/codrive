import type {
  CodexActivityEvent,
  CodexActivityGateway,
} from "./codex-gateway.js";
import type {
  ExecutionActivityCategory,
  ExecutionActivitySignal,
  ExecutionActivityUpdate,
  HookActivityInput,
} from "../domain/execution-activity.js";
import {
  classifyActivityTool,
  executionActivityLabel,
} from "../domain/execution-activity.js";
import type { TaskExecution } from "../domain/types.js";
import type { ProjectStore } from "../infrastructure/project-store.js";

interface ExecutionActivityBridgeOptions {
  store: Pick<ProjectStore, "findTask" | "findTaskByTurnId" | "subscribe">;
  codex: CodexActivityGateway;
}

const activeSignalStatuses = new Set(["pending", "running"]);

export class ExecutionActivityBridge {
  private readonly latestByTask = new Map<string, ExecutionActivitySignal>();
  private readonly listeners = new Set<(update: ExecutionActivityUpdate) => void>();
  private readonly unsubscribeCodex: () => void;
  private readonly unsubscribeStore: () => void;
  private codexEventQueue = Promise.resolve();

  constructor(private readonly options: ExecutionActivityBridgeOptions) {
    this.unsubscribeCodex = options.codex.onActivity((event) => {
      this.codexEventQueue = this.codexEventQueue.then(
        () => this.acceptCodexEvent(event),
        () => this.acceptCodexEvent(event),
      );
    });
    this.unsubscribeStore = options.store.subscribe((event) => {
      if (event.taskId) void this.synchronize(event.taskId).catch(() => undefined);
    });
  }

  subscribe(listener: (update: ExecutionActivityUpdate) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async recordHook(input: HookActivityInput): Promise<boolean> {
    const found = await this.options.store.findTaskByTurnId(input.turnId);
    if (!found) return false;
    const execution = found.task.currentExecution;
    if (!isObservableExecution(execution) || execution.turnId !== input.turnId) {
      return false;
    }
    return this.record({
      projectId: found.project.id,
      taskId: found.task.id,
      action: execution.action,
      attemptId: execution.attemptId,
      threadId: execution.threadId,
      turnId: execution.turnId,
      category: hookCategory(input.event, input.toolName),
      label: executionActivityLabel(hookCategory(input.event, input.toolName)),
      occurredAt: input.occurredAt,
      source: "hook",
    });
  }

  async read(taskId: string): Promise<ExecutionActivitySignal | null> {
    const cached = this.latestByTask.get(taskId);
    if (cached) {
      if (await this.isCurrent(cached)) return cached;
      this.clear(taskId);
    }

    const found = await this.options.store.findTask(taskId);
    const execution = found?.task.currentExecution;
    if (!found || !isObservableExecution(execution)) return null;

    let observation;
    try {
      observation = await this.options.codex.readTurnActivity(
        execution.threadId,
        execution.turnId,
      );
    } catch {
      return null;
    }
    if (observation?.status !== "inProgress" || !observation.activity) return null;

    const signal: ExecutionActivitySignal = {
      projectId: found.project.id,
      taskId: found.task.id,
      action: execution.action,
      attemptId: execution.attemptId,
      threadId: execution.threadId,
      turnId: execution.turnId,
      category: observation.activity.category,
      label: executionActivityLabel(observation.activity.category),
      occurredAt: observation.activity.occurredAt,
      source: "app_server",
    };
    return (await this.record(signal)) ? signal : null;
  }

  async isCurrent(signal: ExecutionActivitySignal): Promise<boolean> {
    const found = await this.options.store.findTask(signal.taskId);
    if (!found || found.project.id !== signal.projectId) return false;
    return matchesExecution(signal, found.task.currentExecution);
  }

  async synchronize(taskId: string): Promise<void> {
    const cached = this.latestByTask.get(taskId);
    if (cached && !(await this.isCurrent(cached))) this.clear(taskId);
  }

  close(): void {
    this.unsubscribeCodex();
    this.unsubscribeStore();
    this.latestByTask.clear();
    this.listeners.clear();
  }

  private async acceptCodexEvent(event: CodexActivityEvent): Promise<void> {
    const found = await this.options.store.findTaskByTurnId(event.turnId);
    const execution = found?.task.currentExecution;
    if (
      !found ||
      !isObservableExecution(execution) ||
      execution.threadId !== event.threadId ||
      execution.turnId !== event.turnId
    ) {
      return;
    }
    if (event.type === "turn_ended") {
      this.clear(found.task.id);
      return;
    }
    await this.record({
      projectId: found.project.id,
      taskId: found.task.id,
      action: execution.action,
      attemptId: execution.attemptId,
      threadId: execution.threadId,
      turnId: execution.turnId,
      category: event.category,
      label: executionActivityLabel(event.category),
      occurredAt: event.occurredAt,
      source: "app_server",
    });
  }

  private async record(signal: ExecutionActivitySignal): Promise<boolean> {
    if (!(await this.isCurrent(signal))) return false;
    this.latestByTask.set(signal.taskId, signal);
    if (!(await this.isCurrent(signal))) {
      this.clear(signal.taskId);
      return false;
    }
    this.publish({ taskId: signal.taskId, activity: signal });
    return true;
  }

  private clear(taskId: string): void {
    if (!this.latestByTask.delete(taskId)) return;
    this.publish({ taskId, activity: null });
  }

  private publish(update: ExecutionActivityUpdate): void {
    for (const listener of this.listeners) listener(update);
  }
}

function isObservableExecution(
  execution: TaskExecution | undefined,
): execution is TaskExecution & { threadId: string; turnId: string } {
  return Boolean(
    execution?.threadId &&
      execution.turnId &&
      activeSignalStatuses.has(execution.status),
  );
}

function matchesExecution(
  signal: ExecutionActivitySignal,
  execution: TaskExecution | undefined,
): boolean {
  return Boolean(
    isObservableExecution(execution) &&
      execution.action === signal.action &&
      execution.attemptId === signal.attemptId &&
      execution.threadId === signal.threadId &&
      execution.turnId === signal.turnId,
  );
}

function hookCategory(
  event: HookActivityInput["event"],
  toolName?: string,
): ExecutionActivityCategory {
  if (event === "UserPromptSubmit" || event === "Stop") {
    return "preparing_response";
  }
  return classifyActivityTool(toolName);
}
