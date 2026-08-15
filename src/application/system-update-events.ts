import type { UpgradePhase } from "../domain/system-update.js";

export interface VersionStatusChangedEvent {
  type: "system.version_status_changed";
}

export interface UpgradeStateChangedEvent {
  type: "system.upgrade_state_changed";
  operationId: string | null;
  phase: UpgradePhase | null;
}

export type SystemUpdateChangedEvent =
  | VersionStatusChangedEvent
  | UpgradeStateChangedEvent;

export interface SystemUpdateEventSource {
  subscribe(listener: (event: SystemUpdateChangedEvent) => void): () => void;
}

export function mergeSystemUpdateEventSources(
  ...sources: SystemUpdateEventSource[]
): SystemUpdateEventSource {
  return {
    subscribe(listener) {
      const unsubscribe = sources.map((source) => source.subscribe(listener));
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        for (const stop of unsubscribe) stop();
      };
    },
  };
}
