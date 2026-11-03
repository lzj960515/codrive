import type { MarkdownBlock, TableBlock } from "@slack/types";

export type SlackReportBlock = MarkdownBlock | TableBlock;

export interface SlackFormattedMessage {
  text: string;
  blocks: SlackReportBlock[];
}
