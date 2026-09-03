import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const handoffSkills = ["codrive-forge", "codrive-work", "codrive-control"];
const managedSkills = [...handoffSkills, "codrive-task"];

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
    expect(task).toContain("新的报告机会");
    expect(task).toContain("reportOpportunityId");
    expect(task).toContain("重新读取 context");
    expect(task).toContain("不可变活动");
  });

  it("documents project archive as reversible retention with paused restore", async () => {
    const control = await readFile(resolve("skills/codrive-control/SKILL.md"), "utf8");

    expect(control).toContain("`archive`");
    expect(control).toContain("`unarchive`");
    expect(control).toContain("保留本地数据");
    expect(control).toContain("恢复后仍保持暂停");
  });

  it("expresses the generic work, review, and completion-decision contract", async () => {
    const task = await readFile(resolve("skills/codrive-task/SKILL.md"), "utf8");

    expect(task).toContain("独立判断每条 finding");
    expect(task).toContain("不适用的问题形成有证据的回复");
    expect(task).toContain("受支持的使用方式");
    expect(task).toContain("真实影响当前交付");
    expect(task).toContain("## 工作 `work`");
    expect(task).toContain("`work_required`");
    expect(task).toContain("没有候选时");
    expect(task).not.toContain("## 开发 `develop`");
    expect(task).not.toContain("## 返工 `rework`");
    expect(task).toContain("codrive-task.mjs report");
  });

  it("selects stage-specific Skills after reading authoritative task context", async () => {
    const task = await readFile(resolve("skills/codrive-task/SKILL.md"), "utf8");

    expect(task).toContain("任务定义、验收标准、当前阶段和完整活动历史");
    expect(task).toContain("开始执行当前阶段前");
    expect(task).toContain("当前可用 Skill");
    expect(task).toContain("与当前阶段实际工作匹配的 Skill");
  });

  it("documents one explicit JSON argument contract across every managed Skill", async () => {
    for (const skillName of managedSkills) {
      const instructions = await readFile(
        resolve("skills", skillName, "SKILL.md"),
        "utf8",
      );

      expect(instructions).toContain("--json");
      expect(instructions).toContain("`ok: true`");
      expect(instructions).not.toContain("标准输入");
      expect(instructions).not.toContain("stdin");
    }
  });
});
