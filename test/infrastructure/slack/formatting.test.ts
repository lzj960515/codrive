import type { MarkdownBlock, TableBlock } from "@slack/types";
import { describe, expect, it } from "vitest";

import { buildSlackMessages } from "../../../src/infrastructure/slack/formatting.js";

describe("Slack report formatting", () => {
  it("keeps the report, native table, and conclusion in their original order", () => {
    const messages = buildSlackMessages(
      "# 昨日访问量\n\n| 来源 | 次数 |\n| --- | ---: |\n| **搜索** &amp; [推荐](https://example.com) | `120` |\n\n总计 120 次。",
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]!.blocks.map(({ type }) => type)).toEqual([
      "markdown", "table", "markdown",
    ]);
    const table = messages[0]!.blocks.find(({ type }) => type === "table");
    expect(table?.type).toBe("table");
    if (table?.type !== "table") throw new Error("Expected native report table");
    expect(table.rows[1]).toEqual([
      { type: "raw_text", text: "搜索 & 推荐 (https://example.com)" },
      { type: "raw_text", text: "120" },
    ]);
    expect(messages[0]!.text).toContain("昨日访问量");
    expect(messages[0]!.text).toContain("总计 120 次。");
  });

  it("preserves literal comparisons and code inside table cells", () => {
    const messages = buildSlackMessages("| 检查 | 结果 |\n| --- | --- |\n| `a < b > c` | <strong>保留</strong> |");
    const table = messages[0]!.blocks.find((block): block is TableBlock => block.type === "table");
    expect(table?.rows[1]).toEqual([
      { type: "raw_text", text: "a < b > c" },
      { type: "raw_text", text: "保留" },
    ]);
  });

  it("splits a long report table without losing rows and repeats its header", () => {
    const rows = Array.from({ length: 205 }, (_, index) => `| 页面 ${index + 1} | ${index + 1} |`);
    const messages = buildSlackMessages(`| 页面 | 次数 |\n| --- | --- |\n${rows.join("\n")}`);
    const tables = messages.flatMap(({ blocks }) => blocks.filter((block): block is TableBlock => block.type === "table"));

    expect(tables).toHaveLength(3);
    expect(tables.map(({ rows }) => rows.length)).toEqual([100, 100, 8]);
    expect(tables.every(({ rows }) => rows[0]?.[0]?.type === "rich_text")).toBe(true);
    const values = tables.flatMap(({ rows }) => rows.slice(1).map((row) => row[0]));
    expect(values).toHaveLength(205);
    expect(values[0]).toEqual({ type: "raw_text", text: "页面 1" });
    expect(values[204]).toEqual({ type: "raw_text", text: "页面 205" });
    expect(messages.every(({ blocks }) => blocks.filter((block): block is TableBlock => block.type === "table").length <= 1)).toBe(true);
  });

  it("preserves long narrative and distinct tables across Slack message limits", () => {
    const narrative = "检查完成。".repeat(3_000);
    const messages = buildSlackMessages(
      `${narrative}\n\n| 项目 | 结果 |\n| --- | --- |\n| A | 正常 |\n\n| 项目 | 结果 |\n| --- | --- |\n| B | 异常 |`,
    );
    const text = messages.flatMap(({ blocks }) => blocks)
      .filter((block): block is MarkdownBlock => block.type === "markdown")
      .map(({ text }) => text).join("").trim();

    expect(text).toBe(narrative);
    expect(messages.length).toBeGreaterThan(1);
    expect(messages.every(({ blocks }) => blocks.length <= 50)).toBe(true);
    expect(messages.every(({ blocks }) => blocks.filter((block): block is TableBlock => block.type === "table").length <= 1)).toBe(true);
    expect(messages.every(({ blocks }) => blocks.reduce((length, block) => length + (block.type === "markdown" ? block.text.length : 0), 0) <= 12_000)).toBe(true);
  });
});
