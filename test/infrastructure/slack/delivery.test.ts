import type { WebClient } from "@slack/web-api";
import { describe, expect, it, vi } from "vitest";

import { SlackDeliveryError } from "../../../src/domain/slack.js";
import { postSlackMessages } from "../../../src/infrastructure/slack/delivery.js";
import { buildSlackMessages } from "../../../src/infrastructure/slack/formatting.js";

const report = "| 页面 | 次数 |\n| --- | --- |\n| A | 1 |\n\n| 页面 | 次数 |\n| --- | --- |\n| B | 2 |";
const target = { kind: "slack" as const, teamId: "T_workspace", channelId: "C_project" };

describe("Slack 报告分段送达", () => {
  it("保存已发根消息，重试从失败分段继续而不重复根报告", async () => {
    const postMessage = vi.fn()
      .mockResolvedValueOnce({ ok: true, ts: "100.001" })
      .mockRejectedValueOnce(new Error("connection lost"))
      .mockResolvedValueOnce({ ok: true, ts: "100.002" });
    const client = { chat: { postMessage } } as unknown as WebClient;
    const messages = buildSlackMessages(report);
    let failure: unknown;
    try {
      await postSlackMessages(client, target, messages);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(SlackDeliveryError);
    if (!(failure instanceof SlackDeliveryError)) throw new Error("Expected delivery failure");
    expect(failure.progress).toEqual({ messageTs: "100.001", nextMessageIndex: 1 });

    const delivered = await postSlackMessages(client, target, messages, failure.progress);
    expect(delivered).toEqual({ messageTs: "100.001" });
    expect(postMessage.mock.calls.map(([input]) => input.thread_ts)).toEqual([
      undefined, "100.001", "100.001",
    ]);
    expect(postMessage.mock.calls.map(([input]) => input.blocks)).toEqual([
      messages[0]!.blocks, messages[1]!.blocks, messages[1]!.blocks,
    ]);
  });

  it("回复已有讨论串时，所有分段始终指向原根消息", async () => {
    const postMessage = vi.fn()
      .mockResolvedValueOnce({ ok: true, ts: "200.001" })
      .mockResolvedValueOnce({ ok: true, ts: "200.002" });
    const client = { chat: { postMessage } } as unknown as WebClient;

    const result = await postSlackMessages(client, { ...target, threadTs: "190.001" }, buildSlackMessages(report));

    expect(result).toEqual({ messageTs: "200.001" });
    expect(postMessage.mock.calls.map(([input]) => input.thread_ts)).toEqual(["190.001", "190.001"]);
  });

  it("首段没有取得回执时，不伪造可继续登记工作的消息位置", async () => {
    const postMessage = vi.fn().mockRejectedValue(new Error("connection lost"));
    const client = { chat: { postMessage } } as unknown as WebClient;
    await expect(postSlackMessages(client, target, buildSlackMessages(report)))
      .rejects.toMatchObject({ name: "SlackDeliveryError", progress: undefined });
  });
});
