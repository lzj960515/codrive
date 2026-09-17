import type { DecisionReplyTarget } from "../../domain/decision-reply.js";

/** 卡片仅携带服务端投影出的当前决定，历史记录保留普通对话入口。 */
export function createDecisionReplyPresenter(escapeHtml: (value: string) => string) {
  return function decisionActions(
    target: DecisionReplyTarget | null | undefined,
    question: string,
    threadId: string | null | undefined,
    conversationLabel = "前往对应对话回复",
  ): string {
    const conversation = threadId
      ? '<a class="detail-link' + (target ? '' : ' primary') + '" href="codex://threads/' + escapeHtml(threadId) + '">' + escapeHtml(conversationLabel) + ' <span>↗</span></a>'
      : '';
    const reply = target
      ? '<button class="primary-button" type="button" data-decision-reply="' + escapeHtml(JSON.stringify(target)) + '" data-decision-question="' + escapeHtml(question) + '" aria-haspopup="dialog">在此回复</button>'
      : '';
    return conversation || reply ? '<div class="decision-actions">' + conversation + reply + '</div>' : '';
  };
}
