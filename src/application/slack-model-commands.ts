import { WorkflowConflictError } from "../domain/errors.js";
import type { SlackModelContext, SlackModelControls, SlackModelMenu } from "../domain/slack.js";
import type { ModelRoutingSettings } from "../domain/types.js";
import type { ConfigStore } from "../infrastructure/config-store.js";
import type { ProjectStore } from "../infrastructure/project-store.js";
import type { CodexModelOption } from "./codex-gateway.js";
import type { SystemSettingsService } from "./system-settings-service.js";

interface SlackModelCommandsOptions {
  configStore: ConfigStore;
  projects: ProjectStore;
  settings: SystemSettingsService;
}

/** Slack 只选择现有设置的作用范围；模型有效性和运行中的执行仍由设置服务负责。 */
export class SlackModelCommands implements SlackModelControls {
  constructor(private readonly options: SlackModelCommandsOptions) {}

  async read(context: SlackModelContext): Promise<SlackModelMenu> {
    const scope = await this.authorizedScope(context);
    if (scope.projectId) {
      const current = await this.options.settings.readProject(scope.projectId);
      return this.menu(scope, current.settings.effectiveModels, current.availableModels);
    }
    const current = await this.options.settings.read();
    return this.menu(scope, current.settings.models, current.availableModels);
  }

  async select(context: SlackModelContext, modelId: string, expectedScopeId?: string): Promise<SlackModelMenu> {
    const scope = await this.authorizedScope(context);
    if (expectedScopeId && scope.id !== expectedScopeId) {
      throw new WorkflowConflictError("频道绑定已变化，请重新运行 /model 后选择。");
    }
    if (scope.projectId) {
      const current = await this.options.settings.readProject(scope.projectId);
      const models = this.selectedModels(current.settings.effectiveModels, current.availableModels, modelId);
      const updated = await this.options.settings.updateProject(scope.projectId, { modelConfig: models });
      return this.menu(scope, updated.settings.effectiveModels, updated.availableModels);
    }
    const current = await this.options.settings.read();
    const models = this.selectedModels(current.settings.models, current.availableModels, modelId);
    const updated = await this.options.settings.update({ ...current.settings, models });
    return this.menu(scope, updated.settings.models, updated.availableModels);
  }

  private async authorizedScope(context: SlackModelContext) {
    const { slack } = await this.options.configStore.read();
    if (!slack?.enabled || context.teamId !== slack.teamId || context.userId !== slack.authorizedUserId) {
      throw new WorkflowConflictError("当前 Slack 身份没有修改模型设置的权限。");
    }
    if (context.channelId.startsWith("D")) return { id: "global", label: "全局默认" };
    const binding = slack.projectBindings.find(({ channelId }) => channelId === context.channelId);
    if (!binding) throw new WorkflowConflictError("这个频道尚未绑定项目，请先在私信中完成绑定。");
    const snapshot = await this.options.projects.getProject(binding.projectId);
    if (!snapshot) throw new WorkflowConflictError("频道关联的项目已不可用，请先核对绑定。");
    return { id: snapshot.project.id, projectId: snapshot.project.id, label: `项目「${snapshot.project.name}」` };
  }

  private selectedModels(current: ModelRoutingSettings, catalog: CodexModelOption[], modelId: string): ModelRoutingSettings {
    const selected = catalog.find(({ id }) => id === modelId.trim());
    if (!selected) throw new WorkflowConflictError("该模型不在当前 Codex 可用目录中，请重新打开模型列表。");
    if (selected.id === current.fallback) {
      throw new WorkflowConflictError("主模型需要与当前备用模型不同；备用模型可在 Codrive 设置中调整。");
    }
    const models = { ...current, primary: selected.id };
    const effort = current.primaryReasoningEffort;
    if (effort && !selected.supportedReasoningEfforts.some(({ reasoningEffort }) => reasoningEffort === effort)) {
      delete models.primaryReasoningEffort;
    }
    return models;
  }

  private menu(scope: { id: string; label: string }, models: ModelRoutingSettings, catalog: CodexModelOption[]): SlackModelMenu {
    return {
      scopeId: scope.id,
      scopeLabel: scope.label,
      primary: models.primary,
      fallback: models.fallback,
      models: catalog.filter(({ id }) => id !== models.fallback).map(({ id, displayName }) => ({ id, displayName })),
    };
  }
}
