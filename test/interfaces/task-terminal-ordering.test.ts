import { describe, expect, it } from "vitest";

import { sortTerminalTasks } from "../../src/interfaces/http/task-terminal-ordering.js";

const tasks = [
  { id: "task-old", order: 1, terminalAt: "2026-08-20T08:00:00.000Z" },
  { id: "task-new", order: 2, terminalAt: "2026-08-22T08:00:00.000Z" },
  { id: "task-middle", order: 3, terminalAt: "2026-08-21T08:00:00.000Z" },
];

describe("terminal task ordering", () => {
  it("keeps the workflow order until the user chooses a time direction", () => {
    expect(sortTerminalTasks(tasks, null).map(({ id }) => id)).toEqual([
      "task-old",
      "task-new",
      "task-middle",
    ]);
  });

  it("sorts completion and cancellation timestamps newest-first or oldest-first", () => {
    expect(sortTerminalTasks(tasks, "desc").map(({ id }) => id)).toEqual([
      "task-new",
      "task-middle",
      "task-old",
    ]);
    expect(sortTerminalTasks(tasks, "asc").map(({ id }) => id)).toEqual([
      "task-old",
      "task-middle",
      "task-new",
    ]);
  });

  it("uses workflow order as a deterministic tie breaker", () => {
    const sameTime = [
      { id: "task-second", order: 2, terminalAt: tasks[0]!.terminalAt },
      { id: "task-first", order: 1, terminalAt: tasks[0]!.terminalAt },
    ];

    expect(sortTerminalTasks(sameTime, "desc").map(({ id }) => id)).toEqual([
      "task-first",
      "task-second",
    ]);
  });
});
