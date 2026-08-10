import type { TaskStatus } from "../../domain/types.js";

export type TaskBoardColumnKey =
  | "backlog"
  | "developing"
  | "reviewing"
  | "integrating"
  | "waiting"
  | "done"
  | "cancelled";

export const taskBoardLayout = {
  columns: [
    ["backlog", "待安排"],
    ["developing", "开发中"],
    ["reviewing", "审查中"],
    ["integrating", "合入中"],
    ["waiting", "等待中"],
    ["done", "已完成"],
    ["cancelled", "已取消"],
  ],
  statusColumns: {
    backlog: "backlog",
    developing: "developing",
    reviewing: "reviewing",
    changes_requested: "developing",
    integrating: "integrating",
    waiting_for_input: "waiting",
    blocked: "waiting",
    done: "done",
    cancelled: "cancelled",
  },
} as const satisfies {
  columns: readonly (readonly [TaskBoardColumnKey, string])[];
  statusColumns: Record<TaskStatus, TaskBoardColumnKey>;
};

export function taskBoardColumn(status: TaskStatus): TaskBoardColumnKey {
  return taskBoardLayout.statusColumns[status];
}
