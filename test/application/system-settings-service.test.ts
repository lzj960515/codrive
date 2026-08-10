import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { SystemSettingsService } from "../../src/application/system-settings-service.js";
import { WorkflowEngine } from "../../src/application/workflow-engine.js";
import { ConfigStore } from "../../src/infrastructure/config-store.js";
import { ProjectStore } from "../../src/infrastructure/project-store.js";
import {
  RecordingProjectExecutor,
  RecordingTaskDispatcher,
  testModels,
} from "../support/recording-executors.js";

describe("SystemSettingsService", () => {
  let configStore: ConfigStore;
  let projectStore: ProjectStore;
  let workflow: WorkflowEngine;
  let service: SystemSettingsService;

  beforeEach(async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "codrive-settings-"));
    configStore = new ConfigStore(stateDirectory);
    await configStore.loadOrCreate();
    projectStore = new ProjectStore(stateDirectory);
    workflow = new WorkflowEngine(
      projectStore,
      new RecordingTaskDispatcher(),
      { maxConcurrentTasks: 4, models: testModels },
      new RecordingProjectExecutor(),
    );
    service = new SystemSettingsService(configStore, workflow, {
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
        {
          id: "gpt-5.6-nano",
          displayName: "GPT-5.6-Nano",
          description: "Small coding model",
          isDefault: false,
        },
      ],
    });
  });

  it("returns persisted runtime settings with the live Codex model catalog", async () => {
    await expect(service.read()).resolves.toEqual({
      settings: {
        maxConcurrentTasks: 4,
        models: testModels,
      },
      availableModels: expect.arrayContaining([
        expect.objectContaining({ id: "gpt-5.6-sol", isDefault: true }),
        expect.objectContaining({ id: "gpt-5.6-terra" }),
      ]),
    });
  });

  it("persists settings and advances each project's planning revision once for a concurrency change", async () => {
    const first = await workflow.registerProject({
      name: "First",
      repositoryPath: "/workspace/first",
      defaultBranch: "main",
      productDocument: "# First\n",
      tasks: [{ title: "A", description: "A", acceptanceCriteria: [] }],
    });
    const second = await workflow.registerProject({
      name: "Second",
      repositoryPath: "/workspace/second",
      defaultBranch: "main",
      productDocument: "# Second\n",
      tasks: [{ title: "B", description: "B", acceptanceCriteria: [] }],
    });

    await service.update({
      maxConcurrentTasks: 2,
      models: {
        primary: "gpt-5.6-terra",
        fallback: "gpt-5.6-nano",
      },
    });
    await workflow.reconcile();

    expect(await configStore.read()).toMatchObject({
      schemaVersion: 2,
      maxConcurrentTasks: 2,
      models: {
        primary: "gpt-5.6-terra",
        fallback: "gpt-5.6-nano",
      },
    });
    for (const projectId of [first.project.id, second.project.id]) {
      expect((await projectStore.getProject(projectId))!.project.planning).toMatchObject({
        revision: 2,
        changeReason: "concurrency_changed",
        concurrencyLimit: 2,
      });
    }
  });

  it("changes model routing without creating a new planning revision", async () => {
    const created = await workflow.registerProject({
      name: "Model Route",
      repositoryPath: "/workspace/model-route",
      defaultBranch: "main",
      productDocument: "# Model Route\n",
      tasks: [{ title: "A", description: "A", acceptanceCriteria: [] }],
    });

    await service.update({
      maxConcurrentTasks: 4,
      models: {
        primary: "gpt-5.6-terra",
        fallback: "gpt-5.6-nano",
      },
    });

    expect((await projectStore.getProject(created.project.id))!.project.planning)
      .toMatchObject({ revision: 1, concurrencyLimit: 4 });
  });

  it("rejects unavailable or identical model routes before saving", async () => {
    await expect(
      service.update({
        maxConcurrentTasks: 4,
        models: { primary: "missing-model", fallback: "gpt-5.6-terra" },
      }),
    ).rejects.toThrow("Model missing-model is not available");
    await expect(
      service.update({
        maxConcurrentTasks: 4,
        models: { primary: "gpt-5.6-sol", fallback: "gpt-5.6-sol" },
      }),
    ).rejects.toThrow("Fallback model must differ from the primary model");

    expect((await configStore.read()).models).toEqual(testModels);
  });
});
