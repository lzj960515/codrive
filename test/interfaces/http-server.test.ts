import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { WorkflowEngine } from "../../src/application/workflow-engine.js";
import { SystemSettingsService } from "../../src/application/system-settings-service.js";
import type { ProjectSnapshot } from "../../src/domain/types.js";
import { ConfigStore } from "../../src/infrastructure/config-store.js";
import { ProjectStore } from "../../src/infrastructure/project-store.js";
import { SkillInstaller } from "../../src/infrastructure/skill-installer.js";
import { createHttpServer } from "../../src/interfaces/http/server.js";
import {
  RecordingProjectExecutor,
  RecordingTaskDispatcher,
  testModelRouting,
  testModels,
} from "../support/recording-executors.js";

describe("HTTP API", () => {
  let store: ProjectStore;
  let engine: WorkflowEngine;
  let server: ReturnType<typeof createHttpServer>;
  let skillInstaller: SkillInstaller;
  let settingsService: SystemSettingsService;
  let errors: string[];

  beforeEach(async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "codrive-http-"));
    const configStore = new ConfigStore(stateDirectory);
    await configStore.loadOrCreate();
    store = new ProjectStore(stateDirectory);
    engine = new WorkflowEngine(
      store,
      new RecordingTaskDispatcher(),
      { maxConcurrentTasks: 2, models: testModels },
      new RecordingProjectExecutor(),
    );
    skillInstaller = new SkillInstaller(
      resolve("skills"),
      join(stateDirectory, "installed-skills"),
      "0.2.0",
    );
    settingsService = new SystemSettingsService(configStore, engine, {
      listModels: async () => [
        {
          id: "gpt-5.6-sol",
          displayName: "GPT-5.6-Sol",
          description: "Frontier coding model",
          isDefault: true,
        },
        {
          id: "gpt-5.6-terra",
          displayName: "GPT-5.6-Terra",
          description: "Balanced coding model",
          isDefault: false,
        },
      ],
    });
    errors = [];
    server = createHttpServer({
      store,
      workflow: engine,
      skillInstaller,
      settingsService,
      accessToken: "secret",
      onError: (message) => errors.push(message),
    });
    await server.ready();
  });

  afterEach(async () => {
    await server.close();
  });

  async function command(payload: Record<string, unknown>) {
    return await server.inject({
      method: "POST",
      url: "/api/commands",
      headers: {
        "content-type": "application/json",
        "x-codrive-token": "secret",
      },
      payload: JSON.stringify(payload),
    });
  }

  async function registerProject(name = "Game") {
    const response = await command({
      type: "project.register",
      payload: {
        name,
        repositoryPath: "/workspace/game",
        defaultBranch: "main",
        productDocument: `# ${name}\n`,
        tasks: [
          {
            title: "Loop",
            description: "Build loop",
            acceptanceCriteria: ["Playable"],
          },
        ],
      },
    });
    expect(response.statusCode).toBe(200);
    return response.json() as ProjectSnapshot;
  }

  it("exposes only the board, context, and command surfaces", async () => {
    const created = await registerProject();
    const taskId = created.tasks[0]!.id;

    const taskContext = await server.inject({
      method: "GET",
      url: `/api/contexts/tasks/${taskId}`,
      headers: { "x-codrive-token": "secret" },
    });
    const projectContext = await server.inject({
      method: "GET",
      url: `/api/contexts/projects/${created.project.id}`,
      headers: { "x-codrive-token": "secret" },
    });
    const oldProjectRoute = await server.inject({
      method: "GET",
      url: "/api/projects",
      headers: { "x-codrive-token": "secret" },
    });
    const oldAnswerRoute = await server.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/context`,
      headers: { "x-codrive-token": "secret" },
      payload: { context: "This must stay in Codex App" },
    });

    expect(taskContext.statusCode).toBe(200);
    expect(taskContext.json()).toMatchObject({
      taskId,
      status: "backlog",
      requestedAction: null,
      repositoryPath: "/workspace/game",
    });
    expect(taskContext.json().projectDocument).toContain("PROJECT.md");
    expect(taskContext.json().taskDocument).toContain(`${taskId}.json`);
    expect(projectContext.json()).toMatchObject({
      projectId: created.project.id,
      requestedAction: "select_tasks",
      availableTaskSlots: 2,
      planningRevision: 1,
      planning: { revision: 1 },
      contextNotes: [],
    });
    expect(oldProjectRoute.statusCode).toBe(404);
    expect(oldAnswerRoute.statusCode).toBe(404);
  });

  it("requires the local access token outside health and the board page", async () => {
    const board = await server.inject({ method: "GET", url: "/api/board" });
    const health = await server.inject({ method: "GET", url: "/api/health" });
    const page = await server.inject({ method: "GET", url: "/" });

    expect(board.statusCode).toBe(401);
    expect(health.statusCode).toBe(200);
    expect(page.statusCode).toBe(200);
  });

  it("installs and reports bundled Skills through the system boundary", async () => {
    const missing = await server.inject({
      method: "GET",
      url: "/api/system",
      headers: { "x-codrive-token": "secret" },
    });
    const installed = await command({
      type: "system.install_skills",
      payload: {},
    });
    const current = await server.inject({
      method: "GET",
      url: "/api/system",
      headers: { "x-codrive-token": "secret" },
    });

    expect(missing.statusCode).toBe(200);
    expect(missing.json().skills).toMatchObject({
      state: "missing",
      bundledVersion: "0.2.0",
    });
    expect(installed.statusCode).toBe(200);
    expect(installed.json().skills.state).toBe("current");
    expect(current.json().skills.state).toBe("current");
  });

  it("reads and updates concurrency and model routing through the settings boundary", async () => {
    const current = await server.inject({
      method: "GET",
      url: "/api/system/settings",
      headers: { "x-codrive-token": "secret" },
    });
    const updated = await command({
      type: "system.update_settings",
      payload: {
        maxConcurrentTasks: 2,
        models: {
          primary: "gpt-5.6-terra",
          fallback: "gpt-5.6-sol",
        },
      },
    });
    const page = await server.inject({ method: "GET", url: "/settings" });

    expect(current.statusCode).toBe(200);
    expect(current.json()).toMatchObject({
      settings: { maxConcurrentTasks: 4, models: testModels },
      availableModels: [
        { id: "gpt-5.6-sol" },
        { id: "gpt-5.6-terra" },
      ],
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      settings: {
        maxConcurrentTasks: 2,
        models: {
          primary: "gpt-5.6-terra",
          fallback: "gpt-5.6-sol",
        },
      },
    });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("运行设置");
    expect(page.body).toContain("每个项目的并发任务数");
    expect(page.body).toContain("默认模型");
    expect(page.body).toContain("Fallback 模型");
    const clientScript = page.body.match(/<script>([\s\S]+)<\/script>/)?.[1];
    expect(clientScript).toBeDefined();
    expect(() => new Function(clientScript!)).not.toThrow();
  });

  it("resolves a unique project from its repository path", async () => {
    const created = await registerProject();

    const response = await server.inject({
      method: "GET",
      url: "/api/contexts/resolve?cwd=%2Fworkspace%2Fgame%2Fsrc",
      headers: { "x-codrive-token": "secret" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      projectId: created.project.id,
      status: "active",
      scheduling: "running",
    });
  });

  it("reports ambiguity instead of choosing between projects for a Skill", async () => {
    await registerProject("Game");
    await registerProject("Expansion");

    const response = await server.inject({
      method: "GET",
      url: "/api/contexts/resolve?cwd=%2Fworkspace%2Fgame%2Fsrc",
      headers: { "x-codrive-token": "secret" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: "Multiple Codrive projects match cwd",
    });
    expect(response.json().projectIds).toHaveLength(2);
  });

  it("validates and executes business commands through one endpoint", async () => {
    const created = await registerProject();

    const paused = await command({
      type: "project.control",
      payload: { projectId: created.project.id, action: "pause" },
    });
    const invalid = await command({
      type: "project.control",
      payload: { projectId: created.project.id, action: "explode" },
    });
    const staleReport = await command({
      type: "task.report",
      payload: {
        taskId: created.tasks[0]!.id,
        attemptId: "stale_attempt",
        outcome: "completed",
        summary: "Stale",
        workspacePath: "/workspace/game/.worktrees/loop",
        candidateCommit: "abc123",
      },
    });

    expect(paused.statusCode).toBe(200);
    expect(paused.json()).toMatchObject({ scheduling: "paused" });
    expect(invalid.statusCode).toBe(400);
    expect(staleReport.statusCode).toBe(409);
    expect(errors).toEqual([
      expect.stringMatching(/^POST \/api\/commands 400:/),
      expect.stringMatching(/^POST \/api\/commands 409:/),
    ]);
  });

  it("exposes project execution retry separately from scheduling resume", async () => {
    const created = await registerProject();
    const failedAttempt = created.project.currentExecution!;
    await engine.failProjectTurn(
      created.project.id,
      failedAttempt.attemptId,
      {
        turnId: failedAttempt.turnId!,
        message: "Planner process failed",
      },
    );

    const resumed = await command({
      type: "project.control",
      payload: { projectId: created.project.id, action: "resume" },
    });
    const retried = await command({
      type: "project.control",
      payload: { projectId: created.project.id, action: "retry" },
    });

    expect(resumed.json()).toMatchObject({
      status: "active",
      currentExecution: { attemptId: failedAttempt.attemptId, status: "failed" },
    });
    expect(retried.json()).toMatchObject({
      status: "active",
      currentExecution: { status: "running" },
    });
    expect(retried.json().currentExecution.attemptId).not.toBe(
      failedAttempt.attemptId,
    );
  });

  it("rejects control commands until startup recovery has completed", async () => {
    const startingServer = createHttpServer({
      store,
      workflow: engine,
      skillInstaller,
      accessToken: "secret",
      isReady: () => false,
    } as Parameters<typeof createHttpServer>[0]);
    await startingServer.ready();
    try {
      const health = await startingServer.inject({
        method: "GET",
        url: "/api/health",
      });
      const response = await startingServer.inject({
        method: "POST",
        url: "/api/commands",
        headers: {
          "content-type": "application/json",
          "x-codrive-token": "secret",
        },
        payload: JSON.stringify({
          type: "project.control",
          payload: { projectId: "project_1", action: "resume" },
        }),
      });

      expect(health.json()).toEqual({ status: "starting" });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        error: "Codrive is still recovering persisted executions",
      });
    } finally {
      await startingServer.close();
    }
  });

  it("records command causality and rejected outcomes without request bodies", async () => {
    const created = await registerProject();
    const events: Array<Record<string, unknown>> = [];
    store.subscribe((event) => events.push(event as unknown as Record<string, unknown>));

    const paused = await command({
      type: "project.control",
      payload: { projectId: created.project.id, action: "pause" },
    });
    const rejected = await command({
      type: "task.report",
      payload: {
        taskId: created.tasks[0]!.id,
        attemptId: "stale_attempt",
        outcome: "blocked",
        summary: "PRIVATE_REPORT_BODY_MUST_NOT_APPEAR",
      },
    });

    expect(paused.statusCode).toBe(200);
    expect(rejected.statusCode).toBe(409);
    const received = events.find(
      (event) =>
        event.type === "command.received" &&
        (event.data as { commandType?: string })?.commandType === "project.control",
    );
    const succeeded = events.find(
      (event) => event.type === "command.succeeded" && event.commandId === received?.commandId,
    );
    const commandRejected = events.find(
      (event) =>
        event.type === "command.rejected" &&
        (event.data as { commandType?: string })?.commandType === "task.report",
    );
    expect(received).toMatchObject({
      source: "http",
      result: "received",
      commandId: expect.any(String),
      correlationId: expect.any(String),
    });
    expect(succeeded).toMatchObject({ result: "succeeded" });
    expect(commandRejected).toMatchObject({
      result: "rejected",
      reason: expect.stringMatching(/does not match the current execution/),
    });
    expect(JSON.stringify(events)).not.toContain("PRIVATE_REPORT_BODY_MUST_NOT_APPEAR");
    const persistedEvents = (await readFile(
      join(
        store.stateDirectory,
        "projects",
        created.project.id,
        "events.ndjson",
      ),
      "utf8",
    ))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(
      persistedEvents.find(
        (event) =>
          event.type === "command.rejected" &&
          (event.data as { commandType?: string })?.commandType === "task.report",
      ),
    ).not.toHaveProperty("state");
    expect(JSON.stringify(persistedEvents)).not.toContain(
      "PRIVATE_REPORT_BODY_MUST_NOT_APPEAR",
    );
  });

  it("makes recorded product decisions available to task and project Skills", async () => {
    const created = await registerProject();
    const firstAttempt = created.project.currentExecution!.attemptId;
    const decision = "Use keyboard controls for the first playable version.";
    const recorded = await command({
      type: "project.record_decision",
      payload: { projectId: created.project.id, decision },
    });

    const projectContext = await server.inject({
      method: "GET",
      url: `/api/contexts/projects/${created.project.id}`,
      headers: { "x-codrive-token": "secret" },
    });
    const taskContext = await server.inject({
      method: "GET",
      url: `/api/contexts/tasks/${created.tasks[0]!.id}`,
      headers: { "x-codrive-token": "secret" },
    });

    expect(recorded.statusCode).toBe(200);
    expect(recorded.json()).toMatchObject({
      status: "active",
      contextNotes: [decision],
      planning: { revision: 2, changeReason: "project_decision_recorded" },
      currentExecution: { action: "select_tasks", planningRevision: 2 },
    });
    expect(recorded.json().currentExecution.attemptId).not.toBe(firstAttempt);
    expect(projectContext.json().contextNotes).toEqual([decision]);
    expect(taskContext.json().projectContextNotes).toEqual([decision]);
  });

  it("exposes manual replanning as an explicit planning revision", async () => {
    const created = await registerProject();
    const firstAttempt = created.project.currentExecution!.attemptId;

    const response = await command({
      type: "project.control",
      payload: { projectId: created.project.id, action: "replan" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "active",
      planning: { revision: 2, changeReason: "manual_replan" },
      currentExecution: {
        action: "select_tasks",
        planningRevision: 2,
        selectionCapacity: 2,
      },
    });
    expect(response.json().currentExecution.attemptId).not.toBe(firstAttempt);
  });

  it("projects task-selection decisions without blocking active task work", async () => {
    const created = await store.createProject({
      name: "Planning Game",
      repositoryPath: "/workspace/planning-game",
      defaultBranch: "main",
      productDocument: "# Planning Game\n",
      tasks: [
        { title: "Active", description: "Build", acceptanceCriteria: [] },
        { title: "Backlog", description: "Decide", acceptanceCriteria: [] },
      ],
    });
    await store.saveTask(created.project.id, {
      ...created.tasks[0]!,
      status: "developing",
      requestedAction: "develop",
      currentExecution: {
        attemptId: "active_1",
        action: "develop",
        status: "running",
        startedAt: "2026-08-03T00:00:00.000Z",
        modelRouting: testModelRouting(),
      },
    });
    await store.saveProject({
      ...created.project,
      planning: {
        ...created.project.planning,
        lastDecision: {
          revision: 1,
          outcome: "needs_input",
          summary: "A product rule is missing",
          question: "Which rule should be used?",
          taskIds: [],
          wakeCondition: "project_decision_recorded",
          nextAction: "record_project_decision",
          decidedAt: "2026-08-03T00:01:00.000Z",
        },
      },
    });

    const board = await server.inject({
      method: "GET",
      url: "/api/board",
      headers: { "x-codrive-token": "secret" },
    });

    expect(board.json()[0].project).toMatchObject({
      status: "active",
      displayStatus: "active",
      planningNotice: {
        summary: "A product rule is missing",
        question: "Which rule should be used?",
      },
      planning: {
        revision: 1,
        status: "needs_input",
        outcome: "needs_input",
        wakeCondition: "project_decision_recorded",
        nextAction: "record_project_decision",
      },
    });
  });

  it("does not project a decision from an earlier planning revision", async () => {
    const created = await store.createProject({
      name: "Replanned Game",
      repositoryPath: "/workspace/replanned-game",
      defaultBranch: "main",
      productDocument: "# Replanned Game\n",
      tasks: [{ title: "Backlog", description: "Build", acceptanceCriteria: [] }],
    });
    await store.saveProject({
      ...created.project,
      planning: {
        revision: 2,
        changedAt: "2026-08-03T00:02:00.000Z",
        changeReason: "manual_replan",
        lastDecision: {
          revision: 1,
          outcome: "needs_input",
          summary: "This decision is stale",
          question: "This question is stale",
          taskIds: [],
          wakeCondition: "project_decision_recorded",
          nextAction: "record_project_decision",
          decidedAt: "2026-08-03T00:01:00.000Z",
        },
      },
      latestReport: {
        projectId: created.project.id,
        attemptId: "selection_1",
        outcome: "needs_input",
        summary: "This decision is stale",
        question: "This question is stale",
      },
    });

    const board = await server.inject({
      method: "GET",
      url: "/api/board",
      headers: { "x-codrive-token": "secret" },
    });

    expect(board.json()[0].project).toMatchObject({
      displayStatus: "selecting_tasks",
      planningNotice: null,
      planning: {
        revision: 2,
        status: "pending",
        outcome: null,
        summary: null,
        question: null,
      },
    });
  });

  it("projects paused scheduling before active project workflow status", async () => {
    const created = await registerProject("Semantic Atlas");

    await command({
      type: "project.control",
      payload: { projectId: created.project.id, action: "pause" },
    });
    const board = await server.inject({
      method: "GET",
      url: "/api/board",
      headers: { "x-codrive-token": "secret" },
    });

    expect(board.json()[0].project).toMatchObject({
      status: "active",
      scheduling: "paused",
      displayStatus: "paused",
    });
  });

  it("exposes registered product information and the complete planning notice", async () => {
    const created = await registerProject("Semantic Atlas");
    const summary =
      "当前不新增任务：产品契约与评测基线任务仅因所选模型容量不足而失败，原任务工作树保留了未提交现场，仍应由原任务对话继续。";
    await store.saveProject({
      ...created.project,
      contextNotes: ["地图数据由本地 fixture 提供"],
      planning: {
        ...created.project.planning,
        lastDecision: {
          revision: 1,
          outcome: "wait_for_active_tasks",
          summary,
          taskIds: [],
          wakeCondition: "task_completed",
          nextAction: "wait_for_task_completion",
          decidedAt: "2026-08-10T09:00:00.000Z",
        },
      },
    });

    const detail = await server.inject({
      method: "GET",
      url: `/api/projects/${created.project.id}`,
      headers: { "x-codrive-token": "secret" },
    });
    const missing = await server.inject({
      method: "GET",
      url: "/api/projects/missing",
      headers: { "x-codrive-token": "secret" },
    });
    const page = await server.inject({
      method: "GET",
      url: `/projects/${created.project.id}`,
    });

    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      project: {
        id: created.project.id,
        name: "Semantic Atlas",
        repositoryPath: "/workspace/game",
        defaultBranch: "main",
        contextNotes: ["地图数据由本地 fixture 提供"],
      },
      productDocument: "# Semantic Atlas\n",
      planningNotice: {
        summary,
        outcome: "wait_for_active_tasks",
      },
      tasks: [
        expect.objectContaining({
          id: created.tasks[0]!.id,
          title: "Loop",
          status: "backlog",
        }),
      ],
    });
    expect(missing.statusCode).toBe(404);
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("产品详情");
    expect(page.body).toContain("产品文档");
    expect(page.body).toContain("调度说明");
  });

  it("returns a human-facing board projection without a Web answer form", async () => {
    const created = await store.createProject({
      name: "Game",
      repositoryPath: "/workspace/game",
      defaultBranch: "main",
      productDocument: "# Game\n",
      tasks: [{
        title: "Loop",
        description: "Build the playable flight loop",
        acceptanceCriteria: ["Arrow keys move the ship", "Restart keeps score"],
      }],
    });
    await store.saveTask(created.project.id, {
      ...created.tasks[0]!,
      status: "waiting_for_input",
      requestedAction: "develop",
      developmentThreadId: "development_thread",
      latestReport: {
        taskId: created.tasks[0]!.id,
        attemptId: "attempt_1",
        outcome: "needs_input",
        summary: "A decision is needed",
        question: "Arrows or WASD?",
        tests: "Unit tests passed",
        findings: ["Keyboard choice is still unresolved"],
      },
      currentExecution: {
        attemptId: "attempt_1",
        action: "develop",
        status: "waiting_for_input",
        startedAt: "2026-08-03T00:00:00.000Z",
        modelRouting: testModelRouting(),
      },
    });

    const board = await server.inject({
      method: "GET",
      url: "/api/board",
      headers: { "x-codrive-token": "secret" },
    });
    const page = await server.inject({ method: "GET", url: "/" });

    expect(board.json()[0].tasks[0]).toMatchObject({
      question: "Arrows or WASD?",
      developmentThreadId: "development_thread",
      acceptanceCriteria: ["Arrow keys move the ship", "Restart keeps score"],
      report: {
        outcome: "needs_input",
        tests: "Unit tests passed",
        findings: ["Keyboard choice is still unresolved"],
      },
    });
    expect(page.body).toContain('lang="zh-CN"');
    expect(page.body).toContain("产品工作台");
    expect(page.body).toContain("告诉 Codex 你的想法");
    expect(page.body).toContain("用 Codrive 的方式帮我做一个经营太空货运公司的游戏");
    expect(page.body).toContain("连接 Codex");
    expect(page.body).toContain("数据保存在本机");
    expect(page.body).toContain("请在对应的 Codex 对话中回复");
    expect(page.body).toContain('id="project-sidebar"');
    expect(page.body).toContain('id="task-detail"');
    expect(page.body).toContain("data-copy-task-id");
    expect(page.body).toContain("navigator.clipboard.writeText(task.id)");
    expect(page.body).toContain("复制任务 ID");
    expect(page.body).toContain('id="mobile-projects"');
    expect(page.body).toContain("验收标准");
    expect(page.body).toContain("selectedTaskId");
    expect(page.body).toContain("data-task");
    expect(page.body).toContain('id="setup-dialog"');
    expect(page.body).toContain('id="setup-later"');
    expect(page.body).toContain('id="setup-trigger"');
    expect(page.body).toContain('/api/system');
    expect(page.body).toContain('system.install_skills');
    expect(page.body).toContain('codrive:skills-dismissed');
    expect(page.body).toContain("Codrive 设置有更新，可以立即升级。");
    expect(page.body).toContain("完成一次设置即可使用");
    expect(page.body).not.toContain("project-strip");
    expect(page.body).not.toContain("$codrive-forge");
    expect(page.body).not.toContain("No projects yet");
    expect(page.body).not.toContain("State stays on this Mac");
    expect(page.body).not.toContain("Product workbench");
    expect(page.body).not.toContain("data-context");
    expect(page.body).not.toContain("<textarea");
  });
});
