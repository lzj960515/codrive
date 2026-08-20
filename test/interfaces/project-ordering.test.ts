import { describe, expect, it } from "vitest";

import {
  moveProjectInOrder,
  reconcileProjectOrder,
} from "../../src/interfaces/http/project-ordering.js";

describe("project sidebar ordering", () => {
  it("keeps a user's saved project order while removing stale projects and appending new ones", () => {
    expect(
      reconcileProjectOrder(
        ["project-alpha", "project-beta", "project-gamma"],
        ["project-beta", "removed-project", "project-beta"],
      ),
    ).toEqual(["project-beta", "project-alpha", "project-gamma"]);
  });

  it("moves a project before or after the drop target without changing the remaining order", () => {
    expect(
      moveProjectInOrder(
        ["project-alpha", "project-beta", "project-gamma"],
        "project-gamma",
        "project-alpha",
        "before",
      ),
    ).toEqual(["project-gamma", "project-alpha", "project-beta"]);

    expect(
      moveProjectInOrder(
        ["project-alpha", "project-beta", "project-gamma"],
        "project-alpha",
        "project-beta",
        "after",
      ),
    ).toEqual(["project-beta", "project-alpha", "project-gamma"]);
  });

  it("ignores unusable stored values and drops without two known projects", () => {
    expect(
      reconcileProjectOrder(["project-alpha", "project-beta"], { projectId: "project-beta" }),
    ).toEqual(["project-alpha", "project-beta"]);
    expect(
      moveProjectInOrder(["project-alpha", "project-beta"], "project-alpha", "missing", "after"),
    ).toEqual(["project-alpha", "project-beta"]);
  });
});
