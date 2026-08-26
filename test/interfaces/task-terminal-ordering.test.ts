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

  it("keeps legacy tasks without a terminal timestamp after dated tasks", () => {
    const legacy = { id: "task-legacy", order: 0, terminalAt: null };

    expect(sortTerminalTasks([legacy, ...tasks], "desc").at(-1)).toBe(legacy);
    expect(sortTerminalTasks([legacy, ...tasks], "asc").at(-1)).toBe(legacy);
  });
});
