export type TerminalTaskSortDirection = "asc" | "desc";

export interface TerminalTaskOrderItem {
  id: string;
  order: number;
  terminalAt: string;
}

export function sortTerminalTasks<T extends TerminalTaskOrderItem>(
  tasks: readonly T[],
  direction: TerminalTaskSortDirection | null,
): T[] {
  if (!direction) return [...tasks];

  return [...tasks].sort((left, right) => {
    const leftTime = Date.parse(left.terminalAt);
    const rightTime = Date.parse(right.terminalAt);
    if (leftTime !== rightTime) {
      return direction === "desc" ? rightTime - leftTime : leftTime - rightTime;
    }
    return left.order - right.order || left.id.localeCompare(right.id);
  });
}
