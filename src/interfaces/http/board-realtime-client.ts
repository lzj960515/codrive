type RealtimeWatchEvent =
  | "watch:project"
  | "unwatch:project"
  | "watch:task"
  | "unwatch:task"
  | "watch:system";

type RealtimeWatchPayload =
  | Record<string, never>
  | { projectId: string }
  | { taskId: string };

export interface DesiredRealtimeWatches {
  projectId: string | null;
  taskId: string | null;
}

export interface RealtimeWatchCoordinator {
  reset(): void;
  sync(): Promise<void>;
}

interface RealtimeWatchCoordinatorOptions {
  isConnected(): boolean;
  readDesiredWatches(): DesiredRealtimeWatches;
  request(event: RealtimeWatchEvent, payload: RealtimeWatchPayload): Promise<void>;
}

export function createRealtimeWatchCoordinator(
  options: RealtimeWatchCoordinatorOptions,
): RealtimeWatchCoordinator {
  let watchesSystem = false;
  let watchedProjectId: string | null = null;
  let watchedTaskId: string | null = null;
  let connectionRevision = 0;
  let syncQueue = Promise.resolve();

  const applyDesiredWatches = async (): Promise<void> => {
    if (!options.isConnected()) return;

    const revision = connectionRevision;
    const desired = options.readDesiredWatches();
    const desiredTaskId = desired.projectId ? desired.taskId : null;
    const send = async (
      event: RealtimeWatchEvent,
      payload: RealtimeWatchPayload,
    ): Promise<boolean> => {
      await options.request(event, payload);
      return revision === connectionRevision && options.isConnected();
    };
    if (!watchesSystem) {
      if (!(await send("watch:system", {}))) return;
      watchesSystem = true;
    }
    if (watchedProjectId !== desired.projectId) {
      if (watchedTaskId) {
        if (!(await send("unwatch:task", { taskId: watchedTaskId }))) return;
        watchedTaskId = null;
      }
      if (watchedProjectId) {
        if (
          !(await send("unwatch:project", {
            projectId: watchedProjectId,
          }))
        ) {
          return;
        }
        watchedProjectId = null;
      }
      if (desired.projectId) {
        if (
          !(await send("watch:project", {
            projectId: desired.projectId,
          }))
        ) {
          return;
        }
        watchedProjectId = desired.projectId;
      }
    }
    if (watchedTaskId !== desiredTaskId) {
      if (watchedTaskId) {
        if (!(await send("unwatch:task", { taskId: watchedTaskId }))) return;
        watchedTaskId = null;
      }
      if (desiredTaskId) {
        if (!(await send("watch:task", { taskId: desiredTaskId }))) return;
        watchedTaskId = desiredTaskId;
      }
    }
  };

  return {
    reset() {
      connectionRevision += 1;
      watchesSystem = false;
      watchedProjectId = null;
      watchedTaskId = null;
    },
    sync() {
      syncQueue = syncQueue.then(applyDesiredWatches, applyDesiredWatches);
      return syncQueue;
    },
  };
}
