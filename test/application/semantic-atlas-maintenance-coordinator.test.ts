import { describe, expect, it } from "vitest";

import { SemanticAtlasMaintenanceCoordinator } from "../../src/application/semantic-atlas-maintenance-coordinator.js";
import type { ProjectSnapshot, Task, TaskActivity } from "../../src/domain/types.js";

describe("SemanticAtlasMaintenanceCoordinator", () => {
  it("persists an integration request, waits for its ordinary maintenance task, then rescans", async () => {
    const sourceTask = task("source", "done");
    const maintenanceTask = task("maintenance", "backlog", {
      kind: "semantic_atlas_maintenance",
      businessDomainId: "commerce",
    });
    const snapshot = projectSnapshot([sourceTask]);
    const state = { schemaVersion: 1 as const, handledIntegrationActivityIds: [], requests: [] };
    const domainResponses: readonly string[][] = [["commerce"], []];
    let domainRead = 0;
    const ensured: string[] = [];
    const coordinator = new SemanticAtlasMaintenanceCoordinator(
      { read: async () => enabledConfig() },
      {
        listProjects: async () => [snapshot],
        listTaskActivities: async () => [integrationActivity(sourceTask.id)],
      },
      { read: async () => state, save: async () => undefined },
      {
        readInstallation: async () => ({ installed: true }),
        listActionableBusinessDomains: async () => domainResponses[domainRead++] ?? [],
      },
      {
        ensureSemanticAtlasMaintenanceTasks: async (_projectId, domains) => {
          ensured.push(...domains);
          snapshot.tasks.push(maintenanceTask);
          return [maintenanceTask];
        },
      },
    );

    await coordinator.reconcile();
    expect(ensured).toEqual(["commerce"]);
    expect(state.requests).toEqual([
      expect.objectContaining({
        id: "integration-source",
        waitingForTaskIds: [maintenanceTask.id],
      }),
    ]);

    await coordinator.reconcile();
    expect(domainRead).toBe(1);
    maintenanceTask.status = "done";
    await coordinator.reconcile();
    expect(domainRead).toBe(2);
    expect(state.requests).toEqual([]);
    expect(state.handledIntegrationActivityIds).toEqual(["integration-source"]);
  });

  it("does not create a self-trigger from a completed Semantic Atlas maintenance task", async () => {
    const maintenanceTask = task("maintenance", "done", {
      kind: "semantic_atlas_maintenance",
      businessDomainId: "commerce",
    });
    const state = { schemaVersion: 1 as const, handledIntegrationActivityIds: [], requests: [] };
    const coordinator = new SemanticAtlasMaintenanceCoordinator(
      { read: async () => enabledConfig() },
      {
        listProjects: async () => [projectSnapshot([maintenanceTask])],
        listTaskActivities: async () => [integrationActivity(maintenanceTask.id)],
      },
      { read: async () => state, save: async () => undefined },
      {
        readInstallation: async () => ({ installed: true }),
        listActionableBusinessDomains: async () => {
          throw new Error("must not query");
        },
      },
      {
        ensureSemanticAtlasMaintenanceTasks: async () => {
          throw new Error("must not create");
        },
      },
    );

    await coordinator.reconcile();
    expect(state.requests).toEqual([]);
  });
});

function enabledConfig() {
  return {
    schemaVersion: 2 as const,
    host: "127.0.0.1" as const,
    port: 4317,
    maxConcurrentTasks: 4,
    models: { primary: "primary", fallback: "fallback" },
    accessToken: "token",
    stateDirectory: "/state",
    semanticAtlas: {
      automaticMaintenance: true,
      enabledAt: "2026-08-31T00:00:00.000Z",
    },
  };
}

function projectSnapshot(tasks: Task[]): ProjectSnapshot {
  return {
    project: {
      id: "project-1",
      name: "Product",
      repositoryPath: "/workspace/product",
      defaultBranch: "main",
      status: "active",
      scheduling: "running",
      requestedAction: null,
      planning: {
        revision: 1,
        changedAt: "2026-08-31T00:00:00.000Z",
        changeReason: "project_registered",
      },
      productFacts: {
        revision: 1,
        digest: "sha256:test",
        changedAt: "2026-08-31T00:00:00.000Z",
      },
      createdAt: "2026-08-31T00:00:00.000Z",
      updatedAt: "2026-08-31T00:00:00.000Z",
    },
    tasks,
  };
}

function task(
  id: string,
  status: Task["status"],
  origin?: Task["origin"],
): Task {
  return {
    id,
    projectId: "project-1",
    title: id,
    description: id,
    acceptanceCriteria: [],
    ...(origin ? { origin } : {}),
    order: 1,
    status,
    requestedAction: null,
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:00.000Z",
  };
}

function integrationActivity(taskId: string): TaskActivity {
  return {
    id: `integration-${taskId}`,
    projectId: "project-1",
    taskId,
    type: "integration_completed",
    summary: "Integrated",
    occurredAt: "2026-08-31T01:00:00.000Z",
  };
}
