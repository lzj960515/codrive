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
});
