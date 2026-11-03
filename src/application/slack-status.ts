import { WorkflowConflictError } from "../domain/errors.js";
import type { SlackConversation } from "../domain/slack-state.js";
import type { SlackStatusContext, SlackStatusControls, SlackStatusView } from "../domain/slack.js";
import type { ModelRoutingSettings } from "../domain/types.js";
import type { ConfigStore } from "../infrastructure/config-store.js";
import type { ProjectStore } from "../infrastructure/project-store.js";
import type { SlackStateStore } from "../infrastructure/slack-state-store.js";
import type { CodexThreadRuntimeStatus, CodexThreadStatusReader, CodexTokenUsageBreakdown } from "./codex-gateway.js";

interface SlackStatusOptions {
  configStore: ConfigStore;
  projects: ProjectStore;
  state: SlackStateStore;
  codex: CodexThreadStatusReader;
}

/** 只读取已关联会话及 Codex 的实际状态；频道缺少讨论串身份时由用户明确选择。 */
export class SlackStatus implements SlackStatusControls {
  constructor(private readonly options: SlackStatusOptions) {}

  async read(context: SlackStatusContext): Promise<SlackStatusView> {
    const config = await this.options.configStore.read();
    const slack = config.slack;
    if (!slack?.enabled || slack.teamId !== context.teamId || slack.authorizedUserId !== context.userId) {
      throw new WorkflowConflictError("当前 Slack 身份没有读取会话状态的权限。");
    }
    const conversations = (await this.options.state.listConversations()).filter((conversation) =>
      conversation.teamId === context.teamId && conversation.channelId === context.channelId,
    );
    const direct = context.channelId.startsWith("D");
    if (!direct && !context.threadTs && !context.conversationId) {
      const binding = slack.projectBindings.find(({ channelId }) => channelId === context.channelId);
      const models = await this.effectiveModels(binding?.projectId, config.models);
      const inputs = await this.options.state.listInputs();
      const choices = [...conversations].reverse().map((conversation) => {
        const first = inputs.find(({ conversationId }) => conversationId === conversation.id);
        const title = first?.message.text.replace(/\s+/g, " ").trim() || `讨论串 ${conversation.threadTs}`;
        return { id: conversation.id, label: title.slice(0, 75) };
      });
      return {
        text: `${this.defaultModelsText(models)}\n\n${choices.length
          ? "请选择要查看的会话。频道中的每条根消息独立，命令不会猜测当前讨论串。也可在消息菜单中选择「查看 Codrive 状态」。"
          : "这个频道尚未建立 Codrive 会话。"}`,
        conversations: choices,
      };
    }

    const conversation = context.conversationId
      ? conversations.find(({ id }) => id === context.conversationId)
      : conversations.find((candidate) => direct
        ? candidate.conversationType === "direct_message"
        : candidate.threadTs === context.threadTs);
    if (!conversation) {
      if (context.conversationId) throw new WorkflowConflictError("所选会话不属于这个 Slack 对话，请重新选择。");
      return { text: "这条消息尚未建立与 Codex 关联的 Codrive 会话。", conversations: [] };
    }
    const [runtime, models] = await Promise.all([
      this.options.codex.readThreadRuntime(conversation.codexThreadId),
      this.effectiveModels(conversation.projectId, config.models),
    ]);
    return { text: this.runtimeText(conversation, runtime, models), conversations: [] };
  }

  private async effectiveModels(projectId: string | undefined, global: ModelRoutingSettings): Promise<ModelRoutingSettings> {
    if (!projectId) return global;
    return (await this.options.projects.getProject(projectId))?.project.modelConfig ?? global;
  }

  private defaultModelsText(models: ModelRoutingSettings): string {
    return `下一回合默认：${models.primary} / ${models.primaryReasoningEffort ?? "模型默认强度"}；备用：${models.fallback}。`;
  }

  private runtimeText(conversation: SlackConversation, runtime: CodexThreadRuntimeStatus, models: ModelRoutingSettings): string {
    const sandbox = runtime.sandboxPolicy === "dangerFullAccess"
      ? "完全访问（dangerFullAccess）"
      : runtime.sandboxPolicy ?? "暂无实际快照";
    const approval = runtime.approvalPolicy === "never"
      ? "无需审批（never）"
      : runtime.approvalPolicy ?? "暂无实际快照";
    return [
      "Codrive 会话状态",
      `会话：${conversation.codexThreadId}`,
      `运行状态：${runtime.status}`,
      `实际模型：${runtime.model ?? "暂无数据"}`,
      `实际推理强度：${runtime.reasoningEffort ?? "暂无数据"}`,
      `权限：${sandbox}`,
      `审批：${approval}`,
      this.defaultModelsText(models),
      "",
      this.usageText(runtime.tokenUsage),
      "",
      "模型与强度来自 Codex 当前配置或最近保存的会话快照；用量与权限仅显示本次服务取得的实际数据。",
    ].join("\n");
  }

  private usageText(usage: CodexThreadRuntimeStatus["tokenUsage"]): string {
    if (!usage) return "token 用量：暂无数据。上下文窗口与余量：暂无数据。";
    const lines = [this.breakdownText("累计", usage.total), this.breakdownText("最近一轮", usage.last)];
    if (!usage.modelContextWindow) {
      lines.push("上下文窗口与余量：暂无数据。");
    } else {
      const remaining = Math.max(0, usage.modelContextWindow - usage.last.totalTokens);
      const percentage = (remaining / usage.modelContextWindow * 100).toFixed(1);
      lines.push(
        `上下文窗口：${formatTokens(usage.modelContextWindow)} token`,
        `上下文余量（按最近一轮估算）：${formatTokens(remaining)} token，约 ${percentage}%。`,
        "该估算使用最近一轮总量；后续执行和上下文压缩会改变占用，并非精确余额。",
      );
    }
    return lines.join("\n");
  }

  private breakdownText(label: string, usage: CodexTokenUsageBreakdown): string {
    return `${label} token：${formatTokens(usage.totalTokens)}（输入 ${formatTokens(usage.inputTokens)}，缓存命中 ${formatTokens(usage.cachedInputTokens)}，缓存写入 ${formatTokens(usage.cacheWriteInputTokens)}，输出 ${formatTokens(usage.outputTokens)}，其中推理输出 ${formatTokens(usage.reasoningOutputTokens)}）`;
  }
}

function formatTokens(value: number): string {
  return value.toLocaleString("en-US");
}
