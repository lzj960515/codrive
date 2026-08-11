import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";

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

describe("bundled Skill scripts", () => {
  let stateDirectory: string;
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
    const store = new ProjectStore(stateDirectory);
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
      new RecordingProjectExecutor(),
    );
    server = createHttpServer({
      store,
      workflow,
      skillInstaller: new SkillInstaller(
        resolve("skills"),
        join(stateDirectory, "installed-skills"),
        "0.2.0",
      ),
      settingsService: {
        read: async () => ({ settings: runtimeSettings, availableModels: [] }),
        update: async (settings: typeof runtimeSettings) => {
          runtimeSettings = settings;
          return { settings: runtimeSettings, availableModels: [] };
        },
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

  it("uses the context and command APIs across all four Skills", async () => {
    const created = JSON.parse(
      await runSkill("codrive-forge", ["register"], {
        name: "Game",
        repositoryPath: "/workspace/game",
        defaultBranch: "main",
        productDocument: "# Game\n",
        tasks: [{ title: "Loop", description: "Build loop", acceptanceCriteria: [] }],
      }),
    ) as ProjectSnapshot;

    const projectContext = JSON.parse(
      await runSkill("codrive-task", ["project-context", created.project.id]),
    ) as { requestedAction: string; taskDocuments: string[] };
    expect(projectContext).toMatchObject({ requestedAction: "select_tasks" });
    expect(projectContext.taskDocuments).toHaveLength(1);

    const reported = JSON.parse(
      await runSkill("codrive-task", ["project-report", created.project.id], {
        attemptId: created.project.currentExecution!.attemptId,
        outcome: "selected",
        summary: "Start the first task",
        taskIds: [created.tasks[0]!.id],
      }),
    ) as { latestReport: { outcome: string } };
    expect(reported.latestReport.outcome).toBe("selected");

    const added = JSON.parse(
      await runSkill("codrive-work", ["add", created.project.id], {
        tasks: [
          { title: "Audio", description: "Add audio", acceptanceCriteria: [] },
        ],
      }),
    ) as ProjectSnapshot;
    expect(added.tasks).toHaveLength(2);

    const controlled = JSON.parse(
      await runSkill("codrive-control", ["record-decision", created.project.id], {
        decision: "Use keyboard controls.",
      }),
    ) as { contextNotes: string[] };
    expect(controlled.contextNotes).toEqual(["Use keyboard controls."]);

    const board = JSON.parse(
      await runSkill("codrive-control", ["board"]),
    ) as Array<{ tasks: unknown[] }>;
    expect(board[0]?.tasks).toHaveLength(2);

    const cancelled = JSON.parse(
      await runSkill(
        "codrive-control",
        ["task-control", added.tasks[1]!.id, "cancel"],
        {
          decisionBasis: "agent_decision",
          reason: "The feature is no longer part of the approved product scope",
        },
      ),
    ) as {
      status: string;
      cancellation: { decisionBasis: string; reason: string };
    };
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.cancellation).toMatchObject({
      decisionBasis: "agent_decision",
      reason: "The feature is no longer part of the approved product scope",
    });

    const project = JSON.parse(
      await runSkill("codrive-control", ["project", created.project.id]),
    ) as { productDocument: string };
    expect(project.productDocument).toBe("# Game\n");

    const settings = JSON.parse(
      await runSkill("codrive-control", ["settings"]),
    ) as { settings: typeof runtimeSettings };
    expect(settings.settings.maxConcurrentTasks).toBe(2);

    const updatedSettings = JSON.parse(
      await runSkill("codrive-control", ["update-settings"], {
        maxConcurrentTasks: 3,
        models: {
          primary: "gpt-5.6-terra",
          fallback: "gpt-5.6-sol",
        },
      }),
    ) as { settings: typeof runtimeSettings };
    expect(updatedSettings.settings).toEqual(runtimeSettings);
    expect(runtimeSettings.maxConcurrentTasks).toBe(3);
  });

  function runSkill(
    skill: string,
    args: string[],
    input?: Record<string, unknown>,
  ): Promise<string> {
    const script = resolve("skills", skill, "scripts", `${skill}.mjs`);
    return new Promise((resolveOutput, reject) => {
      const child = spawn(process.execPath, [script, ...args], {
        env: { ...process.env, CODEDRIVE_HOME: stateDirectory },
        stdio: ["pipe", "pipe", "pipe"],
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
      child.stdin.end(input ? JSON.stringify(input) : undefined);
    });
  }
});
