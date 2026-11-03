import { z } from "zod";

export const slackCommandSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("slack.configure"),
    payload: z.object({
      enabled: z.boolean(),
      teamId: z.string(),
      authorizedUserId: z.string(),
      botToken: z.string(),
      appToken: z.string(),
    }).strict(),
  }).strict(),
  z.object({
    type: z.literal("slack.bind"),
    payload: z.object({
      projectId: z.string().trim().min(1),
      channelId: z.string().trim().min(1),
    }).strict(),
  }).strict(),
  z.object({
    type: z.literal("slack.report"),
    payload: z.object({
      projectId: z.string().trim().min(1),
      requestId: z.string().trim().min(1),
      markdown: z.string().trim().min(1),
      source: z.object({
        kind: z.enum(["slack", "codex_native"]),
        requestId: z.string().trim().min(1),
      }).strict(),
    }).strict(),
  }).strict(),
  z.object({
    type: z.literal("slack.send_file"),
    payload: z.object({
      replyTarget: z.object({
        kind: z.literal("slack"),
        teamId: z.string().trim().min(1),
        channelId: z.string().trim().min(1),
        threadTs: z.string().trim().min(1).optional(),
      }).strict(),
      filePath: z.string().trim().min(1),
      title: z.string().trim().min(1).optional(),
      comment: z.string().trim().min(1).optional(),
    }).strict().transform(({ replyTarget, filePath, title, comment }) => ({
      replyTarget: {
        kind: replyTarget.kind,
        teamId: replyTarget.teamId,
        channelId: replyTarget.channelId,
        ...(replyTarget.threadTs ? { threadTs: replyTarget.threadTs } : {}),
      },
      filePath,
      ...(title ? { title } : {}),
      ...(comment ? { comment } : {}),
    })),
  }).strict(),
]);

export function isSlackCommand(value: unknown): boolean {
  if (value === null || typeof value !== "object" || !("type" in value)) return false;
  return typeof value.type === "string" && value.type.startsWith("slack.");
}
