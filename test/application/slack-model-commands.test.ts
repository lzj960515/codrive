import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SlackModelCommands } from "../../src/application/slack-model-commands.js";
import { SystemSettingsService } from "../../src/application/system-settings-service.js";
import { WorkflowEngine } from "../../src/application/workflow-engine.js";
import type { CodexModelOption } from "../../src/application/codex-gateway.js";
import { ConfigStore } from "../../src/infrastructure/config-store.js";
import { ProjectStore } from "../../src/infrastructure/project-store.js";
import { RecordingProjectExecutor, RecordingTaskDispatcher, TestRepositoryPathResolver, testModels } from "../support/recording-executors.js";

const owner = { teamId: "T_owner", userId: "U_owner", channelId: "D_owner" };
const availableModels: CodexModelOption[] = [
  { id: testModels.primary, displayName: "当前主模型", description: "当前", isDefault: true, defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "默认" }, { reasoningEffort: "ultra", description: "深入" }] },
  { id: testModels.fallback, displayName: "备用模型", description: "备用", isDefault: false, defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "默认" }] },
  { id: "available-new-model", displayName: "新模型", description: "实时目录中的新模型", isDefault: false, defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "默认" }] },
];

describe("Slack 模型命令", () => {
  let directory: string;
  let configStore: ConfigStore;
  let projects: ProjectStore;
  let workflow: WorkflowEngine;
  let settings: SystemSettingsService;
  let commands: SlackModelCommands;
  let projectId: string;
  let unrelatedProjectId: string;
  let dispatcher: RecordingTaskDispatcher;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "codrive-slack-models-"));
    configStore = new ConfigStore(directory);
    await configStore.loadOrCreate();
    await configStore.update((current) => ({ ...current, models: { ...testModels, primaryReasoningEffort: "ultra", fallbackReasoningEffort: "medium" } }));
    projects = new ProjectStore(directory);
    dispatcher = new RecordingTaskDispatcher();
    workflow = new WorkflowEngine(projects, dispatcher, { maxConcurrentTasks: 4, models: { ...testModels, primaryReasoningEffort: "ultra" } }, new TestRepositoryPathResolver(), new RecordingProjectExecutor());
    settings = new SystemSettingsService(configStore, workflow, { listModels: async () => availableModels });
    await settings.configureSlack({ enabled: true, teamId: owner.teamId, authorizedUserId: owner.userId, botToken: "fake-bot", appToken: "fake-app" });
    const project = await workflow.registerProject({ name: "频道项目", repositoryPath: join(directory, "project"), defaultBranch: "main", productDocument: "# 频道项目\n", tasks: [] });
    projectId = project.project.id;
    const unrelated = await workflow.registerProject({ name: "其他项目", repositoryPath: join(directory, "unrelated"), defaultBranch: "main", productDocument: "# 其他项目\n", tasks: [] });
    unrelatedProjectId = unrelated.project.id;
    await settings.bindSlackProject({ projectId, channelId: "C_project" });
    commands = new SlackModelCommands({ configStore, projects, settings });
  });

  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  it("从当前 Codex 目录显示全局模型，保留主备不同约束且查看不修改设置", async () => {
    const before = await configStore.read();
    const menu = await commands.read(owner);
    expect(menu).toMatchObject({ scopeLabel: "全局默认", primary: testModels.primary, fallback: testModels.fallback });
    expect(menu.models.map(({ id }) => id)).toEqual([testModels.primary, "available-new-model"]);
    expect(await configStore.read()).toEqual(before);
  });

  it("私信切换全局主模型，保留备用模型、绑定、并发和项目覆盖", async () => {
    await settings.updateProject(unrelatedProjectId, { modelConfig: { primary: testModels.fallback, fallback: testModels.primary } });
    const result = await commands.select(owner, "available-new-model");
    expect(result.primary).toBe("available-new-model");
    expect(await configStore.read()).toMatchObject({
      models: { primary: "available-new-model", fallback: testModels.fallback, fallbackReasoningEffort: "medium" },
      maxConcurrentTasks: 4,
      slack: { projectBindings: [{ projectId, channelId: "C_project" }] },
    });
    expect((await configStore.read()).models.primaryReasoningEffort).toBeUndefined();
    expect((await projects.getProject(unrelatedProjectId))!.project.modelConfig).toEqual({ primary: testModels.fallback, fallback: testModels.primary });
    expect((await projects.getProject(projectId))!.project.modelConfig).toBeUndefined();
  });

  it("绑定频道只改变当前项目的模型，其他项目和全局默认保持原值", async () => {
    const globalBefore = (await configStore.read()).models;
    const result = await commands.select({ ...owner, channelId: "C_project" }, "available-new-model");
    expect(result).toMatchObject({ scopeLabel: "项目「频道项目」", primary: "available-new-model" });
    expect((await projects.getProject(projectId))!.project.modelConfig).toEqual({ primary: "available-new-model", fallback: testModels.fallback, fallbackReasoningEffort: "medium" });
    expect((await configStore.read()).models).toEqual(globalBefore);
    expect((await projects.getProject(unrelatedProjectId))!.project.modelConfig).toBeUndefined();
  });

  it("保留新模型支持的推理强度，当前模型不变时保留全部配置", async () => {
    await configStore.update((current) => ({ ...current, models: { ...current.models, primaryReasoningEffort: "medium" } }));
    await commands.select(owner, "available-new-model");
    expect((await configStore.read()).models.primaryReasoningEffort).toBe("medium");
    const before = await configStore.read();
    await commands.select(owner, "available-new-model");
    expect((await configStore.read()).models).toEqual(before.models);
  });

  it("拒绝未授权用户、工作区及未绑定频道，拒绝未知模型和当前备用模型且保留现场", async () => {
    const before = await configStore.read();
    for (const context of [{ ...owner, userId: "U_other" }, { ...owner, teamId: "T_other" }, { ...owner, channelId: "C_unbound" }]) {
      await expect(commands.read(context)).rejects.toThrow();
      await expect(commands.select(context, "available-new-model")).rejects.toThrow();
    }
    await expect(commands.select(owner, "invented-model")).rejects.toThrow();
    await expect(commands.select(owner, testModels.fallback)).rejects.toThrow();
    expect(await configStore.read()).toEqual(before);
    expect((await projects.getProject(projectId))!.project.modelConfig).toBeUndefined();
    await settings.configureSlack({ ...before.slack!, enabled: false });
    await expect(commands.select(owner, "available-new-model")).rejects.toThrow();
  });

  it("频道改绑后不把旧菜单的选择应用到另一个项目", async () => {
    const context = { ...owner, channelId: "C_project" };
    const menu = await commands.read(context);
    await settings.bindSlackProject({ projectId: unrelatedProjectId, channelId: "C_project" });
    await expect(commands.select(context, "available-new-model", menu.scopeId)).rejects.toThrow("频道绑定已变化");
    expect((await projects.getProject(projectId))!.project.modelConfig).toBeUndefined();
    expect((await projects.getProject(unrelatedProjectId))!.project.modelConfig).toBeUndefined();
  });

  it("切换保留当前执行选定模型，下一阶段回合才使用新模型", async () => {
    const created = await workflow.registerProject({ name: "正在工作", repositoryPath: join(directory, "active"), defaultBranch: "main", productDocument: "# 正在工作\n", tasks: [{ title: "验证外部操作", description: "核实外部结果", acceptanceCriteria: [] }] });
    const planning = created.project.currentExecution!;
    const taskId = created.tasks[0]!.id;
    await workflow.submitProjectReport({ projectId: created.project.id, attemptId: planning.attemptId, reportOpportunityId: planning.reportOpportunityId, outcome: "selected", summary: "开始验证", taskIds: [taskId] });
    await workflow.completeProjectTurn(created.project.id, planning.attemptId, planning.turnId!);
    const before = (await projects.findTask(taskId))!.task.currentExecution!;
    await commands.select(owner, "available-new-model");
    expect((await projects.findTask(taskId))!.task.currentExecution).toEqual(before);
    await workflow.submitReport({ taskId, attemptId: before.attemptId, reportOpportunityId: before.reportOpportunityId, outcome: "completed", summary: "外部结果验证完成" });
    await workflow.completeTurn(taskId, before.attemptId, before.turnId!);
    expect((await projects.findTask(taskId))!.task.currentExecution!.modelRouting.model).toBe("available-new-model");
    expect(dispatcher.started.at(-1)?.model).toBe("available-new-model");
  });
});
