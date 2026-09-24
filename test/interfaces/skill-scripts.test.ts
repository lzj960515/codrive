import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { WorkflowEngine } from "../../src/application/workflow-engine.js";
import type { Milestone } from "../../src/domain/milestone.js";
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

  async function writeTaskDocument(repositoryPath: string, name: string, content: string): Promise<string> {
    const taskDocumentPath = `docs/tasks/${name}.md`;
    const filePath = join(repositoryPath, taskDocumentPath);
    await mkdir(join(repositoryPath, "docs/tasks"), { recursive: true });
    await writeFile(filePath, content, "utf8");
    return taskDocumentPath;
  }

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
    const repositoryPath = join(stateDirectory, "game-repository");
    const loopPath = await writeTaskDocument(repositoryPath, "loop", "# 可玩的主流程\n");
    const created = commandResult<ProjectSnapshot>(
      await runSkill("codrive-forge", ["register"], {
        name: "Game",
        repositoryPath,
        defaultBranch: "main",
        productDocument: "# Game\n",
        tasks: [{ title: "Loop", taskDocumentPath: loopPath }],
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
        reportOpportunityId: created.project.currentExecution!.reportOpportunityId,
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
    const audioPath = await writeTaskDocument(repositoryPath, "audio", "# 加入声音反馈\n");
    const added = commandResult<ProjectSnapshot>(
      await runSkill("codrive-work", ["add", created.project.id], {
        decisionSummary: "Add the audio milestone.",
        productDocumentChange: {
          expectedRevision: projectContext.productFacts.revision,
          expectedDigest: projectContext.productFacts.acceptedDigest,
        },
        tasks: [{ title: "Audio", taskDocumentPath: audioPath }],
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

    await writeFile(join(repositoryPath, audioPath), "# 加入声音反馈\n\n游戏过程能听到反馈。\n");
    const updated = commandResult<ProjectSnapshot>(
      await runSkill(
        "codrive-control",
        ["task-update", added.tasks[1]!.id],
        {
          expectedUpdatedAt: added.tasks[1]!.updatedAt,
          decisionSummary: "Clarify the audio task contract.",
          changes: { title: "完整的声音反馈" },
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
      title: "完整的声音反馈",
      taskDocumentPath: audioPath,
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

  it("adds ordinary work without editing or advancing product facts", async () => {
    const repositoryPath = join(stateDirectory, "migration-repository");
    const created = await store.createProject({
      name: "Migration",
      repositoryPath,
      defaultBranch: "main",
      productDocument: "# Stable product contract\n",
      tasks: [{ title: "Original", description: "Existing work", acceptanceCriteria: [] }],
    });
    const taskDocumentPath = await writeTaskDocument(repositoryPath, "consumer", "# 迁移消费者\n");
    const added = commandResult<ProjectSnapshot>(await runSkill(
      "codrive-work", ["add", created.project.id], {
        decisionSummary: "Cover an omitted consumer within the accepted scope",
        tasks: [{ title: "Consumer", taskDocumentPath }],
      },
    ));
    expect(added.tasks).toHaveLength(2);
    expect(added.project.productFacts).toEqual(created.project.productFacts);
    const context = JSON.parse(await runSkill("codrive-work", ["show", created.project.id]));
    expect(context.productFacts.status).toBe("current");
  });

  it("registers a goal without tasks and reports an evidence-backed plan", async () => {
    const repositoryPath = join(stateDirectory, "social-rehearsal-repository");
    const created = commandResult<ProjectSnapshot>(await runSkill("codrive-forge", ["register"], {
      name: "Social rehearsal",
      repositoryPath,
      defaultBranch: "main",
      productDocument: "# Fictional core collection and display\n",
      tasks: [],
      milestones: [{
        title: "Migrate core Social",
        description: "Preserve core collection and display",
        acceptanceCriteria: ["All core consumers have verified destinations"],
      }],
    }));
    expect(created.tasks).toEqual([]);
    expect(created.milestones).toHaveLength(1);
    const milestone = created.milestones[0]!;
    const context = JSON.parse(await runSkill("codrive-task", ["milestone-context", milestone.id]));
    expect(context.requestedAction).toBe("assess_milestone");
    const taskDocumentPath = await writeTaskDocument(repositoryPath, "consumers", "# 排查消费者\n");
    const report = {
      attemptId: context.attemptId,
      reportOpportunityId: context.reportOpportunityId,
      definitionVersion: context.definitionVersion,
      planningRevision: context.planningRevision,
      outcome: "progress",
      summary: "Investigate consumers before migration",
      plan: { tasks: [{ key: "consumers", title: "Inspect consumers", taskDocumentPath }] },
    };
    const accepted = JSON.parse(await runSkill("codrive-task", ["milestone-report", milestone.id], report));
    expect(accepted).toMatchObject({ ok: true, reportOpportunityId: context.reportOpportunityId });
    await runSkill("codrive-task", ["milestone-report", milestone.id], report);
    const snapshot = (await store.getProject(created.project.id))!;
    expect(snapshot.tasks).toHaveLength(1);
    expect(snapshot.tasks[0]!.milestoneId).toBe(milestone.id);
    expect(snapshot.project.productFacts).toEqual(created.project.productFacts);
  });

  it("creates and revises milestone definitions through work and control", async () => {
    const created = await store.createProject({
      name: "Product", repositoryPath: "/workspace/product", defaultBranch: "main",
      productDocument: "# Product\n", tasks: [],
    });
    const milestone = commandResult<Milestone>(await runSkill("codrive-work", ["milestone-create", created.project.id], {
      title: "Migration", description: "Core migration", acceptanceCriteria: ["Core verified"],
    }));
    const context = JSON.parse(await runSkill("codrive-control", ["milestone", milestone.id]));
    expect(context.milestone.id).toBe(milestone.id);
    const updated = commandResult<Milestone>(await runSkill("codrive-control", ["milestone-update", milestone.id], {
      expectedDefinitionVersion: context.milestone.definitionVersion,
      decisionSummary: "User included the historical export",
      changes: { title: "Migration", description: "Core and historical export", acceptanceCriteria: ["Core and export verified"] },
    }));
    expect(updated.definitionVersion).toBe(context.milestone.definitionVersion + 1);
    expect(updated.description).toBe("Core and historical export");
  });

  it("records a non-terminal discovery without occupying the task report opportunity", async () => {
    const repositoryPath = join(stateDirectory, "discovery-repository");
    const created = await store.createProject({
      name: "Discovery", repositoryPath, defaultBranch: "main",
      productDocument: "# Product\n", tasks: [],
    });
    const taskDocumentPath = await writeTaskDocument(repositoryPath, "inspect", "# 排查消费者\n");
    const milestone = commandResult<Milestone>(await runSkill("codrive-work", ["milestone-create", created.project.id], {
      title: "Migration", description: "Keep results", acceptanceCriteria: ["Consumers covered"],
      tasks: [{ title: "Inspect", taskDocumentPath }],
    }));
    const snapshot = (await store.getProject(created.project.id))!;
    const task = snapshot.tasks[0]!;
    await store.saveTask(created.project.id, {
      ...task, status: "working", requestedAction: "work",
      currentExecution: {
        attemptId: "attempt_discovery", reportOpportunityId: "opportunity_discovery",
        action: "work", status: "running", startedAt: new Date().toISOString(), modelRouting: testModelRouting(),
      },
    });
    const discovery = { attemptId: "attempt_discovery", requestId: "request_consumer", summary: "Additional consumer", evidence: ["fixture/consumer.ts:4"] };
    const first = JSON.parse(await runSkill("codrive-task", ["discovery", task.id], discovery));
    const retry = JSON.parse(await runSkill("codrive-task", ["discovery", task.id], discovery));
    expect(first.ok).toBe(true);
    expect(retry.result).toEqual(first.result);
    const context = JSON.parse(await runSkill("codrive-task", ["context", task.id]));
    expect(context).toMatchObject({ attemptId: "attempt_discovery", reportOpportunityId: "opportunity_discovery", requestedAction: "work" });
    const goal = JSON.parse(await runSkill("codrive-control", ["milestone", milestone.id]));
    expect(goal.activities.filter((activity: { type: string }) => activity.type === "discovery")).toHaveLength(1);
  });

  it.each([
    ["codrive-forge", ["register"]],
    ["codrive-task", ["report", "task_missing"]],
    ["codrive-work", ["add", "project_missing"]],
    ["codrive-control", ["update-settings"]],
    ["codrive-control", ["task-update", "task_missing"]],
    ["codrive-work", ["milestone-create", "project_missing"]],
    ["codrive-control", ["milestone-update", "milestone_missing"]],
    ["codrive-task", ["milestone-report", "milestone_missing"]],
    ["codrive-task", ["discovery", "task_missing"]],
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
    ["codrive-work", ["milestone-create", "project_missing"]],
    ["codrive-control", ["milestone-update", "milestone_missing"]],
    ["codrive-task", ["milestone-report", "milestone_missing"]],
    ["codrive-task", ["discovery", "task_missing"]],
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
