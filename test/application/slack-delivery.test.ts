import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SlackDeliveryService } from "../../src/application/slack-delivery.js";
import { SlackDeliveryError } from "../../src/domain/slack.js";
import type { SlackDeliveryRecord } from "../../src/domain/slack-state.js";
import { SlackStateStore } from "../../src/infrastructure/slack-state-store.js";

const delivery: SlackDeliveryRecord = {
  id: "report_login_failure",
  projectId: "project_login",
  source: { kind: "codex_native", requestId: "report_login_failure" },
  target: { kind: "slack", teamId: "T_owner", channelId: "C_project" },
  markdown: "检查：提交登录。预期：进入首页。实际：仍在登录页。",
  createdAt: "2026-11-03T03:00:00.000Z",
};

describe("SlackDeliveryService", () => {
  let directory: string;
  let store: SlackStateStore;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "codrive-slack-delivery-"));
    store = new SlackStateStore(directory);
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("persists a failed report and its destination so a restart can retry only delivery", async () => {
    const failure = new Error("Slack temporarily unavailable");
    const sendMessage = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue({ messageTs: "1762141200.000001" });
    const service = new SlackDeliveryService(store, { sendMessage }, "T_owner");

    await expect(service.deliver(delivery)).rejects.toBe(failure);
    expect(await store.getDelivery(delivery.id)).toMatchObject({
      ...delivery,
      error: failure.message,
    });
    expect((await store.getDelivery(delivery.id))?.sentAt).toBeUndefined();

    const restarted = new SlackDeliveryService(new SlackStateStore(directory), { sendMessage }, "T_owner");
    const errors: unknown[] = [];
    await restarted.flushPending((error) => errors.push(error));
    expect(errors).toEqual([]);
    expect(await store.getDelivery(delivery.id)).toMatchObject({
      ...delivery,
      messageTs: "1762141200.000001",
      sentAt: expect.any(String),
    });
    expect((await store.getDelivery(delivery.id))?.error).toBeUndefined();
  });

  it("reuses the original message for the same report request and concurrent retries", async () => {
    let release!: (result: { messageTs: string }) => void;
    const pending = new Promise<{ messageTs: string }>((resolve) => { release = resolve; });
    const sendMessage = vi.fn().mockReturnValue(pending);
    const service = new SlackDeliveryService(store, { sendMessage }, "T_owner");

    const first = service.deliver(delivery);
    const second = service.deliver(delivery);
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(await store.getDelivery(delivery.id)).toMatchObject(delivery);
    release({ messageTs: "1762141200.000001" });
    const [sent, repeated] = await Promise.all([first, second]);
    expect(repeated).toEqual(sent);
    expect(await service.deliver(delivery)).toEqual(sent);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("continues after already-sent chunks when a long report partially fails", async () => {
    const progress = { messageTs: "1762141200.000001", nextMessageIndex: 2 };
    const failure = new SlackDeliveryError("third chunk failed", progress);
    const sendMessage = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue({ messageTs: progress.messageTs });
    const service = new SlackDeliveryService(store, { sendMessage }, "T_owner");
    await expect(service.deliver(delivery)).rejects.toBe(failure);
    expect(await store.getDelivery(delivery.id)).toMatchObject({ progress, error: "third chunk failed" });

    const restarted = new SlackDeliveryService(new SlackStateStore(directory), { sendMessage }, "T_owner");
    const sent = await restarted.deliver(delivery);
    expect(sendMessage).toHaveBeenLastCalledWith(delivery.target, delivery.markdown, progress);
    expect(sent.messageTs).toBe(progress.messageTs);
    expect(sent.sentAt).toEqual(expect.any(String));
    expect(sent).not.toHaveProperty("progress");
  });

  it.each([
    { ...delivery, markdown: "不同的事实报告" },
    { ...delivery, target: { ...delivery.target, channelId: "C_another_project" } },
  ])("rejects a conflicting body or destination under an existing request identity", async (changed) => {
    const sendMessage = vi.fn().mockResolvedValue({ messageTs: "1762141200.000001" });
    const service = new SlackDeliveryService(store, { sendMessage }, "T_owner");
    const sent = await service.deliver(delivery);
    await expect(service.deliver(changed)).rejects.toThrow(/already|different|conflict/i);
    expect(await store.getDelivery(delivery.id)).toEqual(sent);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("continues flushing other reports after one delivery fails", async () => {
    const second = { ...delivery, id: "report_second", markdown: "另一份报告" };
    await store.saveDelivery(delivery);
    await store.saveDelivery(second);
    const sendMessage = vi.fn().mockImplementation(async (_target, markdown) => {
      if (markdown === delivery.markdown) throw new Error("first report unavailable");
      return { messageTs: "1762141200.000002" };
    });
    const errors: unknown[] = [];
    await new SlackDeliveryService(store, { sendMessage }, "T_owner").flushPending((error) => errors.push(error));
    expect(errors).toHaveLength(1);
    expect((await store.getDelivery(delivery.id))?.sentAt).toBeUndefined();
    expect(await store.getDelivery(second.id)).toMatchObject({ sentAt: expect.any(String), messageTs: "1762141200.000002" });
  });

  it("retains an old-workspace outbox record while sending only current-workspace reports", async () => {
    const old = { ...delivery, id: "old-workspace-report", target: { ...delivery.target, teamId: "T_previous" } };
    await store.saveDelivery(old);
    await store.saveDelivery(delivery);
    const sendMessage = vi.fn().mockResolvedValue({ messageTs: "1762141200.000001" });
    const errors: unknown[] = [];
    await new SlackDeliveryService(store, { sendMessage }, "T_owner").flushPending((error) => errors.push(error));
    expect(errors).toHaveLength(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(delivery.target, delivery.markdown, undefined);
    expect(await store.getDelivery(old.id)).toEqual(old);
    expect(await store.getDelivery(delivery.id)).toMatchObject({ sentAt: expect.any(String) });
  });

  it("rejects an old-workspace receipt even when it was already delivered", async () => {
    const old = { ...delivery, target: { ...delivery.target, teamId: "T_previous" }, sentAt: delivery.createdAt, messageTs: "100.000001" };
    await store.saveDelivery(old);
    const sendMessage = vi.fn();
    const service = new SlackDeliveryService(store, { sendMessage }, "T_owner");
    await expect(service.deliver(old)).rejects.toThrow();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(await store.getDelivery(old.id)).toEqual(old);
  });
});
