export interface TaskActivityHistoryView<T> {
  visibleActivities: T[];
  hiddenCount: number;
}

export interface TaskActivityHistoryWindow {
  open(taskId: string): void;
  close(): void;
  view<T>(taskId: string, activities: readonly T[]): TaskActivityHistoryView<T>;
  revealEarlier<T>(
    taskId: string,
    activities: readonly T[],
  ): TaskActivityHistoryView<T>;
}

export function createTaskActivityHistoryWindow(
  batchSize = 2,
): TaskActivityHistoryWindow {
  let activeTaskId: string | null = null;
  let visibleCount = batchSize;
  let knownActivityCount: number | null = null;

  const activate = (taskId: string) => {
    if (activeTaskId === taskId) return;
    activeTaskId = taskId;
    visibleCount = batchSize;
    knownActivityCount = null;
  };

  const createView = <T>(activities: readonly T[]) => {
    if (
      knownActivityCount !== null &&
      activities.length > knownActivityCount
    ) {
      visibleCount += activities.length - knownActivityCount;
    }
    visibleCount = Math.min(visibleCount, activities.length);
    knownActivityCount = activities.length;
    const hiddenCount = Math.max(activities.length - visibleCount, 0);
    return {
      visibleActivities: activities.slice(hiddenCount),
      hiddenCount,
    };
  };

  return {
    open(taskId) {
      activeTaskId = taskId;
      visibleCount = batchSize;
      knownActivityCount = null;
    },
    close() {
      activeTaskId = null;
      visibleCount = batchSize;
      knownActivityCount = null;
    },
    view(taskId, activities) {
      activate(taskId);
      return createView(activities);
    },
    revealEarlier(taskId, activities) {
      activate(taskId);
      visibleCount = Math.min(visibleCount + batchSize, activities.length);
      return createView(activities);
    },
  };
}
