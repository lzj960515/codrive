import { describe, expect, it } from "vitest";

import { commandSchema } from "../../src/interfaces/http/command-schemas.js";

describe("task document commands", () => {
  const base = {
    type: "project.add_work",
    payload: {
      projectId: "project_1",
      decisionSummary: "补齐可玩的主流程",
      tasks: [{ title: "完成可玩的主流程", taskDocumentPath: "docs/tasks/playable-loop.md" }],
    },
  };

  it("accepts a document path as the new task definition", () => {
    expect(commandSchema.safeParse(base).success).toBe(true);
  });

  it("rejects a newly registered task with inline description and criteria", () => {
    const legacyInput = {
      ...base,
      payload: {
        ...base.payload,
        tasks: [{
          title: "完成可玩的主流程",
          description: "完成一局游戏",
          acceptanceCriteria: ["可以玩完"],
        }],
      },
    };
    expect(commandSchema.safeParse(legacyInput).success).toBe(false);
  });
});
