import { describe, expect, it, vi } from "vitest";

import { createRealtimeWatchCoordinator } from "../../src/interfaces/http/board-realtime-client.js";

describe("RealtimeWatchCoordinator", () => {
  it("serializes overlapping project selections and finishes on the latest scope", async () => {
    let desired = { projectId: "project-alpha", taskId: null };
    let releaseAlphaWatch: (() => void) | undefined;
    const alphaWatchStarted = new Promise<void>((resolve) => {
      releaseAlphaWatch = resolve;
    });
    let continueAlphaWatch: (() => void) | undefined;
    const alphaWatchBlocked = new Promise<void>((resolve) => {
      continueAlphaWatch = resolve;
    });
    const requests: Array<{ event: string; payload: Record<string, string> }> = [];
    const coordinator = createRealtimeWatchCoordinator({
      isConnected: () => true,
      readDesiredWatches: () => desired,
      request: async (event, payload) => {
        requests.push({ event, payload });
        if (
          event === "watch:project" &&
          "projectId" in payload &&
          payload.projectId === "project-alpha"
        ) {
          releaseAlphaWatch?.();
          await alphaWatchBlocked;
        }
      },
    });

    const firstSync = coordinator.sync();
    await alphaWatchStarted;
    desired = { projectId: "project-beta", taskId: null };
    const secondSync = coordinator.sync();
    continueAlphaWatch?.();
    await Promise.all([firstSync, secondSync]);

    expect(requests).toEqual([
      { event: "watch:system", payload: {} },
      { event: "watch:project", payload: { projectId: "project-alpha" } },
      { event: "unwatch:project", payload: { projectId: "project-alpha" } },
      { event: "watch:project", payload: { projectId: "project-beta" } },
    ]);
  });

  it("leaves a task before changing projects and restores all watches after reconnect", async () => {
    let desired = { projectId: "project-alpha", taskId: "task-one" };
    const request = vi.fn(async () => undefined);
    const coordinator = createRealtimeWatchCoordinator({
      isConnected: () => true,
      readDesiredWatches: () => desired,
      request,
    });

    await coordinator.sync();
    desired = { projectId: "project-beta", taskId: "task-two" };
    await coordinator.sync();
    coordinator.reset();
    await coordinator.sync();

    expect(request.mock.calls).toEqual([
      ["watch:system", {}],
      ["watch:project", { projectId: "project-alpha" }],
      ["watch:task", { taskId: "task-one" }],
      ["unwatch:task", { taskId: "task-one" }],
      ["unwatch:project", { projectId: "project-alpha" }],
      ["watch:project", { projectId: "project-beta" }],
      ["watch:task", { taskId: "task-two" }],
      ["watch:system", {}],
      ["watch:project", { projectId: "project-beta" }],
      ["watch:task", { taskId: "task-two" }],
    ]);
  });

  it("ignores a stale acknowledgement after the connection state resets", async () => {
    let releaseOldProjectWatch: (() => void) | undefined;
    const oldProjectWatchStarted = new Promise<void>((resolve) => {
      releaseOldProjectWatch = resolve;
    });
    let continueOldProjectWatch: (() => void) | undefined;
    const oldProjectWatchBlocked = new Promise<void>((resolve) => {
      continueOldProjectWatch = resolve;
    });
    const requests: Array<{ event: string; payload: Record<string, string> }> = [];
    const coordinator = createRealtimeWatchCoordinator({
      isConnected: () => true,
      readDesiredWatches: () => ({
        projectId: "project-alpha",
        taskId: null,
      }),
      request: async (event, payload) => {
        requests.push({ event, payload });
        const firstProjectWatch = requests.filter(
          (request) => request.event === "watch:project",
        ).length === 1;
        if (event === "watch:project" && firstProjectWatch) {
          releaseOldProjectWatch?.();
          await oldProjectWatchBlocked;
        }
      },
    });

    const oldSync = coordinator.sync();
    await oldProjectWatchStarted;
    coordinator.reset();
    const reconnectSync = coordinator.sync();
    continueOldProjectWatch?.();
    await Promise.all([oldSync, reconnectSync]);

    expect(requests).toEqual([
      { event: "watch:system", payload: {} },
      { event: "watch:project", payload: { projectId: "project-alpha" } },
      { event: "watch:system", payload: {} },
      { event: "watch:project", payload: { projectId: "project-alpha" } },
    ]);
  });
});
