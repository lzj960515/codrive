import { describe, expect, it } from "vitest";

import {
  createLiveSyncEnvelope,
  liveSyncChangeForStoreEvent,
} from "../../src/domain/live-sync.js";

describe("live sync protocol", () => {
  it("maps task and project store events to their smallest stable scopes", () => {
    expect(
      liveSyncChangeForStoreEvent({
        eventId: "event_task",
        type: "task.execution_started",
        projectId: "project_1",
        taskId: "task_1",
        occurredAt: "2026-08-15T10:00:00.000Z",
      }),
    ).toEqual({
      type: "task.changed",
      scope: "task",
      projectId: "project_1",
      taskId: "task_1",
    });
    expect(
      liveSyncChangeForStoreEvent({
        eventId: "event_project",
        type: "project.paused",
        projectId: "project_1",
        occurredAt: "2026-08-15T10:00:00.000Z",
      }),
    ).toEqual({
      type: "project.changed",
      scope: "project",
      projectId: "project_1",
    });
  });

  it("adds the stable schema and connection-local sequence to every event", () => {
    expect(
      createLiveSyncEnvelope(
        {
          type: "system.changed",
          scope: "system",
        },
        7,
      ),
    ).toEqual({
      schemaVersion: 1,
      sequence: 7,
      type: "system.changed",
      scope: "system",
    });
  });
});
