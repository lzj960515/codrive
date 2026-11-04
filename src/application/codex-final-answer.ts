import type { CodexAgentMessage } from "./codex-gateway.js";

/** 阶段来自 Codex；旧模型未标阶段时，取最后一条完整消息作为答复。 */
export function finalAnswerText(messages: readonly CodexAgentMessage[]): string {
  const finalMessages = messages.filter((message) => message.phase === "final_answer" && message.text.trim());
  if (finalMessages.length) return finalMessages.map(({ text }) => text).join("\n\n");
  const unclassifiedMessages = messages.filter((message) => message.phase == null && message.text.trim());
  return unclassifiedMessages.at(-1)?.text ?? "";
}
