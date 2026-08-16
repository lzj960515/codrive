import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { io as connectSocket, type Socket } from "socket.io-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WorkflowEngine } from "../../src/application/workflow-engine.js";
import {
  PackageVersionCheckScheduler,
  type VersionStatusChangedEvent,
} from "../../src/application/package-version-check-scheduler.js";
import { SystemSettingsService } from "../../src/application/system-settings-service.js";
import { SystemUpdateService } from "../../src/application/system-update-service.js";
import { UpgradeCoordinator } from "../../src/application/upgrade-coordinator.js";
import { createTaskReportActivity } from "../../src/domain/task-activity.js";
import type {
  ProjectSnapshot,
  TaskAction,
  TaskReport,
} from "../../src/domain/types.js";
import { ConfigStore } from "../../src/infrastructure/config-store.js";
import { ProjectStore } from "../../src/infrastructure/project-store.js";
import { PackageVersionService } from "../../src/infrastructure/package-version-service.js";
import { SkillInstaller } from "../../src/infrastructure/skill-installer.js";
import { UpgradeStateStore } from "../../src/infrastructure/upgrade-state-store.js";
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
  let taskDispatcher: RecordingTaskDispatcher;
  let server: ReturnType<typeof createHttpServer>;
  let skillInstaller: SkillInstaller;
  let settingsService: SystemSettingsService;
  let versionChecks: PackageVersionCheckScheduler;
  let upgradeStore: UpgradeStateStore;
  let errors: string[];
  let upgradeLaunches: unknown[];
  let publishSystemUpdate: (event: VersionStatusChangedEvent) => void;
  let systemUpdateListeners: Set<(event: VersionStatusChangedEvent) => void>;
  let sockets: Socket[];

  beforeEach(async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "codrive-http-"));
    const configStore = new ConfigStore(stateDirectory);
    await configStore.loadOrCreate();
    store = new ProjectStore(stateDirectory);
    taskDispatcher = new RecordingTaskDispatcher();
    engine = new WorkflowEngine(
      store,
      taskDispatcher,
      { maxConcurrentTasks: 2, models: testModels },
      new RecordingProjectExecutor(),
    );
    skillInstaller = new SkillInstaller(
      resolve("skills"),
      join(stateDirectory, "installed-skills"),
      "0.2.0",
    );
    const versions = new PackageVersionService({
      currentVersion: "0.6.0",
      stateDirectory,
      resolveLatestVersion: async () => "0.7.0",
    });
    versionChecks = new PackageVersionCheckScheduler({ versions });
    upgradeStore = new UpgradeStateStore(stateDirectory);
    const upgrades = new UpgradeCoordinator({
      store: upgradeStore,
      versions,
      stateDirectory,
      launcher: {
        launch: async (request) => {
          upgradeLaunches.push(request);
          return 8123;
        },
      },
      isProcessRunning: () => true,
    });
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
    upgradeLaunches = [];
    sockets = [];
    systemUpdateListeners = new Set();
    publishSystemUpdate = (event) => {
      for (const listener of systemUpdateListeners) listener(event);
    };
    server = createHttpServer({
      store,
      workflow: engine,
      skillInstaller,
      settingsService,
      systemUpdateService: new SystemUpdateService(
        versions,
        upgrades,
        skillInstaller,
        versionChecks,
      ),
      systemUpdateEvents: [
        {
          subscribe: (listener) => {
            systemUpdateListeners.add(listener);
            return () => systemUpdateListeners.delete(listener);
          },
        },
        upgradeStore,
      ],
      currentVersion: "0.6.0",
      accessToken: "secret",
      onError: (message) => errors.push(message),
    });
    await server.ready();
  });

  afterEach(async () => {
    for (const socket of sockets) socket.disconnect();
    await server.close();
  });

  async function listenForRealtime(): Promise<string> {
    await server.listen({ host: "127.0.0.1", port: 0 });
    const address = server.server.address();
    if (!address || typeof address === "string") {
      throw new Error("HTTP test server did not expose a TCP address");
    }
    return `http://127.0.0.1:${address.port}`;
  }

  async function openSocket(url: string, token = "secret"): Promise<Socket> {
    const socket = connectSocket(url, {
      auth: { token },
      autoConnect: false,
      forceNew: true,
      reconnection: false,
    });
    sockets.push(socket);
    const connected = new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("connect_error", reject);
    });
    socket.connect();
    await connected;
    return socket;
  }

  async function expectSocketRejected(
    url: string,
    auth?: Record<string, unknown>,
  ): Promise<void> {
    const socket = connectSocket(url, {
      ...(auth ? { auth } : {}),
      autoConnect: false,
      forceNew: true,
      reconnection: false,
    });
    sockets.push(socket);
    const error = new Promise<Error>((resolve, reject) => {
      socket.once("connect", () => reject(new Error("Socket unexpectedly connected")));
      socket.once("connect_error", resolve);
    });
    socket.connect();
    await expect(error).resolves.toMatchObject({ message: "Unauthorized" });
  }

  async function realtimeRequest(
    socket: Socket,
    event: string,
    payload: Record<string, unknown> = {},
  ): Promise<{ ok: boolean; error?: string }> {
    return socket.timeout(1_000).emitWithAck(event, payload) as Promise<{
      ok: boolean;
      error?: string;
    }>;
  }

  async function settleRealtime(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

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

  async function skillCommand(payload: Record<string, unknown>) {
    return await server.inject({
      method: "POST",
      url: "/api/commands",
      headers: {
        "content-type": "application/json",
        "x-codrive-token": "secret",
        "x-codrive-source": "skill",
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

  async function appendTaskReportActivity(
    projectId: string,
    action: TaskAction,
    report: TaskReport,
    threadId?: string,
    occurredAt = "2026-08-03T00:00:00.000Z",
  ) {
    const activity = createTaskReportActivity({
      activityId: `activity_${report.attemptId}_${report.outcome}`,
      projectId,
      action,
      report,
      ...(threadId ? { threadId } : {}),
      occurredAt,
    });
    await store.appendEvent({
      eventId: `event_${activity.id}`,
      type: "task.activity_recorded",
      projectId,
      taskId: report.taskId,
      attemptId: report.attemptId,
      ...(threadId ? { threadId } : {}),
      occurredAt,
      data: { activity },
    });
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
      cancellation: null,
      projectCancellation: null,
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
      cancellation: null,
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
    expect(health.json()).toEqual({ status: "ok", version: "0.6.0" });
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

  it("checks npm on demand and accepts one fixed-version update operation", async () => {
    const checkNow = vi.spyOn(versionChecks, "checkNow");
    const checked = await command({
      type: "system.check_for_updates",
      payload: {},
    });
    const accepted = await command({
      type: "system.start_upgrade",
      payload: { targetVersion: "0.7.0" },
    });
    const repeated = await command({
      type: "system.start_upgrade",
      payload: { targetVersion: "0.7.0" },
    });
    const concurrentSkillRepair = await command({
      type: "system.install_skills",
      payload: {},
    });

    expect(checked.statusCode).toBe(200);
    expect(checked.json()).toMatchObject({
      version: {
        currentVersion: "0.6.0",
        latestVersion: "0.7.0",
        updateAvailable: true,
      },
      upgrade: null,
      skills: { managedSkillCount: 4 },
    });
    expect(accepted.statusCode).toBe(202);
    expect(repeated.statusCode).toBe(202);
    expect(concurrentSkillRepair.statusCode).toBe(409);
    expect(repeated.json().upgrade.operationId).toBe(
      accepted.json().upgrade.operationId,
    );
    expect(upgradeLaunches).toHaveLength(1);
    expect(checkNow).toHaveBeenCalledTimes(1);
  });

  it("authenticates Socket.IO and validates server-owned watch requests", async () => {
    const created = await registerProject();
    const url = await listenForRealtime();

    await expectSocketRejected(url);
    await expectSocketRejected(url, { token: "wrong" });
    const socket = await openSocket(url);

    await expect(
      realtimeRequest(socket, "watch:project", {
        projectId: created.project.id,
        room: "system",
      }),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      realtimeRequest(socket, "watch:project", { projectId: "missing" }),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      realtimeRequest(socket, "watch:project", {
        projectId: created.project.id,
      }),
    ).resolves.toEqual({ ok: true });
    await expect(
      realtimeRequest(socket, "watch:task", {
        taskId: created.tasks[0]!.id,
      }),
    ).resolves.toEqual({ ok: true });
    await expect(realtimeRequest(socket, "watch:system")).resolves.toEqual({
      ok: true,
    });
  });

  it("isolates project, task, and system invalidations across clients", async () => {
    const alpha = await registerProject("Alpha");
    const [alphaSecondTask] = await store.addTasks(alpha.project.id, [
      {
        title: "Second",
        description: "Second Alpha task",
        acceptanceCriteria: ["Scoped"],
      },
    ]);
    const beta = await registerProject("Beta");
    const url = await listenForRealtime();
    const alphaClient = await openSocket(url);
    const betaClient = await openSocket(url);
    const alphaProjectEvents: unknown[] = [];
    const alphaTaskEvents: unknown[] = [];
    const alphaSystemEvents: unknown[] = [];
    const betaProjectEvents: unknown[] = [];
    const betaTaskEvents: unknown[] = [];
    alphaClient.on("project:changed", (event) => alphaProjectEvents.push(event));
    alphaClient.on("task:changed", (event) => alphaTaskEvents.push(event));
    alphaClient.on("system:changed", (event) => alphaSystemEvents.push(event));
    betaClient.on("project:changed", (event) => betaProjectEvents.push(event));
    betaClient.on("task:changed", (event) => betaTaskEvents.push(event));

    await realtimeRequest(alphaClient, "watch:project", {
      projectId: alpha.project.id,
    });
    await realtimeRequest(alphaClient, "watch:project", {
      projectId: alpha.project.id,
    });
    await realtimeRequest(alphaClient, "watch:task", {
      taskId: alpha.tasks[0]!.id,
    });
    await realtimeRequest(alphaClient, "watch:task", {
      taskId: alpha.tasks[0]!.id,
    });
    await realtimeRequest(alphaClient, "watch:system");
    await realtimeRequest(betaClient, "watch:project", {
      projectId: beta.project.id,
    });
    await realtimeRequest(betaClient, "watch:task", {
      taskId: beta.tasks[0]!.id,
    });

    await store.appendEvent({
      eventId: "alpha-task-change",
      type: "task.changed",
      projectId: alpha.project.id,
      taskId: alpha.tasks[0]!.id,
      occurredAt: new Date().toISOString(),
    });
    await vi.waitFor(() => {
      expect(alphaProjectEvents).toEqual([{ projectId: alpha.project.id }]);
      expect(alphaTaskEvents).toEqual([
        { projectId: alpha.project.id, taskId: alpha.tasks[0]!.id },
      ]);
    });
    expect(betaProjectEvents).toEqual([]);
    expect(betaTaskEvents).toEqual([]);

    await store.appendEvent({
      eventId: "alpha-other-task-change",
      type: "task.changed",
      projectId: alpha.project.id,
      taskId: alphaSecondTask!.id,
      occurredAt: new Date().toISOString(),
    });
    await vi.waitFor(() => expect(alphaProjectEvents).toHaveLength(2));
    expect(alphaTaskEvents).toHaveLength(1);

    publishSystemUpdate({ type: "system.version_status_changed" });
    await vi.waitFor(() => expect(alphaSystemEvents).toEqual([{}]));
    expect(betaProjectEvents).toEqual([]);

    const upgradeTimestamp = new Date().toISOString();
    await upgradeStore.write({
      operationId: "upgrade_test",
      targetVersion: "0.7.0",
      phase: "installing",
      startedAt: upgradeTimestamp,
      updatedAt: upgradeTimestamp,
    });
    await vi.waitFor(() => expect(alphaSystemEvents).toEqual([{}, {}]));

    await realtimeRequest(alphaClient, "watch:project", {
      projectId: beta.project.id,
    });
    await store.appendEvent({
      eventId: "alpha-after-switch",
      type: "task.changed",
      projectId: alpha.project.id,
      taskId: alpha.tasks[0]!.id,
      occurredAt: new Date().toISOString(),
    });
    await settleRealtime();
    expect(alphaProjectEvents).toHaveLength(2);
    expect(alphaTaskEvents).toHaveLength(1);
  });

  it("provides scoped board snapshots and removes the SSE surface", async () => {
    const created = await registerProject();
    const scoped = await server.inject({
      method: "GET",
      url: `/api/board/projects/${created.project.id}`,
      headers: { "x-codrive-token": "secret" },
    });
    const missing = await server.inject({
      method: "GET",
      url: "/api/board/projects/missing",
      headers: { "x-codrive-token": "secret" },
    });
    const oldEvents = await server.inject({
      method: "GET",
      url: "/api/events?token=secret",
    });
    const page = await server.inject({ method: "GET", url: "/" });

    expect(scoped.statusCode).toBe(200);
    expect(scoped.json()).toMatchObject({
      project: { id: created.project.id },
      tasks: [{ id: created.tasks[0]!.id }],
    });
    expect(missing.statusCode).toBe(404);
    expect(oldEvents.statusCode).toBe(404);
    expect(page.body).toContain('<script src="/socket.io/socket.io.js"></script>');
    expect(page.body).toContain('socket.on("project:changed"');
    expect(page.body).toContain('socket.on("task:changed"');
    expect(page.body).toContain('socket.on("system:changed"');
    expect(page.body).toContain('"/api/board/projects/"');
    expect(page.body).toContain("captureViewState");
    expect(page.body).toContain("refreshRealtimeScopes");
    expect(page.body).toContain("createRealtimeWatchCoordinator");
    expect(page.body).not.toContain("new EventSource");
    expect(page.body).not.toContain("window.location.reload");
    const inlineScript = page.body.match(/<script>([\s\S]*)<\/script>/)?.[1];
    expect(() => new Function(inlineScript ?? "")).not.toThrow();
  });

  it("unsubscribes realtime event sources when the server stops", async () => {
    const url = await listenForRealtime();
    await openSocket(url);
    expect(systemUpdateListeners.size).toBe(1);

    await server.close();

    expect(systemUpdateListeners.size).toBe(0);
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
    expect(page.body).toContain("备用模型");
    expect(page.body).toContain(
      "'+escapeHtml(model.displayName)+'</option>'",
    );
    expect(page.body).not.toContain(
      "'+escapeHtml(model.displayName)+' · '+escapeHtml(model.id)+'</option>'",
    );
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

  it("requires a reasoned AI decision and hides stale questions after cancellation", async () => {
    const created = await registerProject();
    const task = created.tasks[0]!;
    await store.saveTask(created.project.id, {
      ...task,
      status: "waiting_for_input",
      requestedAction: "develop",
      currentExecution: {
        attemptId: "attempt_1",
        action: "develop",
        status: "waiting_for_input",
        threadId: "development_thread",
        startedAt: "2026-08-03T00:00:00.000Z",
        modelRouting: testModelRouting(),
      },
    });
    await appendTaskReportActivity(
      created.project.id,
      "develop",
      {
        taskId: task.id,
        attemptId: "attempt_1",
        outcome: "needs_input",
        summary: "Wait for the architecture review",
        question: "Which entity model should this task use?",
      },
      "development_thread",
    );

    const missingReason = await skillCommand({
      type: "task.control",
      payload: {
        taskId: task.id,
        action: "cancel",
        decisionBasis: "user_confirmed",
        reason: "  ",
      },
    });
    const missingBasis = await skillCommand({
      type: "task.control",
      payload: {
        taskId: task.id,
        action: "cancel",
        reason: "The user confirmed cancellation",
      },
    });

    expect(missingReason.statusCode).toBe(400);
    expect(missingBasis.statusCode).toBe(400);

    const cancelled = await skillCommand({
      type: "task.control",
      payload: {
        taskId: task.id,
        action: "cancel",
        decisionBasis: "user_confirmed",
        reason: "The user confirmed that D2 should wait for the D1 architecture review",
      },
    });
    const terminalBoard = await server.inject({
      method: "GET",
      url: "/api/board",
      headers: { "x-codrive-token": "secret" },
    });
    const terminalContext = await server.inject({
      method: "GET",
      url: `/api/contexts/tasks/${task.id}`,
      headers: { "x-codrive-token": "secret" },
    });

    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toMatchObject({
      status: "cancelled",
      cancellation: {
        cancelledBy: "codex",
        decisionBasis: "user_confirmed",
        reason: "The user confirmed that D2 should wait for the D1 architecture review",
      },
    });
    expect(terminalBoard.json()[0].tasks[0]).toMatchObject({
      status: "cancelled",
      cancellation: {
        cancelledBy: "codex",
        decisionBasis: "user_confirmed",
        reason: "The user confirmed that D2 should wait for the D1 architecture review",
      },
    });
    expect(terminalBoard.json()[0].tasks[0]).not.toHaveProperty("question");
    expect(terminalBoard.json()[0].tasks[0]).not.toHaveProperty("report");
    expect(terminalContext.json()).toMatchObject({
      status: "cancelled",
      cancellation: {
        cancelledBy: "codex",
        decisionBasis: "user_confirmed",
        reason: "The user confirmed that D2 should wait for the D1 architecture review",
      },
      projectCancellation: null,
    });
  });

  it("projects a cancelled project instead of its stale planning question", async () => {
    const created = await registerProject();
    const snapshotBeforeProjectCancellation = await store.getProject(
      created.project.id,
    );
    expect(snapshotBeforeProjectCancellation).not.toBeNull();
    const planningRevision = snapshotBeforeProjectCancellation!.project.planning.revision;
    await store.saveProject({
      ...snapshotBeforeProjectCancellation!.project,
      status: "active",
      planning: {
        ...snapshotBeforeProjectCancellation!.project.planning,
        evaluatedRevision: planningRevision,
      },
      currentExecution: {
        attemptId: "selection_1",
        action: "select_tasks",
        status: "completed",
        startedAt: "2026-08-03T00:00:00.000Z",
        finishedAt: "2026-08-03T00:01:00.000Z",
        planningRevision,
        modelRouting: testModelRouting(),
        result: {
          projectId: created.project.id,
          attemptId: "selection_1",
          outcome: "needs_input",
          summary: "A product decision was needed before cancellation",
          question: "Should this product continue?",
        },
      },
    });
    const cancelledProject = await skillCommand({
      type: "project.control",
      payload: {
        projectId: created.project.id,
        action: "cancel",
        decisionBasis: "agent_decision",
        reason: "All remaining work belongs to the canonical replacement project",
      },
    });
    const cancelledProjectBoard = await server.inject({
      method: "GET",
      url: "/api/board",
      headers: { "x-codrive-token": "secret" },
    });
    const cancelledProjectContext = await server.inject({
      method: "GET",
      url: `/api/contexts/projects/${created.project.id}`,
      headers: { "x-codrive-token": "secret" },
    });

    expect(cancelledProject.json()).toMatchObject({
      status: "cancelled",
      cancellation: {
        decisionBasis: "agent_decision",
        reason: "All remaining work belongs to the canonical replacement project",
      },
    });
    expect(cancelledProjectBoard.json()[0].project).toMatchObject({
      status: "cancelled",
      attention: null,
      planning: {
        status: "cancelled",
      },
    });
    expect(cancelledProjectBoard.json()[0].project).not.toHaveProperty("planningNotice");
    expect(cancelledProjectContext.json()).toMatchObject({
      cancellation: {
        cancelledBy: "codex",
        decisionBasis: "agent_decision",
        reason: "All remaining work belongs to the canonical replacement project",
      },
    });
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

  it("accepts planned blocker fields and exposes early-continue controls", async () => {
    const created = await registerProject();
    const task = created.tasks[0]!;
    const execution = {
      attemptId: "attempt_scheduled",
      action: "develop" as const,
      status: "running" as const,
      startedAt: new Date().toISOString(),
      threadId: "thread_scheduled",
      turnId: "turn_scheduled",
      modelRouting: testModelRouting(),
    };
    await store.saveTask(created.project.id, {
      ...task,
      status: "developing",
      requestedAction: "develop",
      currentExecution: execution,
    });
    const resumeAt = new Date(Date.now() + 60 * 60 * 1_000).toISOString();
    const resumePrompt = "PRIVATE_AI_CHECKPOINT_MUST_NOT_REACH_THE_BOARD";

    const reported = await skillCommand({
      type: "task.report",
      payload: {
        taskId: task.id,
        attemptId: execution.attemptId,
        outcome: "blocked",
        summary: "Wait for the remote build",
        resumeAt,
        resumePrompt,
      },
    });
    expect(reported.statusCode).toBe(200);
    await engine.completeTurn(task.id, execution.attemptId, execution.turnId!);

    const detail = await server.inject({
      method: "GET",
      url: `/api/tasks/${task.id}`,
      headers: { "x-codrive-token": "secret" },
    });
    const context = await server.inject({
      method: "GET",
      url: `/api/contexts/tasks/${task.id}`,
      headers: { "x-codrive-token": "secret" },
    });
    expect(detail.json()).toMatchObject({
      task: {
        status: "blocked",
        currentExecution: {
          action: "develop",
          status: "waiting_for_resume",
          scheduledResume: {
            reason: "Wait for the remote build",
            resumeAt,
          },
        },
      },
      activities: [
        expect.objectContaining({
          type: "blocked",
          evidence: expect.objectContaining({ resumeAt }),
        }),
      ],
    });
    expect(detail.body).not.toContain(resumePrompt);
    expect(context.body).toContain(resumePrompt);

    const rescheduledAt = new Date(Date.now() + 2 * 60 * 60 * 1_000).toISOString();
    const rescheduled = await command({
      type: "task.control",
      payload: { taskId: task.id, action: "reschedule", resumeAt: rescheduledAt },
    });
    expect(rescheduled.statusCode).toBe(200);
    expect(rescheduled.json().currentExecution).toMatchObject({
      attemptId: execution.attemptId,
      scheduledResume: { resumeAt: rescheduledAt },
    });

    const continued = await command({
      type: "task.control",
      payload: { taskId: task.id, action: "continue" },
    });
    expect(continued.statusCode).toBe(200);
    expect(continued.json().currentExecution).toMatchObject({
      attemptId: execution.attemptId,
      status: "running",
    });
  });

  it("projects a failed planned resume as an ordinary retryable blocker", async () => {
    const created = await registerProject();
    const task = created.tasks[0]!;
    const execution = {
      attemptId: "attempt_scheduled_failure",
      action: "develop" as const,
      status: "running" as const,
      startedAt: new Date().toISOString(),
      threadId: "thread_scheduled_failure",
      turnId: "turn_scheduled_failure",
      modelRouting: testModelRouting(),
    };
    await store.saveTask(created.project.id, {
      ...task,
      status: "developing",
      requestedAction: "develop",
      currentExecution: execution,
    });
    const resumeAt = new Date(Date.now() + 60 * 60 * 1_000).toISOString();
    await engine.submitReport({
      taskId: task.id,
      attemptId: execution.attemptId,
      outcome: "blocked",
      summary: "Wait for the remote build",
      resumeAt,
      resumePrompt: "Inspect the remote build and continue.",
    });
    await engine.completeTurn(task.id, execution.attemptId, execution.turnId);
    taskDispatcher.beforeResumeScheduledTurn = async () => {
      throw new Error("Codex scheduled turn failed to start");
    };

    const continued = await command({
      type: "task.control",
      payload: { taskId: task.id, action: "continue" },
    });
    const detail = await server.inject({
      method: "GET",
      url: `/api/tasks/${task.id}`,
      headers: { "x-codrive-token": "secret" },
    });
    const board = await server.inject({
      method: "GET",
      url: "/api/board",
      headers: { "x-codrive-token": "secret" },
    });

    expect(continued.statusCode).toBe(200);
    expect(continued.json()).toMatchObject({
      status: "blocked",
      currentExecution: { status: "failed" },
    });
    expect(continued.json().currentExecution).not.toHaveProperty("scheduledResume");
    expect(detail.json()).toMatchObject({
      task: {
        status: "blocked",
        executionStatus: "failed",
        currentExecution: { status: "failed", scheduledResume: null },
      },
    });
    expect(board.json()[0].tasks[0]).toMatchObject({
      status: "blocked",
      executionStatus: "failed",
      scheduledResume: null,
    });

    const retried = await command({
      type: "task.control",
      payload: { taskId: task.id, action: "retry" },
    });
    expect(retried.statusCode).toBe(200);
    expect(retried.json()).toMatchObject({
      status: "developing",
      currentExecution: { status: "running" },
    });
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
        evaluatedRevision: 1,
      },
      currentExecution: {
        attemptId: "selection_1",
        action: "select_tasks",
        status: "completed",
        startedAt: "2026-08-03T00:00:00.000Z",
        finishedAt: "2026-08-03T00:01:00.000Z",
        planningRevision: 1,
        modelRouting: testModelRouting(),
        result: {
          projectId: created.project.id,
          attemptId: "selection_1",
          outcome: "needs_input",
          summary: "A product rule is missing",
          question: "Which rule should be used?",
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
      attention: {
        kind: "decision_requested",
        summary: "A product rule is missing",
        question: "Which rule should be used?",
      },
      planning: {
        revision: 1,
        evaluatedRevision: 1,
        status: "needs_input",
        outcome: "needs_input",
      },
    });
    expect(board.json()[0].project).not.toHaveProperty("planningNotice");
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
      },
      currentExecution: {
        attemptId: "selection_1",
        action: "select_tasks",
        status: "completed",
        startedAt: "2026-08-03T00:00:00.000Z",
        finishedAt: "2026-08-03T00:01:00.000Z",
        planningRevision: 1,
        modelRouting: testModelRouting(),
        result: {
          projectId: created.project.id,
          attemptId: "selection_1",
          outcome: "needs_input",
          summary: "This decision is stale",
          question: "This question is stale",
        },
      },
    });

    const board = await server.inject({
      method: "GET",
      url: "/api/board",
      headers: { "x-codrive-token": "secret" },
    });

    expect(board.json()[0].project).toMatchObject({
      displayStatus: "selecting_tasks",
      attention: null,
      planning: {
        revision: 2,
        status: "pending",
        outcome: null,
      },
    });
    expect(board.json()[0].project).not.toHaveProperty("planningNotice");
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

  it("projects an idle project as current work being empty", async () => {
    const created = await store.createProject({
      name: "Semantic Atlas",
      repositoryPath: "/workspace/game",
      defaultBranch: "main",
      productDocument: "# Semantic Atlas\n",
      tasks: [{ title: "Loop", description: "Build loop", acceptanceCriteria: [] }],
    });
    await store.saveTask(created.project.id, {
      ...created.tasks[0]!,
      status: "done",
    });
    await engine.reconcile();
    await command({
      type: "project.control",
      payload: { projectId: created.project.id, action: "pause" },
    });

    const board = await server.inject({
      method: "GET",
      url: "/api/board",
      headers: { "x-codrive-token": "secret" },
    });
    const page = await server.inject({ method: "GET", url: "/" });

    expect(board.json()[0].project).toMatchObject({
      status: "idle",
      scheduling: "paused",
      displayStatus: "idle",
      planning: { status: "idle" },
    });
    expect(page.body).toContain('idle: "当前无待办"');
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
        evaluatedRevision: 1,
      },
      currentExecution: {
        attemptId: "selection_1",
        action: "select_tasks",
        status: "completed",
        startedAt: "2026-08-10T08:59:00.000Z",
        finishedAt: "2026-08-10T09:00:00.000Z",
        planningRevision: 1,
        modelRouting: testModelRouting(),
        result: {
          projectId: created.project.id,
          attemptId: "selection_1",
          outcome: "wait_for_active_tasks",
          summary,
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
      attention: null,
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
    expect(page.body).not.toContain("调度说明");
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
      currentExecution: {
        attemptId: "attempt_1",
        action: "develop",
        status: "waiting_for_input",
        threadId: "development_thread",
        startedAt: "2026-08-03T00:00:00.000Z",
        modelRouting: testModelRouting(),
      },
    });
    await appendTaskReportActivity(
      created.project.id,
      "develop",
      {
        taskId: created.tasks[0]!.id,
        attemptId: "attempt_0",
        outcome: "completed",
        summary: "The flight loop is implemented",
        workspacePath: "/workspace/game/.worktrees/loop",
        candidateCommit: "candidate_1",
        tests: "Unit tests passed",
      },
      "development_thread",
      "2026-08-02T23:59:00.000Z",
    );
    await appendTaskReportActivity(
      created.project.id,
      "develop",
      {
        taskId: created.tasks[0]!.id,
        attemptId: "attempt_1",
        outcome: "needs_input",
        summary: "A decision is needed",
        question: "Arrows or WASD?",
        findings: ["Keyboard choice is still unresolved"],
      },
      "development_thread",
    );

    const board = await server.inject({
      method: "GET",
      url: "/api/board",
      headers: { "x-codrive-token": "secret" },
    });
    const taskDetail = await server.inject({
      method: "GET",
      url: `/api/tasks/${created.tasks[0]!.id}`,
      headers: { "x-codrive-token": "secret" },
    });
    const page = await server.inject({ method: "GET", url: "/" });

    expect(board.json()[0].tasks[0]).toMatchObject({
      acceptanceCriteria: ["Arrow keys move the ship", "Restart keeps score"],
    });
    expect(board.json()[0].tasks[0]).not.toHaveProperty("summary");
    expect(board.json()[0].tasks[0]).not.toHaveProperty("question");
    expect(board.json()[0].tasks[0]).not.toHaveProperty("report");
    expect(taskDetail.statusCode).toBe(200);
    expect(taskDetail.json()).toMatchObject({
      task: {
        id: created.tasks[0]!.id,
        status: "waiting_for_input",
        currentExecution: {
          action: "develop",
          status: "waiting_for_input",
          threadId: "development_thread",
        },
      },
      activities: [
        expect.objectContaining({
          type: "development_completed",
          summary: "The flight loop is implemented",
          evidence: expect.objectContaining({ tests: "Unit tests passed" }),
        }),
        expect.objectContaining({
          type: "decision_requested",
          summary: "A decision is needed",
          evidence: expect.objectContaining({ question: "Arrows or WASD?" }),
        }),
      ],
      currentDecisionRequest: null,
    });
    expect(page.body).toContain('lang="zh-CN"');
    expect(page.body).toContain("产品工作台");
    expect(page.body).toContain("告诉 Codex 你的想法");
    expect(page.body).toContain("用 Codrive 的方式帮我做一个经营太空货运公司的游戏");
    expect(page.body).toContain("Codrive 更新");
    expect(page.body).toContain("数据保存在本机");
    expect(page.body).toContain("当前对话");
    expect(page.body).toContain("打开当前对话");
    expect(page.body).toContain("前往当前对话回复");
    expect(page.body).toContain("前往对应对话回复");
    expect(page.body).toContain("data-activity-thread");
    expect(page.body).toContain("历史决定请求");
    expect(page.body).not.toContain("任务对话</span>");
    expect(page.body).not.toContain("审查对话</span>");
    expect(page.body).toContain('id="project-sidebar"');
    expect(page.body).toContain('id="task-detail"');
    expect(page.body).toContain("data-copy-task-id");
    expect(page.body).toContain("navigator.clipboard.writeText(task.id)");
    expect(page.body).toContain("复制任务 ID");
    expect(page.body).toContain("取消理由");
    expect(page.body).not.toContain("data-cancel-task");
    expect(page.body).not.toContain('data-project-action="cancel"');
    expect(page.body).toContain('id="mobile-projects"');
    expect(page.body).toContain("验收标准");
    expect(page.body).toContain("进展记录");
    expect(page.body).toContain("请求决定");
    expect(page.body).toContain("提前继续");
    expect(page.body).toContain("重新安排");
    expect(page.body).toContain('timeZoneName: "short"');
    expect(page.body).toContain("new Date(localValue).toISOString()");
    expect(page.body).toContain('class="settings-header"');
    expect(page.body).not.toContain("Runtime controls");
    expect(page.body).not.toContain("本机运行时");
    expect(page.body).toContain(
      ".task-detail-content { width: 100%; max-width: 100%;",
    );
    expect(page.body).toContain("overflow-x: hidden; overflow-y: auto;");
    expect(page.body).toContain(
      'scrollIntoView({ block: "end", inline: "nearest" })',
    );
    expect(page.body).not.toContain("最新进展");
    expect(page.body).not.toContain("当前进展");
    expect(page.body).toContain("selectedTaskId");
    expect(page.body).toContain("data-task");
    expect(page.body).toContain('id="update-dialog"');
    expect(page.body).toContain('id="update-primary"');
    expect(page.body).toContain('id="update-trigger"');
    expect(page.body).toContain('/api/system');
    expect(page.body).toContain('system.install_skills');
    expect(page.body).toContain('system.start_upgrade');
    expect(page.body).toContain('system.check_for_updates');
    expect(page.body).toContain("Codrive 与 Skills 已对齐");
    expect(page.body).toContain("Codrive 正在重启，页面会自动恢复连接");
    expect(page.body).toContain('id="update-timeline"');
    expect(page.body).not.toContain('codrive:skills-dismissed');
    expect(page.body).not.toContain("Codrive 设置有更新");
    expect(page.body).not.toContain("project-strip");
    expect(page.body).not.toContain("$codrive-forge");
    expect(page.body).not.toContain("No projects yet");
    expect(page.body).not.toContain("State stays on this Mac");
    expect(page.body).not.toContain("Product workbench");
    expect(page.body).not.toContain("data-context");
    expect(page.body).not.toContain("<textarea");
  });

  it("keeps current and historical task conversations attached to their lifecycle owners", async () => {
    const created = await registerProject();
    const task = created.tasks[0]!;

    await appendTaskReportActivity(
      created.project.id,
      "develop",
      {
        taskId: task.id,
        attemptId: "attempt_develop",
        outcome: "completed",
        summary: "Development completed",
      },
      "development_thread",
      "2026-08-03T00:00:00.000Z",
    );
    await appendTaskReportActivity(
      created.project.id,
      "review",
      {
        taskId: task.id,
        attemptId: "attempt_review_1",
        outcome: "changes_requested",
        summary: "First review requested changes",
        findings: ["Keep the first review attached to its own conversation"],
      },
      "review_thread_1",
      "2026-08-03T01:00:00.000Z",
    );
    await appendTaskReportActivity(
      created.project.id,
      "review",
      {
        taskId: task.id,
        attemptId: "attempt_review_2",
        outcome: "approved",
        summary: "Second review approved",
        reviewedMainCommit: "main_commit",
      },
      "review_thread_2",
      "2026-08-03T02:00:00.000Z",
    );
    await appendTaskReportActivity(
      created.project.id,
      "integrate",
      {
        taskId: task.id,
        attemptId: "attempt_historical_decision",
        outcome: "needs_input",
        summary: "An earlier decision was requested",
        question: "Keep the old branch?",
      },
      "development_thread",
      "2026-08-03T03:00:00.000Z",
    );
    await appendTaskReportActivity(
      created.project.id,
      "integrate",
      {
        taskId: task.id,
        attemptId: "attempt_historical_decision",
        outcome: "completed",
        summary: "The earlier decision was resolved",
        mergedCommit: "merged_commit",
      },
      "development_thread",
      "2026-08-03T04:00:00.000Z",
    );
    await appendTaskReportActivity(
      created.project.id,
      "develop",
      {
        taskId: task.id,
        attemptId: "attempt_without_thread",
        outcome: "blocked",
        summary: "A historical activity has no source conversation",
      },
      undefined,
      "2026-08-03T05:00:00.000Z",
    );
    await appendTaskReportActivity(
      created.project.id,
      "integrate",
      {
        taskId: task.id,
        attemptId: "attempt_current_decision",
        outcome: "needs_input",
        summary: "The current decision needs a reply",
        question: "Merge the compatibility layer?",
      },
      "development_thread",
      "2026-08-03T06:00:00.000Z",
    );
    await store.saveTask(created.project.id, {
      ...task,
      status: "waiting_for_input",
      requestedAction: "integrate",
      currentExecution: {
        attemptId: "attempt_current_decision",
        action: "integrate",
        status: "waiting_for_input",
        threadId: "development_thread",
        submittedActivityId: "activity_attempt_current_decision_needs_input",
        startedAt: "2026-08-03T06:00:00.000Z",
        modelRouting: testModelRouting(),
      },
    });

    const response = await server.inject({
      method: "GET",
      url: `/api/tasks/${task.id}`,
      headers: { "x-codrive-token": "secret" },
    });
    const detail = response.json();

    expect(response.statusCode).toBe(200);
    expect(detail.task.currentExecution).toMatchObject({
      action: "integrate",
      status: "waiting_for_input",
      threadId: "development_thread",
    });
    expect(detail.activities.map(({ threadId }: { threadId?: string }) => threadId)).toEqual([
      "development_thread",
      "review_thread_1",
      "review_thread_2",
      "development_thread",
      "development_thread",
      undefined,
      "development_thread",
    ]);
    expect(detail.currentDecisionRequest).toMatchObject({
      id: "activity_attempt_current_decision_needs_input",
      threadId: "development_thread",
      evidence: { question: "Merge the compatibility layer?" },
    });
    expect(detail).not.toHaveProperty("conversations");
  });
});
