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
import type {
  TaskExecution,
  TaskExecutionIdentity,
} from "../domain/types.js";
import type { ProjectStore } from "../infrastructure/project-store.js";

interface ExecutionActivityBridgeOptions {
  store: Pick<
    ProjectStore,
    "findTask" | "findTaskByTurnId" | "listProjects" | "subscribe"
  >;
  codex: CodexActivityGateway;
  now?: (() => Date) | undefined;
}

const activeSignalStatuses = new Set(["pending", "running", "awaiting_report"]);

export interface ExecutionSilenceClaim extends TaskExecutionIdentity {
  lastSeenAt: string;
}

interface ExecutionObservation extends ExecutionSilenceClaim {
  checking: boolean;
  retryAt?: number;
}

export class ExecutionActivityBridge {
  private readonly latestByTask = new Map<string, ExecutionActivitySignal>();
  private readonly observationsByTask = new Map<string, ExecutionObservation>();
  private readonly listeners = new Set<(update: ExecutionActivityUpdate) => void>();
  private readonly unsubscribeCodex: () => void;
  private readonly unsubscribeStore: () => void;
  private codexEventQueue = Promise.resolve();
  private readonly now: () => Date;
  private closed = false;

  constructor(private readonly options: ExecutionActivityBridgeOptions) {
    this.now = options.now ?? (() => new Date());
    this.unsubscribeCodex = options.codex.onActivity((event) => {
      if (this.closed) return;
      this.codexEventQueue = this.codexEventQueue.then(
        () => this.acceptCodexEvent(event),
        () => this.acceptCodexEvent(event),
      );
    });
    this.unsubscribeStore = options.store.subscribe((event) => {
      if (!this.closed && event.taskId) {
        void this.synchronize(event.taskId).catch(() => undefined);
      }
    });
  }

  subscribe(listener: (update: ExecutionActivityUpdate) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async initialize(observedAt = this.now()): Promise<void> {
    for (const snapshot of await this.options.store.listProjects()) {
      for (const task of snapshot.tasks) {
        this.synchronizeObservation(
          snapshot.project.id,
          task.id,
          task.currentExecution,
          observedAt,
        );
      }
    }
  }

  claimSilentExecutions(
    now: Date,
    silenceThresholdMs: number,
  ): ExecutionSilenceClaim[] {
    const claims: ExecutionSilenceClaim[] = [];
    for (const observation of this.observationsByTask.values()) {
      const lastSeen = Date.parse(observation.lastSeenAt);
      if (
        observation.checking ||
        now.getTime() - lastSeen < silenceThresholdMs ||
        (observation.retryAt !== undefined && observation.retryAt > now.getTime())
      ) {
        continue;
      }
      observation.checking = true;
      claims.push(silenceClaim(observation));
    }
    return claims;
  }

  isSilenceClaimCurrent(claim: ExecutionSilenceClaim): boolean {
    const observation = this.observationsByTask.get(claim.taskId);
    return Boolean(
      observation?.checking &&
        observation.lastSeenAt === claim.lastSeenAt &&
        sameExecutionObservation(observation, claim),
    );
  }

  finishSilenceCheck(
    claim: ExecutionSilenceClaim,
    result: { observedAt?: Date; retryAt?: Date },
  ): void {
    if (!this.isSilenceClaimCurrent(claim)) return;
    const observation = this.observationsByTask.get(claim.taskId)!;
    observation.checking = false;
    if (result.observedAt) {
      observation.lastSeenAt = result.observedAt.toISOString();
      delete observation.retryAt;
      return;
    }
    if (result.retryAt) observation.retryAt = result.retryAt.getTime();
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

  async synchronize(taskId: string, observedAt = this.now()): Promise<void> {
    if (this.closed) return;
    const cached = this.latestByTask.get(taskId);
    if (cached && !(await this.isCurrent(cached))) this.clear(taskId);
    const found = await this.options.store.findTask(taskId);
    this.synchronizeObservation(
      found?.project.id,
      taskId,
      found?.task.currentExecution,
      observedAt,
    );
  }

  close(): void {
    this.closed = true;
    this.unsubscribeCodex();
    this.unsubscribeStore();
    this.latestByTask.clear();
    this.observationsByTask.clear();
    this.listeners.clear();
  }

  private async acceptCodexEvent(event: CodexActivityEvent): Promise<void> {
    if (this.closed) return;
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
    this.touchExecution(found.project.id, found.task.id, execution);
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
    await this.touchSignal(signal);
    const latest = this.latestByTask.get(signal.taskId);
    if (
      latest &&
      sameExecutionIdentity(latest, signal) &&
      Date.parse(signal.occurredAt) < Date.parse(latest.occurredAt)
    ) {
      return false;
    }
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

  private async touchSignal(signal: ExecutionActivitySignal): Promise<void> {
    const found = await this.options.store.findTask(signal.taskId);
    const execution = found?.task.currentExecution;
    if (
      !found ||
      found.project.id !== signal.projectId ||
      !isObservableExecution(execution) ||
      !matchesExecution(signal, execution)
    ) {
      return;
    }
    this.synchronizeObservation(
      signal.projectId,
      signal.taskId,
      execution,
      this.now(),
      true,
    );
  }

  private touchExecution(
    projectId: string,
    taskId: string,
    execution: TaskExecution & { threadId: string; turnId: string },
  ): void {
    this.synchronizeObservation(projectId, taskId, execution, this.now(), true);
  }

  private synchronizeObservation(
    projectId: string | undefined,
    taskId: string,
    execution: TaskExecution | undefined,
    observedAt: Date,
    refresh = false,
  ): void {
    if (!projectId || !isObservableExecution(execution)) {
      this.observationsByTask.delete(taskId);
      return;
    }
    const current = this.observationsByTask.get(taskId);
    const identity = executionObservation(projectId, taskId, execution, observedAt);
    if (!current || !sameExecutionObservation(current, identity)) {
      this.observationsByTask.set(taskId, identity);
      return;
    }
    if (!refresh) return;
    current.lastSeenAt = observedAt.toISOString();
    current.checking = false;
    delete current.retryAt;
  }
}

function executionObservation(
  projectId: string,
  taskId: string,
  execution: TaskExecution & { threadId: string; turnId: string },
  observedAt: Date,
): ExecutionObservation {
  return {
    projectId,
    taskId,
    action: execution.action,
    attemptId: execution.attemptId,
    executionStatus: execution.status,
    threadId: execution.threadId,
    turnId: execution.turnId,
    lastSeenAt: observedAt.toISOString(),
    checking: false,
  };
}

function silenceClaim(observation: ExecutionObservation): ExecutionSilenceClaim {
  const { checking: _checking, retryAt: _retryAt, ...claim } = observation;
  return claim;
}

function sameExecutionObservation(
  left: ExecutionSilenceClaim,
  right: ExecutionSilenceClaim,
): boolean {
  return (
    left.projectId === right.projectId &&
    left.taskId === right.taskId &&
    left.action === right.action &&
    left.attemptId === right.attemptId &&
    left.executionStatus === right.executionStatus &&
    left.threadId === right.threadId &&
    left.turnId === right.turnId
  );
}

function sameExecutionIdentity(
  left: ExecutionActivitySignal,
  right: ExecutionActivitySignal,
): boolean {
  return (
    left.projectId === right.projectId &&
    left.taskId === right.taskId &&
    left.action === right.action &&
    left.attemptId === right.attemptId &&
    left.threadId === right.threadId &&
    left.turnId === right.turnId
  );
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
