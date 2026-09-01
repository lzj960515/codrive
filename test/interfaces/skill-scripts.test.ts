import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { WorkflowEngine } from "../../src/application/workflow-engine.js";
import type { ProjectSnapshot } from "../../src/domain/types.js";
import { ProjectStore } from "../../src/infrastructure/project-store.js";
import { createHttpServer } from "../../src/interfaces/http/server.js";
import {
  RecordingProjectExecutor,
  RecordingTaskDispatcher,
  TestRepositoryPathResolver,
  testModelRouting,
} from "../support/recording-executors.js";

interface CommandSuccess<T> {
  ok: true;
  result: T;
}

describe("bundled Skill scripts", () => {
  let stateDirectory: string;
  let store: ProjectStore;
  let server: ReturnType<typeof createHttpServer>;
  let runtimeSettings: {
    maxConcurrentTasks: number;
    models: { primary: string; fallback: string };
  };

  beforeEach(async () => {
    stateDirectory = await mkdtemp(join(tmpdir(), "codrive-skills-"));
    runtimeSettings = {
      maxConcurrentTasks: 2,
      models: {
        primary: "gpt-5.6-sol",
        fallback: "gpt-5.6-terra",
      },
    };
    store = new ProjectStore(stateDirectory);
    const workflow = new WorkflowEngine(
      store,
      new RecordingTaskDispatcher(),
      {
        maxConcurrentTasks: 2,
        models: {
          primary: "gpt-5.6-sol",
          fallback: "gpt-5.6-terra",
        },
      },
      new TestRepositoryPathResolver(),
      new RecordingProjectExecutor(),
    );
    server = createHttpServer({
      store,
      workflow,
      settingsService: {
        read: async () => ({ settings: runtimeSettings, availableModels: [] }),
        update: async (settings: typeof runtimeSettings) => {
          runtimeSettings = settings;
          return { settings: runtimeSettings, availableModels: [] };
        },
        readProject: async () => ({
          settings: {
            modelConfig: null,
            effectiveModels: runtimeSettings.models,
            source: "global" as const,
          },
          globalModels: runtimeSettings.models,
          availableModels: [],
        }),
        updateProject: async () => ({
          settings: {
            modelConfig: null,
            effectiveModels: runtimeSettings.models,
            source: "global" as const,
          },
          globalModels: runtimeSettings.models,
          availableModels: [],
        }),
      },
      accessToken: "secret",
    });
    await server.listen({ host: "127.0.0.1", port: 0 });
    const address = server.server.address() as AddressInfo;
    await writeFile(
      join(stateDirectory, "config.json"),
      JSON.stringify({
        host: "127.0.0.1",
        port: address.port,
        accessToken: "secret",
      }),
      "utf8",
    );
  });

  afterEach(async () => {
    await server.close();
  });

  it("archives, lists, and restores a project through codrive-control", async () => {
    const created = await store.createProject({
      name: "Quiet project",
      repositoryPath: "/workspace/quiet",
      defaultBranch: "main",
      productDocument: "# Quiet project\n",
      tasks: [{ title: "Later", description: "Backlog", acceptanceCriteria: [] }],
    });

    const archived = commandResult<{ archivedAt: string; scheduling: string }>(
      await runSkill("codrive-control", [
        "project-control",
        created.project.id,
        "archive",
      ]),
    );
    const archivedProjects = JSON.parse(
      await runSkill("codrive-control", ["archived"]),
    ) as { count: number; projects: Array<{ project: { id: string } }> };
    const restored = commandResult<{ archivedAt?: string; scheduling: string }>(
      await runSkill("codrive-control", [
        "project-control",
        created.project.id,
        "unarchive",
      ]),
    );

    expect(archived).toMatchObject({
      archivedAt: expect.stringMatching(/^\d{4}-/),
      scheduling: "paused",
    });
    expect(archivedProjects).toMatchObject({
      count: 1,
      projects: [{ project: { id: created.project.id } }],
    });
    expect(restored).toMatchObject({ scheduling: "paused" });
    expect(restored).not.toHaveProperty("archivedAt");
  });

  it("uses the context and command APIs across all four Skills", async () => {
    const created = commandResult<ProjectSnapshot>(
      await runSkill("codrive-forge", ["register"], {
        name: "Game",
        repositoryPath: "/workspace/game",
        defaultBranch: "main",
        productDocument: "# Game\n",
        tasks: [{ title: "Loop", description: "Build loop", acceptanceCriteria: [] }],
      }),
    );

    const projectContext = JSON.parse(
      await runSkill("codrive-task", ["project-context", created.project.id]),
    ) as {
      requestedAction: string;
      taskDocuments: string[];
      projectDocument: string;
      productFacts: {
        revision: number;
        acceptedDigest: string;
        status: string;
      };
    };
    expect(projectContext).toMatchObject({ requestedAction: "select_tasks" });
    expect(projectContext.taskDocuments).toHaveLength(1);
    expect(projectContext.productFacts.status).toBe("current");

    const reportedOutput = JSON.parse(
      await runSkill("codrive-task", ["project-report", created.project.id], {
        attemptId: created.project.currentExecution!.attemptId,
        outcome: "selected",
        summary: "Start the first task",
        taskIds: [created.tasks[0]!.id],
      }),
    ) as CommandSuccess<{ currentExecution: { result: { outcome: string } } }> & {
      attemptId: string;
      outcome: string;
    };
    expect(reportedOutput).toMatchObject({
      ok: true,
      attemptId: created.project.currentExecution!.attemptId,
      outcome: "selected",
    });
    const reported = reportedOutput.result;
    expect(reported.currentExecution.result.outcome).toBe("selected");

    await writeFile(
      projectContext.projectDocument,
      "# Game\n\n## Audio\n\nAdd an audio milestone.\n",
    );
    const added = commandResult<ProjectSnapshot>(
      await runSkill("codrive-work", ["add", created.project.id], {
        decisionSummary: "Add the audio milestone.",
        expectedRevision: projectContext.productFacts.revision,
        expectedDigest: projectContext.productFacts.acceptedDigest,
        tasks: [
          { title: "Audio", description: "Add audio", acceptanceCriteria: [] },
        ],
      }),
    );
    expect(added.tasks).toHaveLength(2);

    await writeFile(
      projectContext.projectDocument,
      "# Game\n\n## Controls\n\nUse keyboard controls.\n\n## Audio\n\nAdd an audio milestone.\n",
    );
    const controlled = commandResult<{
      productFacts: { revision: number; digest: string };
    }>(
      await runSkill("codrive-control", ["product-document-changed", created.project.id], {
        decisionSummary: "Use keyboard controls.",
        expectedRevision: added.project.productFacts.revision,
        expectedDigest: added.project.productFacts.digest,
      }),
    );
    expect(controlled.productFacts).toMatchObject({
      revision: added.project.productFacts.revision + 1,
    });

    await writeFile(
      projectContext.projectDocument,
      "# Game\n\n## Controls\n\nUse keyboard controls.\n\n## Audio\n\nAdd audible gameplay feedback.\n",
    );

    const updated = commandResult<ProjectSnapshot>(
      await runSkill(
        "codrive-control",
        ["task-update", added.tasks[1]!.id],
        {
          expectedUpdatedAt: added.tasks[1]!.updatedAt,
          decisionSummary: "Clarify the audio task contract.",
          changes: {
            description: "Add one complete audio milestone.",
            acceptanceCriteria: ["Gameplay has audible feedback."],
          },
          productDocumentChange: {
            expectedRevision: controlled.productFacts.revision,
            expectedDigest: controlled.productFacts.digest,
          },
        },
      ),
    );
    expect(updated.project.productFacts.revision).toBe(
      controlled.productFacts.revision + 1,
    );
    expect(updated.tasks.find(({ id }) => id === added.tasks[1]!.id)).toMatchObject({
      description: "Add one complete audio milestone.",
      acceptanceCriteria: ["Gameplay has audible feedback."],
      status: "backlog",
    });

    const board = JSON.parse(
      await runSkill("codrive-control", ["board"]),
    ) as Array<{ tasks: unknown[] }>;
    expect(board[0]?.tasks).toHaveLength(2);

    const cancelled = commandResult<{
      status: string;
      cancellation: { decisionBasis: string; reason: string };
    }>(
      await runSkill(
        "codrive-control",
        ["task-control", added.tasks[1]!.id, "cancel"],
        {
          decisionBasis: "agent_decision",
          reason: "The feature is no longer part of the approved product scope",
        },
      ),
    );
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.cancellation).toMatchObject({
      decisionBasis: "agent_decision",
      reason: "The feature is no longer part of the approved product scope",
    });

    const project = JSON.parse(
      await runSkill("codrive-control", ["project", created.project.id]),
    ) as { productDocument: string };
    expect(project.productDocument).toContain("Use keyboard controls.");
    expect(project.productDocument).toContain("Add audible gameplay feedback.");

    const task = JSON.parse(
      await runSkill("codrive-control", ["task", created.tasks[0]!.id]),
    ) as { task: { id: string }; activities: unknown[] };
    expect(task.task.id).toBe(created.tasks[0]!.id);
    expect(task.activities).toEqual([]);

    const scheduledTask = added.tasks[0]!;
    await store.saveTask(added.project.id, {
      ...scheduledTask,
      status: "working",
      requestedAction: "work",
      currentExecution: {
        attemptId: "attempt_skill_report",
        reportOpportunityId: "report_opportunity_skill_report",
        action: "work",
        status: "running",
        startedAt: new Date().toISOString(),
        modelRouting: testModelRouting(),
      },
    });
    const taskContext = JSON.parse(
      await runSkill("codrive-task", ["context", scheduledTask.id]),
    ) as { attemptId: string; reportOpportunityId: string };
    const resumeAt = new Date(Date.now() + 60 * 60 * 1_000).toISOString();
    const reportPayload = {
      attemptId: taskContext.attemptId,
      reportOpportunityId: taskContext.reportOpportunityId,
      outcome: "blocked",
      summary: "Wait for the external build",
      resumeAt,
      resumePrompt: "Inspect the external build and continue.",
    };
    const blocked = JSON.parse(
      await runSkill("codrive-task", ["report", scheduledTask.id], reportPayload),
    ) as CommandSuccess<{ currentExecution: { status: string } }> & {
      activityId: string;
      reportOpportunityId: string;
    };
    expect(blocked).toMatchObject({
      ok: true,
      activityId: expect.stringMatching(/^activity_/),
      reportOpportunityId: taskContext.reportOpportunityId,
    });
    expect(blocked.result.currentExecution.status).toBe("running");

    const idempotent = JSON.parse(
      await runSkill("codrive-task", ["report", scheduledTask.id], reportPayload),
    ) as { ok: true; activityId: string };
    expect(idempotent).toMatchObject({
      ok: true,
      activityId: blocked.activityId,
    });

    const settings = JSON.parse(
      await runSkill("codrive-control", ["settings"]),
    ) as { settings: typeof runtimeSettings };
    expect(settings.settings.maxConcurrentTasks).toBe(2);

    const updatedSettings = commandResult<{ settings: typeof runtimeSettings }>(
      await runSkill("codrive-control", ["update-settings"], {
        maxConcurrentTasks: 3,
        models: {
          primary: "gpt-5.6-terra",
          fallback: "gpt-5.6-sol",
        },
      }),
    );
    expect(updatedSettings.settings).toEqual(runtimeSettings);
    expect(runtimeSettings.maxConcurrentTasks).toBe(3);
  });

  it.each([
    ["codrive-forge", ["register"]],
    ["codrive-task", ["report", "task_missing"]],
    ["codrive-work", ["add", "project_missing"]],
    ["codrive-control", ["update-settings"]],
    ["codrive-control", ["task-update", "task_missing"]],
  ])(
    "%s requires explicit --json input and never accepts stdin payloads",
    async (skill, args) => {
      await expect(runSkill(skill, args)).rejects.toThrow(
        "requires --json <payload>",
      );
      await expect(runSkillWithOpenStdin(skill, args, {})).rejects.toThrow(
        "requires --json <payload>",
      );
    },
  );

  it.each([
    ["codrive-forge", ["register"]],
    ["codrive-task", ["report", "task_missing"]],
    ["codrive-work", ["add", "project_missing"]],
    ["codrive-control", ["update-settings"]],
    ["codrive-control", ["task-update", "task_missing"]],
  ])("%s reports invalid --json input as a command-line error", async (skill, args) => {
    await expect(
      runSkill(skill, [...args, "--json", "not-json"]),
    ).rejects.toThrow("Invalid JSON supplied to --json");
  });

  it("uses a nonzero exit when Codrive rejects an explicit JSON command", async () => {
    await expect(
      runSkill("codrive-task", ["report", "task_missing"], {
        attemptId: "attempt_missing",
        reportOpportunityId: "report_opportunity_missing",
        outcome: "blocked",
        summary: "Missing task",
      }),
    ).rejects.toThrow(/Codrive (404|500)/);
  });

  function runSkill(
    skill: string,
    args: string[],
    input?: Record<string, unknown>,
  ): Promise<string> {
    const commandArgs = input
      ? [...args, "--json", JSON.stringify(input)]
      : args;
    return runSkillProcess(skill, commandArgs);
  }

  function runSkillWithOpenStdin(
    skill: string,
    args: string[],
    input: Record<string, unknown>,
  ): Promise<string> {
    const script = resolve("skills", skill, "scripts", `${skill}.mjs`);
    return new Promise((resolveOutput, reject) => {
      const child = spawn(process.execPath, [script, ...args], {
        env: { ...process.env, CODEDRIVE_HOME: stateDirectory },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error(`${skill} waited for stdin EOF`));
      }, 1_000);
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timeout);
        if (code === 0) resolveOutput(stdout);
        else reject(new Error(stderr || `Skill script exited with code ${code}`));
      });
      child.stdin.write(JSON.stringify(input));
    });
  }

  function runSkillProcess(
    skill: string,
    args: string[],
  ): Promise<string> {
    const script = resolve("skills", skill, "scripts", `${skill}.mjs`);
    return new Promise((resolveOutput, reject) => {
      const child = spawn(process.execPath, [script, ...args], {
        env: { ...process.env, CODEDRIVE_HOME: stateDirectory },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.once("error", reject);
      child.once("exit", (code) => {
        if (code === 0) resolveOutput(stdout);
        else reject(new Error(stderr || `Skill script exited with code ${code}`));
      });
    });
  }
});

function commandResult<T>(output: string): T {
  const response = JSON.parse(output) as CommandSuccess<T>;
  expect(response.ok).toBe(true);
  return response.result;
}
