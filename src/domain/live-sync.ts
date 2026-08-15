import type { CodriveEvent } from "./types.js";

export const liveSyncSchemaVersion = 1 as const;

export type LiveSyncChange =
  | { type: "live.connected"; scope: "connection" }
  | { type: "project.changed"; scope: "project"; projectId: string }
  | {
      type: "task.changed" | "presence.changed";
      scope: "task";
      projectId: string;
      taskId: string;
    }
  | { type: "settings.changed"; scope: "settings" }
  | { type: "system.changed"; scope: "system" };

export type LiveSyncScope = LiveSyncChange["scope"];
export type LiveSyncEventType = LiveSyncChange["type"];

export type LiveSyncEnvelope = LiveSyncChange & {
  schemaVersion: typeof liveSyncSchemaVersion;
  sequence: number;
};

export function liveSyncChangeForStoreEvent(
  event: CodriveEvent,
): LiveSyncChange {
  if (event.taskId) {
    return {
      type: "task.changed",
      scope: "task",
      projectId: event.projectId,
      taskId: event.taskId,
    };
  }
  return {
    type: "project.changed",
    scope: "project",
    projectId: event.projectId,
  };
}

export function createLiveSyncEnvelope(
  change: LiveSyncChange,
  sequence: number,
): LiveSyncEnvelope {
  return {
    schemaVersion: liveSyncSchemaVersion,
    sequence,
    ...change,
  };
}
