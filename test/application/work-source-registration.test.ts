import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { WorkflowEngine } from "../../src/application/workflow-engine.js";
import { ProjectStore } from "../../src/infrastructure/project-store.js";
import { createHttpServer } from "../../src/interfaces/http/server.js";
import {
  RecordingProjectExecutor,
  RecordingTaskDispatcher,
  TestRepositoryPathResolver,
  testModels,
} from "../support/recording-executors.js";

const source = { kind: "slack" as const, requestId: "event_login_failure" };
const replyTarget = {
  kind: "slack" as const,
  teamId: "T_owner",
  channelId: "C_project",
  threadTs: "1762141200.000001",
};

describe("external work registration", () => {
  let directory: string;
  let repositoryPath: string;
  let store: ProjectStore;
  let projectExecutor: RecordingProjectExecutor;
  let taskDispatcher: RecordingTaskDispatcher;
  let workflow: WorkflowEngine;
  let server: ReturnType<typeof createHttpServer>;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "codrive-work-source-"));
    repositoryPath = join(directory, "repository");
    await mkdir(join(repositoryPath, "docs/tasks"), { recursive: true });
    store = new ProjectStore(join(directory, "state"));
    projectExecutor = new RecordingProjectExecutor();
    taskDispatcher = new RecordingTaskDispatcher();
    workflow = new WorkflowEngine(
      store,
      taskDispatcher,
      { maxConcurrentTasks: 2, models: testModels },
      new TestRepositoryPathResolver(),
      projectExecutor,
    );
    server = createHttpServer({
      store,
      workflow,
      accessToken: "test-token",
      settingsService: {
        read: async () => ({}),
        update: async () => ({}),
        readProject: async () => ({}),
        updateProject: async () => ({}),
      },
    });
    await server.ready();
  });

  afterEach(async () => {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  });

  function projectInput() {
    return {
      name: "登录服务",
      repositoryPath,
      defaultBranch: "main",
      productDocument: "# 登录服务\n\n既有用户可以正常登录。\n",
      tasks: [],
    };
  }

  async function taskInput(name: string) {
    const taskDocumentPath = `docs/tasks/${name}.md`;
    await writeFile(join(repositoryPath, taskDocumentPath), `# ${name}\n\n核实观察到的故障并恢复既有能力。\n`);
    return { title: name, taskDocumentPath, source, replyTarget };
  }

  async function command(payload: Record<string, unknown>) {
    return server.inject({
      method: "POST",
      url: "/api/commands",
      headers: { "x-codrive-token": "test-token" },
      payload,
    });
  }

  it("registers a project without inventing development work", async () => {
    const response = await command({ type: "project.register", payload: projectInput() });
    expect(response.statusCode).toBe(200);

    const [snapshot] = await store.listProjects();
    expect(snapshot).toMatchObject({
      project: { name: "登录服务", status: "idle", requestedAction: null },
      tasks: [],
      milestones: [],
    });
    expect(projectExecutor.started).toHaveLength(0);
    expect(taskDispatcher.started).toHaveLength(0);
    expect(await store.readProductDocument(snapshot!.project.id)).toContain("既有用户可以正常登录");
  });

  it("persists the report destination before the first dispatch and exposes it after restart", async () => {
    const created = await workflow.registerProject(projectInput());
    const input = await taskInput("调查登录失败");
    projectExecutor.beforeStartTurn = async (project) => {
      expect((await store.getProject(project.id))!.tasks[0]).toMatchObject({ source, replyTarget });
    };
    const response = await command({
      type: "project.add_work",
      payload: { projectId: created.project.id, decisionSummary: "按观察事实调查故障", tasks: [input] },
    });
    expect(response.statusCode).toBe(200);
    const selected = (await store.getProject(created.project.id))!;
    const execution = selected.project.currentExecution!;
    taskDispatcher.beforeStartTurn = async (request) => {
      expect((await store.findTask(request.task.id))!.task).toMatchObject({ source, replyTarget });
    };
    await workflow.submitProjectReport({
      projectId: created.project.id,
      attemptId: execution.attemptId,
      reportOpportunityId: execution.reportOpportunityId,
      outcome: "selected",
      summary: "开始调查故障",
      taskIds: [selected.tasks[0]!.id],
    });
    await workflow.completeProjectTurn(created.project.id, execution.attemptId, execution.turnId!);
    expect(taskDispatcher.started).toHaveLength(1);

    const taskId = selected.tasks[0]!.id;
    await rm(store.taskPath(created.project.id, taskId));
    const restarted = new ProjectStore(store.stateDirectory);
    await restarted.initialize();
    expect((await restarted.findTask(taskId))!.task).toMatchObject({ source, replyTarget });
    const context = await server.inject({
      url: `/api/contexts/tasks/${taskId}`,
      headers: { "x-codrive-token": "test-token" },
    });
    expect(context.statusCode).toBe(200);
    expect(context.json()).toMatchObject({ source, replyTarget });
    const detail = await server.inject({
      url: `/api/tasks/${taskId}`,
      headers: { "x-codrive-token": "test-token" },
    });
    expect(detail.json().task).toMatchObject({ source, replyTarget });
  });

  it("reuses one multi-task batch when the same source request is retried concurrently", async () => {
    const created = await workflow.registerProject(projectInput());
    const inputs = [await taskInput("调查登录失败"), await taskInput("验证已有用户登录")];
    const [first, repeated] = await Promise.all([
      workflow.addProjectWork(created.project.id, inputs, "调查已报告故障"),
      workflow.addProjectWork(created.project.id, inputs, "调查已报告故障"),
    ]);
    expect(repeated.tasks.map(({ id }) => id)).toEqual(first.tasks.map(({ id }) => id));
    expect(repeated.tasks).toHaveLength(2);
    expect(repeated.project.planning.revision).toBe(first.project.planning.revision);
    expect((await store.getProject(created.project.id))!.tasks).toHaveLength(2);
  });

  it("rejects reusing a source request for a different reply destination", async () => {
    const created = await workflow.registerProject(projectInput());
    const input = await taskInput("调查登录失败");
    await workflow.addProjectWork(created.project.id, [input], "调查已报告故障");
    await expect(workflow.addProjectWork(created.project.id, [{
      ...input,
      replyTarget: { ...replyTarget, channelId: "C_another_project" },
    }], "重试同一请求")).rejects.toThrow(/source|request|registered/i);
    const snapshot = (await store.getProject(created.project.id))!;
    expect(snapshot.tasks).toHaveLength(1);
    expect(snapshot.tasks[0]).toMatchObject({ source, replyTarget });
  });

  it.each(["C_project", "G_private_project"])("rejects a channel destination without its root message: %s", async (channelId) => {
    const created = await workflow.registerProject(projectInput());
    const input = await taskInput("调查登录失败");
    const response = await command({
      type: "project.add_work",
      payload: {
        projectId: created.project.id, decisionSummary: "调查已报告故障",
        tasks: [{ ...input, replyTarget: { kind: "slack", teamId: "T_owner", channelId } }],
      },
    });
    expect(response.statusCode).toBe(409);
    expect((await store.getProject(created.project.id))!.tasks).toEqual([]);
    expect(projectExecutor.started).toHaveLength(0);
    expect(taskDispatcher.started).toHaveLength(0);
  });

  it("accepts a direct message destination without creating a reply thread", async () => {
    const created = await workflow.registerProject(projectInput());
    const input = await taskInput("调查登录失败");
    const directMessage = { kind: "slack", teamId: "T_owner", channelId: "D_owner" };
    const response = await command({
      type: "project.add_work",
      payload: {
        projectId: created.project.id, decisionSummary: "调查私信报告的故障",
        tasks: [{ ...input, replyTarget: directMessage }],
      },
    });
    expect(response.statusCode).toBe(200);
    const [registered] = (await store.getProject(created.project.id))!.tasks;
    expect(registered).toMatchObject({ source, replyTarget: directMessage });
    expect(registered!.replyTarget).not.toHaveProperty("threadTs");
  });

  it("requires source and reply destination together while preserving ordinary tasks", async () => {
    const created = await workflow.registerProject(projectInput());
    const input = await taskInput("调查登录失败");
    const { replyTarget: _replyTarget, ...missingDestination } = input;
    const { source: _source, ...missingSource } = input;
    await expect(store.addTasks(created.project.id, [missingDestination])).rejects.toThrow(/source|reply|destination/i);
    await expect(store.addTasks(created.project.id, [missingSource])).rejects.toThrow(/source|reply|destination/i);
    const { source: _unusedSource, replyTarget: _unusedDestination, ...ordinary } = input;
    const [task] = await store.addTasks(created.project.id, [ordinary]);
    expect(task).not.toHaveProperty("source");
    expect(task).not.toHaveProperty("replyTarget");
    expect((await store.findTask(task!.id))!.task.id).toBe(task!.id);
  });
});
