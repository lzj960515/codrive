import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

import type {
  CodriveEvent,
  LifecycleEvent,
  LifecycleEventComponent,
  LifecycleEventSource,
  LifecycleState,
  Project,
  Task,
} from "../domain/types.js";
import type { ProjectStore } from "../infrastructure/project-store.js";

export interface LifecycleContext {
  source: LifecycleEventSource;
  component?: LifecycleEventComponent;
  commandId?: string;
  correlationId?: string;
  causationId?: string;
}

export type LifecycleEventInput = Omit<
  LifecycleEvent,
  "eventId" | "occurredAt" | "schemaVersion"
>;

export interface LifecycleRecorderOptions {
  now?: () => string;
  createId?: (prefix: string) => string;
  onEvent?: (event: LifecycleEvent) => void;
}

export class LifecycleRecorder {
  private readonly context = new AsyncLocalStorage<LifecycleContext>();
  private readonly now: () => string;
  private readonly createId: (prefix: string) => string;

  constructor(
    private readonly store: ProjectStore,
    private readonly options: LifecycleRecorderOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.createId = options.createId ?? ((prefix) => `${prefix}_${randomUUID()}`);
  }

  run<T>(context: LifecycleContext, operation: () => T): T {
    const current = this.context.getStore();
    return this.context.run({ ...current, ...context }, operation);
  }

  async record(input: LifecycleEventInput): Promise<LifecycleEvent> {
    const context = this.context.getStore();
    const event: LifecycleEvent = {
      schemaVersion: 1,
      eventId: this.createId("event"),
      occurredAt: this.now(),
      component: input.component ?? context?.component ?? "workflow",
      source: input.source ?? context?.source ?? "scheduler",
      ...(context?.commandId ? { commandId: context.commandId } : {}),
      ...(context?.correlationId ? { correlationId: context.correlationId } : {}),
      ...(context?.causationId ? { causationId: context.causationId } : {}),
      ...input,
    };
    if (event.projectId) {
      await this.store.appendEvent(event as CodriveEvent, {
        captureState: capturesSnapshot(event.type),
      });
    }
    this.options.onEvent?.(event);
    return event;
  }

  id(prefix: string): string {
    return this.createId(prefix);
  }
}

function capturesSnapshot(type: string): boolean {
  return ![
    "command.",
    "recovery.",
    "app_server.",
    "workflow.",
  ].some((prefix) => type.startsWith(prefix));
}

export function projectLifecycleState(project: Project): LifecycleState {
  return {
    status: project.status,
    scheduling: project.scheduling,
    requestedAction: project.requestedAction,
    ...(project.currentExecution
      ? {
          attemptId: project.currentExecution.attemptId,
          action: project.currentExecution.action,
          executionStatus: project.currentExecution.status,
          ...(project.currentExecution.threadId
            ? { threadId: project.currentExecution.threadId }
            : {}),
          ...(project.currentExecution.turnId
            ? { turnId: project.currentExecution.turnId }
            : {}),
        }
      : {}),
  };
}

export function taskLifecycleState(task: Task): LifecycleState {
  return {
    status: task.status,
    requestedAction: task.requestedAction,
    ...(task.currentExecution
      ? {
          attemptId: task.currentExecution.attemptId,
          action: task.currentExecution.action,
          executionStatus: task.currentExecution.status,
          ...(task.currentExecution.threadId
            ? { threadId: task.currentExecution.threadId }
            : {}),
          ...(task.currentExecution.turnId
            ? { turnId: task.currentExecution.turnId }
            : {}),
        }
      : {}),
  };
}
