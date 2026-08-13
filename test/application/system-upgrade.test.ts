import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { UpgradeCoordinator } from "../../src/application/upgrade-coordinator.js";
import { SystemUpgradeRunner } from "../../src/application/system-upgrade-runner.js";
import { UpgradeStateStore } from "../../src/infrastructure/upgrade-state-store.js";

describe("UpgradeCoordinator", () => {
  it("fixes one target version and returns the same active operation for concurrent clicks", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codrive-upgrade-"));
    const store = new UpgradeStateStore(directory);
    const launches: unknown[] = [];
    const coordinator = new UpgradeCoordinator({
      store,
      versions: {
        read: async () => ({
          currentVersion: "0.6.0",
          latestVersion: "0.7.0",
          updateAvailable: true,
          lastCheckedAt: "2026-08-13T05:00:00.000Z",
          lastSuccessfulCheckAt: "2026-08-13T05:00:00.000Z",
          checkError: null,
          checking: false,
        }),
      },
      launcher: {
        launch: async (request) => {
          launches.push(request);
          return 8123;
        },
      },
      now: () => new Date("2026-08-13T05:01:00.000Z"),
      createOperationId: () => "upgrade_1",
      isProcessRunning: () => true,
    });

    const [first, second] = await Promise.all([
      coordinator.start("0.7.0"),
      coordinator.start("0.7.0"),
    ]);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      operationId: "upgrade_1",
      targetVersion: "0.7.0",
      phase: "checking",
    });
    expect(launches).toHaveLength(1);
  });

  it("recovers an active operation whose detached worker has exited", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codrive-upgrade-"));
    const store = new UpgradeStateStore(directory);
    await store.write({
      operationId: "upgrade_dead",
      targetVersion: "0.7.0",
      phase: "restarting",
      startedAt: "2026-08-13T05:00:00.000Z",
      updatedAt: "2026-08-13T05:01:00.000Z",
      workerPid: 99123,
    });
    const coordinator = new UpgradeCoordinator({
      store,
      versions: { read: async () => { throw new Error("unused"); } },
      launcher: { launch: async () => 99123 },
      isProcessRunning: () => false,
    });

    await expect(coordinator.reconcile()).resolves.toMatchObject({
      phase: "failed",
      error: { code: "package_install_failed" },
    });
  });

  it("keeps a newly accepted operation alive while its worker PID is being recorded", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codrive-upgrade-"));
    const store = new UpgradeStateStore(directory);
    await store.write({
      operationId: "upgrade_starting",
      targetVersion: "0.7.0",
      phase: "checking",
      startedAt: "2026-08-13T05:00:00.000Z",
      updatedAt: "2026-08-13T05:00:00.000Z",
    });
    const coordinator = new UpgradeCoordinator({
      store,
      versions: { read: async () => { throw new Error("unused"); } },
      launcher: { launch: async () => 99123 },
      now: () => new Date("2026-08-13T05:00:05.000Z"),
      isProcessRunning: () => false,
    });

    const current = await coordinator.reconcile();
    expect(current?.phase).toBe("checking");
    expect(current).not.toHaveProperty("error");
  });

  it("finishes an interrupted current-version operation after managed Skills are repaired", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codrive-upgrade-"));
    const store = new UpgradeStateStore(directory);
    await store.write({
      operationId: "upgrade_skills",
      targetVersion: "0.7.0",
      phase: "failed",
      startedAt: "2026-08-13T05:00:00.000Z",
      updatedAt: "2026-08-13T05:01:00.000Z",
      error: { code: "skill_sync_failed", summary: "retry" },
    });
    const coordinator = new UpgradeCoordinator({
      store,
      versions: { read: async () => { throw new Error("unused"); } },
      launcher: { launch: async () => 99123 },
    });

    await expect(
      coordinator.completeAfterSkillRepair("0.7.0"),
    ).resolves.toMatchObject({
      phase: "succeeded",
      completedAt: expect.any(String),
    });
    expect(await store.read()).not.toHaveProperty("error");
  });
});

