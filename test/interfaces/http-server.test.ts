import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { WorkflowEngine } from "../../src/application/workflow-engine.js";
import type { ProjectSnapshot } from "../../src/domain/types.js";
import { ProjectStore } from "../../src/infrastructure/project-store.js";
import { SkillInstaller } from "../../src/infrastructure/skill-installer.js";
import { createHttpServer } from "../../src/interfaces/http/server.js";
import {
  RecordingProjectExecutor,
  RecordingTaskDispatcher,
} from "../support/recording-executors.js";

describe("HTTP API", () => {
  let store: ProjectStore;
  let engine: WorkflowEngine;
  let server: ReturnType<typeof createHttpServer>;
  let skillInstaller: SkillInstaller;

  beforeEach(async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "codrive-http-"));
    store = new ProjectStore(stateDirectory);
    engine = new WorkflowEngine(
      store,
      new RecordingTaskDispatcher(),
      { maxConcurrentTasks: 2 },
      new RecordingProjectExecutor(),
    );
    skillInstaller = new SkillInstaller(
      resolve("skills"),
      join(stateDirectory, "installed-skills"),
      "0.2.0",
    );
    server = createHttpServer({
      store,
      workflow: engine,
      skillInstaller,
      accessToken: "secret",
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
      status: "selecting_tasks",
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
  });

  it("makes recorded product decisions available to task and project Skills", async () => {
    const created = await registerProject();
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
      status: "selecting_tasks",
      contextNotes: [decision],
    });
    expect(projectContext.json().contextNotes).toEqual([decision]);
    expect(taskContext.json().projectContextNotes).toEqual([decision]);
  });

  it("returns a human-facing board projection without a Web answer form", async () => {
    const created = await store.createProject({
      name: "Game",
      repositoryPath: "/workspace/game",
      defaultBranch: "main",
      productDocument: "# Game\n",
      tasks: [{ title: "Loop", description: "Build loop", acceptanceCriteria: [] }],
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
      },
      currentExecution: {
        attemptId: "attempt_1",
        action: "develop",
        status: "waiting_for_input",
        startedAt: "2026-08-03T00:00:00.000Z",
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
    });
    expect(page.body).toContain("Reply in the linked Codex task");
    expect(page.body).toContain('id="setup-dialog"');
    expect(page.body).toContain('id="setup-later"');
    expect(page.body).toContain('id="setup-trigger"');
    expect(page.body).toContain('/api/system');
    expect(page.body).toContain('system.install_skills');
    expect(page.body).toContain('codrive:skills-dismissed');
    expect(page.body).toContain('Bundled Skills have changed and are ready to update.');
    expect(page.body).not.toContain("data-context");
    expect(page.body).not.toContain("<textarea");
  });
});
