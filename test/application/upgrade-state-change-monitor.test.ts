import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { UpgradeStateChangeMonitor } from "../../src/application/upgrade-state-change-monitor.js";
import type { UpgradeState } from "../../src/domain/system-update.js";
import { UpgradeStateStore } from "../../src/infrastructure/upgrade-state-store.js";

describe("UpgradeStateChangeMonitor", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("publishes installing and failed phases written by an independent worker store", async () => {
    vi.useFakeTimers();
    const directory = await mkdtemp(join(tmpdir(), "codrive-upgrade-events-"));
    const serviceStore = new UpgradeStateStore(directory);
    const workerStore = new UpgradeStateStore(directory);
    const checking = upgradeState("checking");
    await serviceStore.write(checking);
    const monitor = new UpgradeStateChangeMonitor({
      store: serviceStore,
      intervalMs: 25,
    });
    const phases: string[] = [];
    const unsubscribe = monitor.subscribe((event) => {
      if (event.type === "system.upgrade_state_changed" && event.phase) {
        phases.push(event.phase);
      }
    });
    await monitor.start();

    await workerStore.write({
      ...upgradeState("failed"),
      completedAt: "2026-08-15T10:00:02.000Z",
      phaseStartedAt: {
        checking: "2026-08-15T10:00:00.000Z",
        installing: "2026-08-15T10:00:01.000Z",
        failed: "2026-08-15T10:00:02.000Z",
      },
      error: {
        code: "package_install_failed",
        summary: "The package could not be installed.",
      },
    });
    await vi.advanceTimersByTimeAsync(25);

    await vi.waitFor(() => {
      expect(phases).toEqual(["installing", "failed"]);
    });
    unsubscribe();
    monitor.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("publishes post-restart Skill sync and success from the persisted baseline", async () => {
    vi.useFakeTimers();
    const directory = await mkdtemp(join(tmpdir(), "codrive-upgrade-events-"));
    const serviceStore = new UpgradeStateStore(directory);
    const workerStore = new UpgradeStateStore(directory);
    await serviceStore.write({
      ...upgradeState("restarting"),
      phaseStartedAt: {
        checking: "2026-08-15T10:00:00.000Z",
        installing: "2026-08-15T10:00:00.250Z",
        restarting: "2026-08-15T10:00:00.500Z",
      },
    });
    const monitor = new UpgradeStateChangeMonitor({
      store: serviceStore,
      intervalMs: 25,
    });
    const phases: string[] = [];
    monitor.subscribe((event) => {
      if (event.type === "system.upgrade_state_changed" && event.phase) {
        phases.push(event.phase);
      }
    });
    await monitor.start();

    await workerStore.write({
      ...upgradeState("succeeded"),
      completedAt: "2026-08-15T10:00:02.000Z",
      phaseStartedAt: {
        checking: "2026-08-15T10:00:00.000Z",
        installing: "2026-08-15T10:00:00.250Z",
        restarting: "2026-08-15T10:00:00.500Z",
        syncing_skills: "2026-08-15T10:00:01.000Z",
        succeeded: "2026-08-15T10:00:02.000Z",
      },
    });
    await vi.advanceTimersByTimeAsync(25);

    await vi.waitFor(() => {
      expect(phases).toEqual(["syncing_skills", "succeeded"]);
    });
    monitor.stop();
  });
});

function upgradeState(phase: UpgradeState["phase"]): UpgradeState {
  const updatedAt =
    phase === "checking"
      ? "2026-08-15T10:00:00.000Z"
      : "2026-08-15T10:00:01.000Z";
  return {
    operationId: "upgrade_1",
    targetVersion: "0.7.0",
    phase,
    startedAt: "2026-08-15T10:00:00.000Z",
    updatedAt,
    phaseStartedAt: { [phase]: updatedAt },
  };
}
