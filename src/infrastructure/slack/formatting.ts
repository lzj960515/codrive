import { Lexer, Parser, type Token, type Tokens } from "marked";
import type { RichTextBlock, TableBlock } from "@slack/types";

import type { SlackFormattedMessage, SlackReportBlock } from "./formatting-types.js";

const markdownCharacterLimit = 12_000;
const messageBlockLimit = 50;
const tableRowLimit = 100;
const tableColumnLimit = 20;

interface ReportPart {
  block: SlackReportBlock;
  text: string;
}

/** 表格使用原生块，长报告按 Slack 的消息限制拆分，保留正文顺序。 */
export function buildSlackMessages(markdown: string): SlackFormattedMessage[] {
  const parts: ReportPart[] = [];
  let narrative = "";
  for (const token of Lexer.lex(markdown, { gfm: true })) {
    if (isTableToken(token)) {
      parts.push(...markdownParts(narrative));
      narrative = "";
      parts.push(...tableParts(token));
    } else {
      narrative += token.raw;
    }
  }
  parts.push(...markdownParts(narrative));
  return groupMessages(parts);
}

function isTableToken(token: Token): token is Tokens.Table {
  return token.type === "table" && "header" in token && "rows" in token;
}

function markdownParts(markdown: string): ReportPart[] {
  return splitText(markdown.trim(), markdownCharacterLimit).map((text) => ({
    block: { type: "markdown", text },
    text,
  }));
}

function tableParts(token: Tokens.Table): ReportPart[] {
  // Slack 原生表格最多二十列；保留宽表原文而不是截断数据。
  if (token.header.length > tableColumnLimit) {
    return splitText(token.raw.trim(), markdownCharacterLimit - 12).map((text) => ({
      block: { type: "markdown", text: `\`\`\`text\n${text}\n\`\`\`` },
      text,
    }));
  }

  const parser = new Parser();
  parser.textRenderer.html = () => "";
  parser.textRenderer.link = ({ href, tokens }) => cellLinkText(parser.parseInline(tokens, parser.textRenderer), href);
  parser.textRenderer.image = ({ href, text }) => cellLinkText(text, href);
  const header = token.header.map((cell) => tableCellText(parser, cell));
  const rows = token.rows.map((row) => row.map((cell) => tableCellText(parser, cell)));
  const headerCells = header.map<RichTextBlock>((text) => ({
    type: "rich_text",
    elements: [{
      type: "rich_text_section",
      elements: [{ type: "text", text: text || " ", style: { bold: true } }],
    }],
  }));
  const parts: ReportPart[] = [];
  const bodyRowsPerTable = tableRowLimit - 1;
  for (let start = 0; start < Math.max(rows.length, 1); start += bodyRowsPerTable) {
    const body = rows.slice(start, start + bodyRowsPerTable);
    const block: TableBlock = {
      type: "table",
      rows: [
        headerCells,
        ...body.map((row) => row.map((text) => ({ type: "raw_text" as const, text: text || " " }))),
      ],
      column_settings: token.align.map((align) => ({
        ...(align ? { align } : {}),
        is_wrapped: true,
      })),
    };
    parts.push({ block, text: [header, ...body].map((row) => row.join("\t")).join("\n") });
  }
  return parts;
}

function cellLinkText(label: string, href: string): string {
  return label && label !== href ? `${label} (${href})` : href;
}

function tableCellText(parser: Parser, cell: Tokens.TableCell): string {
  return parser.parseInline(cell.tokens, parser.textRenderer)
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function groupMessages(parts: ReportPart[]): SlackFormattedMessage[] {
  const messages: SlackFormattedMessage[] = [];
  let current: ReportPart[] = [];
  let tableCount = 0;
  let markdownLength = 0;
  const finish = () => {
    if (current.length === 0) return;
    messages.push({
      blocks: current.map(({ block }) => block),
      text: current.map(({ text }) => text).join("\n\n").slice(0, 40_000),
    });
    current = [];
    tableCount = 0;
    markdownLength = 0;
  };

  for (const part of parts) {
    const isTable = part.block.type === "table";
    const textLength = part.block.type === "markdown" ? part.block.text.length : 0;
    if (
      current.length >= messageBlockLimit ||
      (isTable && tableCount > 0) ||
      markdownLength + textLength > markdownCharacterLimit
    ) finish();
    current.push(part);
    if (isTable) tableCount++;
    markdownLength += textLength;
  }
  finish();
  return messages;
}

function splitText(text: string, limit: number): string[] {
  const chunks: string[] = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + limit, text.length);
    if (end < text.length) {
      const newline = text.lastIndexOf("\n", end - 1);
      if (newline >= start + limit / 2) end = newline + 1;
      const lastCodeUnit = text.charCodeAt(end - 1);
      if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) end--;
    }
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}
