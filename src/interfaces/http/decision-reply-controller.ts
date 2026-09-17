import type { DecisionReplyTarget } from "../../domain/decision-reply.js";

interface DecisionReplyElements {
  dialog: Pick<HTMLDialogElement, "open" | "showModal" | "close">;
  message: Pick<HTMLTextAreaElement, "value" | "disabled" | "focus">;
  question: Pick<HTMLElement, "textContent">;
  status: Pick<HTMLElement, "textContent">;
  submit: Pick<HTMLButtonElement, "disabled" | "textContent">;
  cancel: Pick<HTMLButtonElement, "disabled">;
  close: Pick<HTMLButtonElement, "disabled">;
}

/** 同一弹窗处理当前决定的单次回复，页面刷新不替换正在编辑的内容。 */
export function createDecisionReplyController(options: DecisionReplyElements & {
  send: (payload: DecisionReplyTarget & { message: string }) => Promise<unknown>;
  onSent: () => void;
}) {
  let target: DecisionReplyTarget | null = null;
  let sending = false;

  function setSending(value: boolean) {
    sending = value;
    options.message.disabled = value;
    options.submit.disabled = value;
    options.cancel.disabled = value;
    options.close.disabled = value;
    options.submit.textContent = value ? "发送中…" : "发送";
  }

  function close() {
    if (sending) return;
    options.dialog.close();
    options.message.value = "";
    target = null;
  }

  function open(decision: DecisionReplyTarget, question: string) {
    if (options.dialog.open) return;
    target = { ...decision };
    options.question.textContent = question;
    options.message.value = "";
    options.status.textContent = "";
    setSending(false);
    options.dialog.showModal();
    options.message.focus();
  }

  async function send() {
    if (!target || sending) return;
    const message = options.message.value.trim();
    if (!message) {
      options.status.textContent = "请先填写回复。";
      options.message.focus();
      return;
    }
    setSending(true);
    options.status.textContent = "";
    try {
      await options.send({ ...target, message });
    } catch (error) {
      setSending(false);
      options.status.textContent = error instanceof Error ? error.message : "发送失败，请稍后重试。";
      options.message.focus();
      return;
    }
    setSending(false);
    close();
    options.onSent();
  }

  return { open, close, send };
}
