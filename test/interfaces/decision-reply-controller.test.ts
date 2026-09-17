import { describe, expect, it, vi } from "vitest";
import { createDecisionReplyController } from "../../src/interfaces/http/decision-reply-controller.js";

function createFixture(send = vi.fn(async (_payload: unknown): Promise<void> => undefined)) {
  const dialog = { open: false, showModal() { this.open = true; }, close() { this.open = false; } };
  const message = { value: "", disabled: false, focus: vi.fn() };
  const question = { textContent: "" };
  const status = { textContent: "" };
  const submit = { disabled: false, textContent: "发送" };
  const cancel = { disabled: false };
  const close = { disabled: false };
  const onSent = vi.fn();
  const controller = createDecisionReplyController({ dialog, message, question, status, submit, cancel, close, send, onSent });
  const target = { scope: "task" as const, id: "task-a", reportOpportunityId: "report-a" };
  return { controller, dialog, message, question, status, submit, cancel, close, send, onSent, target };
}

describe("decision reply", () => {
  it("does not send an empty reply and lets the user cancel without sending", async () => {
    const ui = createFixture();
    ui.controller.open(ui.target, "继续发布？");
    expect(ui.dialog.open).toBe(true);
    expect(ui.message.focus).toHaveBeenCalled();
    ui.message.value = "   \n  ";
    await ui.controller.send();
    expect(ui.send).not.toHaveBeenCalled();
    expect(ui.status.textContent).toBe("请先填写回复。");
    ui.controller.close();
    expect(ui.dialog.open).toBe(false);
    expect(ui.onSent).not.toHaveBeenCalled();
  });

  it("sends once with the captured decision identity, closes only after success", async () => {
    let resolve!: () => void;
    const send = vi.fn((_payload: unknown) => new Promise<void>(done => { resolve = done; }));
    const ui = createFixture(send);
    ui.controller.open(ui.target, "继续发布？");
    ui.message.value = "  可以发布  ";
    const pending = ui.controller.send();
    await ui.controller.send();
    ui.controller.close();
    expect(ui.send).toHaveBeenCalledExactlyOnceWith({ ...ui.target, message: "可以发布" });
    expect(ui.dialog.open).toBe(true);
    expect(ui.submit.disabled).toBe(true);
    expect(ui.message.disabled).toBe(true);
    resolve();
    await pending;
    expect(ui.dialog.open).toBe(false);
    expect(ui.onSent).toHaveBeenCalledOnce();
    expect(ui.message.value).toBe("");
  });

  it("keeps text and decision identity on failure so the user can correct or retry", async () => {
    const send = vi.fn(async (_payload: unknown) => { throw new Error("该决定已更新，请刷新后重试。"); });
    const ui = createFixture(send);
    ui.controller.open(ui.target, "继续发布？");
    ui.message.value = "可以发布";
    await ui.controller.send();
    expect(ui.dialog.open).toBe(true);
    expect(ui.message.value).toBe("可以发布");
    expect(ui.status.textContent).toBe("该决定已更新，请刷新后重试。");
    expect(ui.submit.disabled).toBe(false);
    expect(ui.message.disabled).toBe(false);
    expect(ui.onSent).not.toHaveBeenCalled();
  });
});
