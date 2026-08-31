import { describe, expect, it, vi } from "vitest";

import { SemanticAtlasMaintenanceCoordinator } from "../../src/application/semantic-atlas-maintenance-coordinator.js";
import type {
  CodriveEvent,
  ProjectSnapshot,
  Task,
  TaskActivity,
} from "../../src/domain/types.js";

describe("SemanticAtlasMaintenanceCoordinator", () => {
  it("checks only the project from a persisted integration event and creates one task", async () => {
    const fixture = coordinatorFixture();
    fixture.maintenanceRequired = true;
    await fixture.coordinator.start();

    fixture.publishCompletedIntegration("source");

    await vi.waitFor(() => expect(fixture.ensuredProjectIds).toEqual(["project-1"]));
    expect(fixture.checkedRepositories).toEqual(["/workspace/product"]);
    expect(fixture.listProjectsCalls).toBe(1);
    expect(fixture.activityReads).toEqual(["project-1", "project-1"]);
    expect(fixture.state).toEqual({
      schemaVersion: 1,
      handledIntegrationActivityIds: ["integration-source"],
      requests: [],
    });
    await fixture.coordinator.stop();
  });

  it("retains a failed check and retries that project on its next integration", async () => {
    const fixture = coordinatorFixture([
      task("source", "done"),
      task("later", "done"),
    ]);
    fixture.maintenanceError = new Error("status unavailable");
    await fixture.coordinator.start();

    fixture.publishCompletedIntegration("source");
    await vi.waitFor(() =>
      expect(fixture.state.requests.map(({ id }) => id)).toEqual([
        "integration-source",
      ])
    );
    expect(fixture.state.handledIntegrationActivityIds).toEqual([]);

    fixture.maintenanceError = undefined;
    fixture.publishCompletedIntegration("later");
    await vi.waitFor(() =>
      expect(fixture.state.handledIntegrationActivityIds).toEqual([
        "integration-source",
        "integration-later",
      ])
    );
    expect(fixture.checkedRepositories).toEqual([
      "/workspace/product",
      "/workspace/product",
    ]);
    await fixture.coordinator.stop();
  });

  it("finishes the event without creating a task when no maintenance is required", async () => {
    const fixture = coordinatorFixture();
    await fixture.coordinator.start();

    fixture.publishCompletedIntegration("source");

    await vi.waitFor(() =>
      expect(fixture.state.handledIntegrationActivityIds).toEqual(["integration-source"])
    );
    expect(fixture.checkedRepositories).toEqual(["/workspace/product"]);
    expect(fixture.ensuredProjectIds).toEqual([]);
    await fixture.coordinator.stop();
  });

  it("does not query or create while the current project already has open maintenance", async () => {
    const fixture = coordinatorFixture([
      task("source", "done"),
      task("maintenance", "backlog", { kind: "semantic_atlas_maintenance" }),
    ]);
    fixture.maintenanceRequired = true;
    await fixture.coordinator.start();

    fixture.publishCompletedIntegration("source");

    await vi.waitFor(() =>
      expect(fixture.state.handledIntegrationActivityIds).toEqual(["integration-source"])
    );
    expect(fixture.checkedRepositories).toEqual([]);
    expect(fixture.ensuredProjectIds).toEqual([]);
    await fixture.coordinator.stop();
  });

  it("replays an unhandled persisted integration once when Codrive starts", async () => {
    const fixture = coordinatorFixture();
    fixture.maintenanceRequired = true;
    fixture.persistedActivities.push(integrationActivity("source"));

    await fixture.coordinator.start();
    expect(fixture.ensuredProjectIds).toEqual(["project-1"]);
    await fixture.coordinator.stop();
    fixture.completeOpenMaintenanceTasks();

    const restarted = fixture.restart();
    await restarted.coordinator.start();
    expect(restarted.checkedRepositories).toEqual([]);
    expect(restarted.ensuredProjectIds).toEqual([]);
    await restarted.coordinator.stop();
  });

  it("checks again after a maintenance task itself completes integration", async () => {
    const fixture = coordinatorFixture([
      task("source", "done"),
      task("maintenance", "done", { kind: "semantic_atlas_maintenance" }),
    ]);
    fixture.maintenanceRequired = true;
    await fixture.coordinator.start();

    fixture.publishCompletedIntegration("maintenance");

    await vi.waitFor(() => expect(fixture.ensuredProjectIds).toEqual(["project-1"]));
    expect(fixture.checkedRepositories).toEqual(["/workspace/product"]);
    await fixture.coordinator.stop();
  });

  it("waits for the maintenance task to reach done before consuming its integration", async () => {
    const fixture = coordinatorFixture([
      task("source", "done"),
      task("maintenance", "integrating", { kind: "semantic_atlas_maintenance" }),
    ]);
    fixture.maintenanceRequired = true;
    await fixture.coordinator.start();

    fixture.publish(integrationEvent("maintenance"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(fixture.state.handledIntegrationActivityIds).toEqual([]);
    expect(fixture.checkedRepositories).toEqual([]);

    fixture.completeOpenMaintenanceTasks();
    fixture.publish(taskCompletedEvent("maintenance"));

    await vi.waitFor(() =>
      expect(fixture.checkedRepositories).toEqual(["/workspace/product"])
    );
    expect(fixture.ensuredProjectIds).toEqual(["project-1"]);
    expect(fixture.state.handledIntegrationActivityIds).toEqual([
      "integration-maintenance",
    ]);
    await fixture.coordinator.stop();
  });

  it("defers a persisted integration until recovery finishes the source task", async () => {
    const fixture = coordinatorFixture([
      task("source", "done"),
      task("maintenance", "integrating", { kind: "semantic_atlas_maintenance" }),
    ]);
    fixture.maintenanceRequired = true;
    fixture.persistedActivities.push(integrationActivity("maintenance"));

    await fixture.coordinator.start();
    expect(fixture.checkedRepositories).toEqual([]);
    expect(fixture.state.handledIntegrationActivityIds).toEqual([]);

    fixture.completeOpenMaintenanceTasks();
    fixture.publish(taskCompletedEvent("maintenance"));

    await vi.waitFor(() =>
      expect(fixture.checkedRepositories).toEqual(["/workspace/product"])
    );
    expect(fixture.state.handledIntegrationActivityIds).toEqual([
      "integration-maintenance",
    ]);
    await fixture.coordinator.stop();
  });

  it("drains an accepted integration event before shutdown completes", async () => {
    const fixture = coordinatorFixture();
    fixture.maintenanceRequired = true;
    const releaseCheck = fixture.holdMaintenanceCheck();
    await fixture.coordinator.start();

    fixture.publishCompletedIntegration("source");
    await vi.waitFor(() =>
      expect(fixture.checkedRepositories).toEqual(["/workspace/product"])
    );

    let stopped = false;
    const stopping = fixture.coordinator.stop().then(() => {
      stopped = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(stopped).toBe(false);

    releaseCheck();
    await stopping;
    expect(fixture.ensuredProjectIds).toEqual(["project-1"]);
  });
});

function coordinatorFixture(initialTasks: Task[] = [task("source", "done")]) {
  const snapshot = projectSnapshot(initialTasks);
  const state = {
    schemaVersion: 1 as const,
    handledIntegrationActivityIds: [] as string[],
    requests: [] as Array<{
      id: string;
      projectId: string;
      sourceTaskId: string;
      createdAt: string;
    }>,
  };
  const persistedActivities: TaskActivity[] = [];
  const checkedRepositories: string[] = [];
  const ensuredProjectIds: string[] = [];
  let listener: ((event: CodriveEvent) => void) | undefined;
  let maintenanceRequired = false;
  let maintenanceError: Error | undefined;
  let maintenanceCheckGate: Promise<void> | undefined;
  let listProjectsCalls = 0;
  const activityReads: string[] = [];

  const create = () => new SemanticAtlasMaintenanceCoordinator(
    { read: async () => enabledConfig() },
    {
      subscribe: (nextListener) => {
        listener = nextListener;
        return () => {
          if (listener === nextListener) listener = undefined;
        };
      },
      listProjects: async () => {
        listProjectsCalls += 1;
        return [snapshot];
      },
      listTaskActivities: async (projectId) => {
        activityReads.push(projectId);
        return persistedActivities;
      },
      getProject: async (projectId) => projectId === snapshot.project.id ? snapshot : null,
    },
    { read: async () => state, save: async () => undefined },
    {
      readInstallation: async () => ({ installed: true }),
      maintenanceRequired: async (repositoryPath) => {
        checkedRepositories.push(repositoryPath);
        await maintenanceCheckGate;
        if (maintenanceError) throw maintenanceError;
        return maintenanceRequired;
      },
    },
    {
      ensureSemanticAtlasMaintenanceTask: async (projectId) => {
        ensuredProjectIds.push(projectId);
        const maintenance = task(
          `maintenance-${ensuredProjectIds.length}`,
          "backlog",
          { kind: "semantic_atlas_maintenance" },
        );
        snapshot.tasks.push(maintenance);
        return maintenance;
      },
    },
  );

  const fixture = {
    coordinator: create(),
    state,
    persistedActivities,
    checkedRepositories,
    ensuredProjectIds,
    activityReads,
    get listProjectsCalls() {
      return listProjectsCalls;
    },
    publish(event: CodriveEvent) {
      const activity = event.data?.activity;
      if (
        event.type === "task.activity_recorded" &&
        activity &&
        typeof activity === "object" &&
        "type" in activity
      ) {
        persistedActivities.push(activity as TaskActivity);
      }
      listener?.(event);
    },
    publishCompletedIntegration(taskId: string) {
      fixture.publish(integrationEvent(taskId));
      fixture.publish(taskCompletedEvent(taskId));
    },
    completeOpenMaintenanceTasks() {
      for (const currentTask of snapshot.tasks) {
        if (currentTask.origin?.kind === "semantic_atlas_maintenance") {
          currentTask.status = "done";
        }
      }
    },
    holdMaintenanceCheck() {
      let release!: () => void;
      maintenanceCheckGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        maintenanceCheckGate = undefined;
        release();
      };
    },
    restart() {
      checkedRepositories.splice(0);
      ensuredProjectIds.splice(0);
      fixture.coordinator = create();
      return fixture;
    },
    get maintenanceRequired() {
      return maintenanceRequired;
    },
    set maintenanceRequired(value: boolean) {
      maintenanceRequired = value;
    },
    get maintenanceError() {
      return maintenanceError;
    },
    set maintenanceError(value: Error | undefined) {
      maintenanceError = value;
    },
  };
  return fixture;
}

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

function integrationEvent(taskId: string): CodriveEvent {
  const activity = integrationActivity(taskId);
  return {
    schemaVersion: 1,
    eventId: `event-${activity.id}`,
    type: "task.activity_recorded",
    projectId: "project-1",
    taskId,
    occurredAt: activity.occurredAt,
    data: { activity },
  };
}

function taskCompletedEvent(taskId: string): CodriveEvent {
  return {
    schemaVersion: 1,
    eventId: `completed-${taskId}`,
    type: "task.completed",
    projectId: "project-1",
    taskId,
    occurredAt: "2026-08-31T01:00:01.000Z",
    before: {
      status: "integrating",
      requestedAction: "integrate",
      action: "integrate",
      executionStatus: "running",
    },
    after: {
      status: "done",
      requestedAction: null,
      action: "integrate",
      executionStatus: "completed",
    },
  };
}
