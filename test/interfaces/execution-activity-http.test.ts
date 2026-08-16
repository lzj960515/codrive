import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { io as connectSocket, type Socket } from "socket.io-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ExecutionActivityBridge } from "../../src/application/execution-activity-bridge.js";
import { SystemSettingsService } from "../../src/application/system-settings-service.js";
import { WorkflowEngine } from "../../src/application/workflow-engine.js";
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

describe("execution activity HTTP and realtime boundary", () => {
  let server: ReturnType<typeof createHttpServer>;
  let socket: Socket | undefined;
  let store: ProjectStore;
  let bridge: ExecutionActivityBridge;

  beforeEach(async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "codrive-activity-http-"));
    const configStore = new ConfigStore(stateDirectory);
    await configStore.loadOrCreate();
    store = new ProjectStore(stateDirectory);
    const workflow = new WorkflowEngine(
      store,
      new RecordingTaskDispatcher(),
      { maxConcurrentTasks: 1, models: testModels },
      new RecordingProjectExecutor(),
    );
    bridge = new ExecutionActivityBridge({
      store,
      codex: {
        readTurnActivity: async () => null,
      },
    });
    server = createHttpServer({
      store,
      workflow,
      activityBridge: bridge,
      skillInstaller: new SkillInstaller(
        resolve("skills"),
        join(stateDirectory, "skills"),
        "0.7.0",
      ),
      settingsService: new SystemSettingsService(configStore, workflow, {
        listModels: async () => [],
      }),
      accessToken: "activity-secret",
    });
    await server.listen({ host: "127.0.0.1", port: 0 });
  });

  afterEach(async () => {
    socket?.disconnect();
    bridge.close();
    await server.close();
  });

  it("accepts only a safe Hook payload and sends the latest activity to the watched task", async () => {
    const snapshot = await store.createProject({
      name: "Activity",
      repositoryPath: "/workspace/activity",
      defaultBranch: "main",
      productDocument: "# Activity\n",
      tasks: [{ title: "Observe", description: "Observe", acceptanceCriteria: [] }],
    });
    const task = snapshot.tasks[0]!;
    await store.saveTask(snapshot.project.id, {
      ...task,
      status: "developing",
      requestedAction: "develop",
      currentExecution: {
        attemptId: "attempt-live",
        action: "develop",
        threadId: "thread-live",
        turnId: "turn-live",
        status: "running",
        startedAt: "2026-08-16T01:00:00.000Z",
        modelRouting: testModelRouting(),
      },
    });
    const detail = await server.inject({
      method: "GET",
      url: `/api/tasks/${task.id}`,
      headers: { "x-codrive-token": "activity-secret" },
    });
    expect(detail.json().task.currentExecution).toMatchObject({
      attemptId: "attempt-live",
      threadId: "thread-live",
      turnId: "turn-live",
    });
    const page = await server.inject({ method: "GET", url: "/" });
    expect(page.body).toContain('socket.on("task:activity"');
    expect(page.body).toContain('id="current-execution-activity"');
    expect(page.body).toContain('aria-live="polite"');
    expect(page.body).toContain("activity-roll-in");
    expect(page.body).toContain("replaceChildren");
    expect(page.body).toContain("等待下一条活动信号");
    socket = await openSocket(server);
    await expect(watch(socket, "watch:project", { projectId: snapshot.project.id }))
      .resolves.toEqual({ ok: true });
    await expect(watch(socket, "watch:task", { taskId: task.id })).resolves.toEqual({
      ok: true,
      activity: null,
    });
    const activities: unknown[] = [];
    socket.on("task:activity", (activity) => activities.push(activity));

    const rejected = await server.inject({
      method: "POST",
      url: "/api/hooks/activity",
      headers: {
        "content-type": "application/json",
        "x-codrive-token": "activity-secret",
      },
      payload: {
        schemaVersion: 1,
        session_id: "session-live",
        turn_id: "turn-live",
        hook_event_name: "PreToolUse",
        tool_name: "apply_patch",
        occurred_at: "2026-08-16T01:01:00.000Z",
        prompt: "SECRET_PROMPT",
      },
    });
    expect(rejected.statusCode).toBe(400);

    const accepted = await server.inject({
      method: "POST",
      url: "/api/hooks/activity",
      headers: {
        "content-type": "application/json",
        "x-codrive-token": "activity-secret",
      },
      payload: {
        schemaVersion: 1,
        session_id: "session-live",
        turn_id: "turn-live",
        hook_event_name: "PreToolUse",
        tool_name: "apply_patch",
        occurred_at: "2026-08-16T01:01:00.000Z",
      },
    });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).toEqual({ accepted: true });
    await vi.waitFor(() => expect(activities).toHaveLength(1));
    expect(activities[0]).toEqual({
      taskId: task.id,
      activity: expect.objectContaining({
        projectId: snapshot.project.id,
        taskId: task.id,
        attemptId: "attempt-live",
        threadId: "thread-live",
        turnId: "turn-live",
        category: "editing",
        label: "正在编辑文件",
        source: "hook",
      }),
    });
    expect(JSON.stringify(activities)).not.toContain("session-live");
    expect(JSON.stringify(activities)).not.toContain("apply_patch");

    await expect(watch(socket, "watch:task", { taskId: task.id })).resolves.toEqual({
      ok: true,
      activity: expect.objectContaining({ category: "editing" }),
    });
  });
});

async function openSocket(
  server: ReturnType<typeof createHttpServer>,
): Promise<Socket> {
  const address = server.server.address();
  if (!address || typeof address === "string") throw new Error("Missing address");
  const socket = connectSocket(`http://127.0.0.1:${address.port}`, {
    auth: { token: "activity-secret" },
    forceNew: true,
    reconnection: false,
  });
  await new Promise<void>((resolveConnection, rejectConnection) => {
    socket.once("connect", resolveConnection);
    socket.once("connect_error", rejectConnection);
  });
  return socket;
}

async function watch(
  socket: Socket,
  event: string,
  payload: Record<string, string>,
): Promise<unknown> {
  return socket.timeout(1_000).emitWithAck(event, payload);
}
