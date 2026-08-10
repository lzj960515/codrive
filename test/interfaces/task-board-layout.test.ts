import { describe, expect, it } from "vitest";

import {
  taskBoardColumn,
  taskBoardLayout,
} from "../../src/interfaces/http/task-board-layout.js";

describe("task board layout", () => {
  it("groups workflow variants into their board columns", () => {
    expect(taskBoardColumn("changes_requested")).toBe("developing");
    expect(taskBoardColumn("waiting_for_input")).toBe("waiting");
    expect(taskBoardColumn("blocked")).toBe("waiting");
    expect(taskBoardColumn("done")).toBe("done");
    expect(taskBoardColumn("cancelled")).toBe("cancelled");
  });

  it("defines each rendered column exactly once", () => {
    const keys = taskBoardLayout.columns.map(([key]) => key);

    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual([
      "backlog",
      "developing",
      "reviewing",
      "integrating",
      "waiting",
      "done",
      "cancelled",
    ]);
  });
});
