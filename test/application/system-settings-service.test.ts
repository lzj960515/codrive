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
  TestRepositoryPathResolver,
  testModels,
} from "../support/recording-executors.js";

describe("SystemSettingsService", () => {
  let configStore: ConfigStore;
  let projectStore: ProjectStore;
  let workflow: WorkflowEngine;
  let service: SystemSettingsService;
  let taskDispatcher: RecordingTaskDispatcher;
  let projectExecutor: RecordingProjectExecutor;
  let maintenanceSettingsChanges: number;

  beforeEach(async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "codrive-settings-"));
    configStore = new ConfigStore(stateDirectory);
    await configStore.loadOrCreate();
    projectStore = new ProjectStore(stateDirectory);
    taskDispatcher = new RecordingTaskDispatcher();
    projectExecutor = new RecordingProjectExecutor();
    maintenanceSettingsChanges = 0;
    workflow = new WorkflowEngine(
      projectStore,
      taskDispatcher,
      { maxConcurrentTasks: 4, models: testModels },
      new TestRepositoryPathResolver(),
      projectExecutor,
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
    }, {
      readInstallation: async () => ({ installed: true }),
    }, {
      settingsChanged: async () => {
        maintenanceSettingsChanges += 1;
      },
    }, () => "2026-08-31T08:00:00.000Z");
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
      semanticAtlas: {
        installed: true,
        automaticMaintenance: false,
      },
    });
  });

  it("persists the Semantic Atlas automation toggle and wakes maintenance", async () => {
    await service.update({
      maxConcurrentTasks: 4,
      models: testModels,
      semanticAtlasAutomaticMaintenance: true,
    });

    expect(await configStore.read()).toMatchObject({
      semanticAtlas: {
        automaticMaintenance: true,
        enabledAt: "2026-08-31T08:00:00.000Z",
      },
    });
    expect(maintenanceSettingsChanges).toBe(1);
    await expect(service.read()).resolves.toMatchObject({
      semanticAtlas: { installed: true, automaticMaintenance: true },
    });
  });

  it("refuses to enable automatic maintenance when Semantic Atlas is not installed", async () => {
    const unavailable = new SystemSettingsService(
      configStore,
      workflow,
      { listModels: async () => [{
        id: "gpt-5.6-sol",
        displayName: "Sol",
        description: "Primary",
        isDefault: true,
      }, {
        id: "gpt-5.6-terra",
        displayName: "Terra",
        description: "Fallback",
        isDefault: false,
      }] },
      { readInstallation: async () => ({ installed: false }) },
      { settingsChanged: async () => undefined },
    );

    await expect(unavailable.update({
      maxConcurrentTasks: 4,
      models: testModels,
      semanticAtlasAutomaticMaintenance: true,
    })).rejects.toThrow("Semantic Atlas must be installed");
    expect((await configStore.read()).semanticAtlas).toBeUndefined();
  });

  it("preserves an enabled integration when the CLI is temporarily unavailable", async () => {
    await service.update({
      maxConcurrentTasks: 4,
      models: testModels,
      semanticAtlasAutomaticMaintenance: true,
    });
    const unavailable = new SystemSettingsService(
      configStore,
      workflow,
      { listModels: async () => [{
        id: "gpt-5.6-sol",
        displayName: "Sol",
        description: "Primary",
        isDefault: true,
      }, {
        id: "gpt-5.6-terra",
        displayName: "Terra",
        description: "Fallback",
        isDefault: false,
      }] },
      { readInstallation: async () => ({ installed: false }) },
    );

    await unavailable.update({
      maxConcurrentTasks: 3,
      models: testModels,
    });

    expect(await configStore.read()).toMatchObject({
      maxConcurrentTasks: 3,
      semanticAtlas: {
        automaticMaintenance: true,
        enabledAt: "2026-08-31T08:00:00.000Z",
      },
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

  it("inherits global models until a project-specific route is configured", async () => {
    const created = await workflow.registerProject({
      name: "Important Project",
      repositoryPath: "/workspace/important",
      defaultBranch: "main",
      productDocument: "# Important Project\n",
      tasks: [{ title: "A", description: "A", acceptanceCriteria: [] }],
    });

    await expect(service.readProject(created.project.id)).resolves.toMatchObject({
      settings: {
        modelConfig: null,
        effectiveModels: testModels,
        source: "global",
      },
    });

    const configuredModels = {
      primary: "gpt-5.6-terra",
      fallback: "gpt-5.6-nano",
    };
    await service.updateProject(created.project.id, {
      modelConfig: configuredModels,
    });

    await expect(service.readProject(created.project.id)).resolves.toMatchObject({
      settings: {
        modelConfig: configuredModels,
        effectiveModels: configuredModels,
        source: "project",
      },
    });
    expect((await projectStore.getProject(created.project.id))!.project).toMatchObject({
      modelConfig: configuredModels,
      planning: { revision: 1 },
    });
  });

  it("uses the project route for later task execution and restores global inheritance", async () => {
    const created = await workflow.registerProject({
      name: "Important Project",
      repositoryPath: "/workspace/important",
      defaultBranch: "main",
      productDocument: "# Important Project\n",
      tasks: [{ title: "A", description: "A", acceptanceCriteria: [] }],
    });
    const configuredModels = {
      primary: "gpt-5.6-terra",
      fallback: "gpt-5.6-nano",
    };
    await service.updateProject(created.project.id, {
      modelConfig: configuredModels,
    });

    const selection = (await projectStore.getProject(created.project.id))!.project
      .currentExecution!;
    await workflow.submitProjectReport({
      projectId: created.project.id,
      attemptId: selection.attemptId,
      outcome: "selected",
      summary: "Start the task",
      taskIds: [created.tasks[0]!.id],
    });
    await workflow.completeProjectTurn(
      created.project.id,
      selection.attemptId,
      selection.turnId!,
    );

    expect(taskDispatcher.started.at(-1)?.model).toBe(configuredModels.primary);

    await service.updateProject(created.project.id, { modelConfig: null });
    await expect(service.readProject(created.project.id)).resolves.toMatchObject({
      settings: {
        modelConfig: null,
        effectiveModels: testModels,
        source: "global",
      },
    });
    expect((await projectStore.getProject(created.project.id))!.project).not.toHaveProperty(
      "modelConfig",
    );
  });

  it("uses the project route for project planning", async () => {
    const created = await projectStore.createProject({
      name: "Important Project",
      repositoryPath: "/workspace/important",
      defaultBranch: "main",
      productDocument: "# Important Project\n",
      tasks: [{ title: "A", description: "A", acceptanceCriteria: [] }],
    });
    const configuredModels = {
      primary: "gpt-5.6-terra",
      fallback: "gpt-5.6-nano",
    };
    await service.updateProject(created.project.id, {
      modelConfig: configuredModels,
    });

    await workflow.reconcile();

    expect(
      projectExecutor.started.at(-1)?.project.currentExecution?.modelRouting.model,
    ).toBe(configuredModels.primary);
  });

  it("rejects an unavailable project route without changing the project", async () => {
    const created = await workflow.registerProject({
      name: "Important Project",
      repositoryPath: "/workspace/important",
      defaultBranch: "main",
      productDocument: "# Important Project\n",
      tasks: [{ title: "A", description: "A", acceptanceCriteria: [] }],
    });

    await expect(
      service.updateProject(created.project.id, {
        modelConfig: {
          primary: "missing-model",
          fallback: "gpt-5.6-terra",
        },
      }),
    ).rejects.toThrow("Model missing-model is not available");
    expect((await projectStore.getProject(created.project.id))!.project).not.toHaveProperty(
      "modelConfig",
    );
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