describe("SystemUpgradeRunner", () => {
  it("reports success only after exact install, restart, Skill sync, and version health", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codrive-upgrade-"));
    const store = new UpgradeStateStore(directory);
    const phases: string[] = [];
    const calls: string[] = [];
    await store.write({
      operationId: "upgrade_1",
      targetVersion: "0.7.0",
      phase: "checking",
      startedAt: "2026-08-13T05:00:00.000Z",
      updatedAt: "2026-08-13T05:00:00.000Z",
    });
    store.subscribeForTest?.((state) => phases.push(state.phase));
    const runner = new SystemUpgradeRunner({
      store,
      packageUpgrader: {
        install: (target) => {
          calls.push(`install:${target}`);
          return { cliPath: "/global/codrive/dist/interfaces/cli/index.js" };
        },
        restart: (_cliPath, stateDirectory) => {
          calls.push(`restart:${stateDirectory}`);
        },
      },
      installSkills: async (packageRoot, target) => {
        calls.push(`skills:${packageRoot}:${target}`);
        return { state: "current" };
      },
      verifyHealth: async (target) => {
        calls.push(`health:${target}`);
      },
      now: () => new Date("2026-08-13T05:02:00.000Z"),
    });

    await runner.run({
      operationId: "upgrade_1",
      targetVersion: "0.7.0",
      stateDirectory: directory,
    });

    expect(calls).toEqual([
      "install:0.7.0",
      `restart:${directory}`,
      "skills:/global/codrive:0.7.0",
      "health:0.7.0",
    ]);
    expect((await store.read())?.phase).toBe("succeeded");
    expect(phases).toEqual([
      "installing",
      "restarting",
      "syncing_skills",
      "succeeded",
    ]);
  });

  it("persists a safe actionable failure instead of reporting partial success", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codrive-upgrade-"));
    const store = new UpgradeStateStore(directory);
    await store.write({
      operationId: "upgrade_2",
      targetVersion: "0.7.0",
      phase: "checking",
      startedAt: "2026-08-13T05:00:00.000Z",
      updatedAt: "2026-08-13T05:00:00.000Z",
    });
    const runner = new SystemUpgradeRunner({
      store,
      packageUpgrader: {
        install: () => {
          throw new Error("EACCES /Users/person/.npmrc SUPER_SECRET");
        },
        restart: () => undefined,
      },
      installSkills: async () => ({ state: "current" }),
      verifyHealth: async () => undefined,
    });

    await expect(
      runner.run({
        operationId: "upgrade_2",
        targetVersion: "0.7.0",
        stateDirectory: directory,
      }),
    ).rejects.toThrow(/permission/i);
    expect(await store.read()).toMatchObject({
      phase: "failed",
      error: { code: "permission_denied" },
    });
    expect((await store.read())?.error?.summary).not.toContain("SUPER_SECRET");
  });

  it("keeps install errors containing a version number in the install failure category", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codrive-upgrade-"));
    const store = new UpgradeStateStore(directory);
    await store.write({
      operationId: "upgrade_missing_version",
      targetVersion: "0.7.0",
      phase: "checking",
      startedAt: "2026-08-13T05:00:00.000Z",
      updatedAt: "2026-08-13T05:00:00.000Z",
    });
    const runner = new SystemUpgradeRunner({
      store,
      packageUpgrader: {
        install: () => {
          throw new Error("No matching version found for codrive@0.7.0");
        },
        restart: () => undefined,
      },
      installSkills: async () => ({ state: "current" }),
      verifyHealth: async () => undefined,
    });

    await expect(
      runner.run({
        operationId: "upgrade_missing_version",
        targetVersion: "0.7.0",
        stateDirectory: directory,
      }),
    ).rejects.toThrow();
    expect((await store.read())?.error?.code).toBe("package_install_failed");
  });

  it("distinguishes a healthy wrong-version restart from a startup timeout", async () => {
    for (const [message, code] of [
      ["Codrive restarted with version 0.6.0, expected 0.7.0", "wrong_version"],
      ["Timed out waiting for Codrive 0.7.0 to become healthy", "service_start_timeout"],
    ] as const) {
      const directory = await mkdtemp(join(tmpdir(), "codrive-upgrade-"));
      const store = new UpgradeStateStore(directory);
      await store.write({
        operationId: `upgrade_${code}`,
        targetVersion: "0.7.0",
        phase: "checking",
        startedAt: "2026-08-13T05:00:00.000Z",
        updatedAt: "2026-08-13T05:00:00.000Z",
      });
      const runner = new SystemUpgradeRunner({
        store,
        packageUpgrader: {
          install: () => ({ cliPath: "/global/codrive/dist/interfaces/cli/index.js" }),
          restart: () => undefined,
        },
        installSkills: async () => ({ state: "current" }),
        verifyHealth: async () => {
          throw new Error(message);
        },
      });

      await expect(
        runner.run({
          operationId: `upgrade_${code}`,
          targetVersion: "0.7.0",
          stateDirectory: directory,
        }),
      ).rejects.toThrow();
      expect((await store.read())?.error?.code).toBe(code);
    }
  });
});
