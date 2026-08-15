import type { UpgradeState } from "../domain/system-update.js";
import type { UpgradeStateStore } from "../infrastructure/upgrade-state-store.js";
import type {
  SystemUpdateChangedEvent,
  SystemUpdateEventSource,
  UpgradeStateChangedEvent,
} from "./system-update-events.js";

interface UpgradeStateChangeMonitorOptions {
  store: Pick<UpgradeStateStore, "read">;
  intervalMs?: number;
  onError?: (error: unknown) => void;
}

const defaultObservationIntervalMs = 100;

export class UpgradeStateChangeMonitor implements SystemUpdateEventSource {
  private readonly intervalMs: number;
  private readonly listeners = new Set<
    (event: SystemUpdateChangedEvent) => void
  >();
  private timer: NodeJS.Timeout | null = null;
  private lastObservedState: UpgradeState | null = null;
  private observationQueue = Promise.resolve();
  private started = false;

  constructor(private readonly options: UpgradeStateChangeMonitorOptions) {
    this.intervalMs = options.intervalMs ?? defaultObservationIntervalMs;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    try {
      this.lastObservedState = await this.options.store.read();
    } catch (error) {
      this.started = false;
      throw error;
    }
    if (!this.started) return;
    this.timer = setInterval(() => this.enqueueObservation(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    this.started = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  subscribe(
    listener: (event: SystemUpdateChangedEvent) => void,
  ): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private enqueueObservation(): void {
    const observation = this.observationQueue.then(() => this.observe());
    this.observationQueue = observation.catch((error: unknown) => {
      this.options.onError?.(error);
    });
  }

  private async observe(): Promise<void> {
    const state = await this.options.store.read();
    if (!this.started) return;
    if (stateSignature(state) === stateSignature(this.lastObservedState)) return;
    const events = changedPhaseEvents(this.lastObservedState, state);
    this.lastObservedState = state;
    for (const event of events) {
      for (const listener of this.listeners) {
        try {
          listener(event);
        } catch (error) {
          this.options.onError?.(error);
        }
      }
    }
  }
}

function stateSignature(state: UpgradeState | null): string | null {
  return state ? JSON.stringify(state) : null;
}

function changedPhaseEvents(
  previous: UpgradeState | null,
  current: UpgradeState | null,
): UpgradeStateChangedEvent[] {
  if (!current) {
    return [{
      type: "system.upgrade_state_changed",
      operationId: null,
      phase: null,
    }];
  }
  const previousPhases =
    previous?.operationId === current.operationId
      ? previous.phaseStartedAt ?? { [previous.phase]: previous.updatedAt }
      : {};
  const currentPhases = current.phaseStartedAt ?? {
    [current.phase]: current.updatedAt,
  };
  const changedPhases = Object.entries(currentPhases)
    .filter(
      ([phase, startedAt]) =>
        previousPhases[phase as UpgradeState["phase"]] !== startedAt,
    )
    .map(([phase]) => phase as UpgradeState["phase"]);
  if (
    changedPhases.length === 0 &&
    (previous?.operationId !== current.operationId ||
      previous.phase !== current.phase)
  ) {
    changedPhases.push(current.phase);
  }
  return changedPhases.map((phase) => ({
    type: "system.upgrade_state_changed",
    operationId: current.operationId,
    phase,
  }));
}
