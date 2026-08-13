import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const handoffSkills = ["codrive-forge", "codrive-work", "codrive-control"];

describe("non-execution Skill handoff", () => {
  it.each(handoffSkills)(
    "%s completes its conversation after handing work to Codrive",
    async (skillName) => {
      const instructions = await readFile(
        resolve("skills", skillName, "SKILL.md"),
        "utf8",
      );

      expect(instructions).toContain("## 结果交接");
      expect(instructions).toContain("由 Codrive 创建和调度的独立 Codex 对话");
      expect(instructions).toContain("结束当前回合");
    },
  );

  it("makes Codex classify and explain every cancellation decision", async () => {
    const control = await readFile(resolve("skills/codrive-control/SKILL.md"), "utf8");
    const task = await readFile(resolve("skills/codrive-task/SKILL.md"), "utf8");

    for (const instructions of [control, task]) {
      expect(instructions).toContain("user_confirmed");
      expect(instructions).toContain("agent_decision");
      expect(instructions).toContain("needs_input");
      expect(instructions).toContain("取消理由");
    }
  });

  it("documents scheduled blockers as a same-execution Codrive lifecycle", async () => {
    const control = await readFile(resolve("skills/codrive-control/SKILL.md"), "utf8");
    const task = await readFile(resolve("skills/codrive-task/SKILL.md"), "utf8");

    for (const instructions of [control, task]) {
      expect(instructions).toContain("resumeAt");
      expect(instructions).toContain("resumePrompt");
      expect(instructions).toContain("RFC 3339");
      expect(instructions).toContain("attempt");
      expect(instructions).toContain("原对话");
    }
  });
});
