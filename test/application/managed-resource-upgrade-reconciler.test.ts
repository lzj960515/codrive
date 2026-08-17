import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { ManagedResourceUpgradeReconciler } from "../../src/application/managed-resource-upgrade-reconciler.js";
import { UpgradeCoordinator } from "../../src/application/upgrade-coordinator.js";
import type { ManagedResourceInstallationStatus } from "../../src/infrastructure/managed-resource-installer.js";
import { UpgradeStateStore } from "../../src/infrastructure/upgrade-state-store.js";

describe("ManagedResourceUpgradeReconciler", () => {
  it("finishes a legacy worker success with the new package resource contract", async () => {
    const { coordinator, store } = await legacySucceededUpgrade();
    let status = resourceStatus("missing");
    const install = vi.fn(async () => {
      status = resourceStatus("current");
      return { skillPaths: [], hookPath: "/hooks/codrive.mjs" };
    });
    const reconciler = new ManagedResourceUpgradeReconciler({
      upgrades: coordinator,
      resources: {
        getStatus: async () => status,
        install,
      },
      currentVersion: "0.7.0",
    });

    await reconciler.reconcile();

    expect(install).toHaveBeenCalledOnce();
    expect(await store.read()).toMatchObject({
      phase: "succeeded",
      resourceSync: {
        packageVersion: "0.7.0",
        completedAt: "2026-08-17T01:00:00.000Z",
      },
    });
  });

  it("does not silently reinstall a resource removed after this package was confirmed", async () => {
    const { coordinator, store } = await legacySucceededUpgrade({
      resourceSync: {
        packageVersion: "0.7.0",
        completedAt: "2026-08-17T00:30:00.000Z",
      },
    });
    const install = vi.fn(async () => ({
      skillPaths: [],
      hookPath: "/hooks/codrive.mjs",
    }));
    const reconciler = new ManagedResourceUpgradeReconciler({
      upgrades: coordinator,
      resources: {
        getStatus: async () => resourceStatus("missing"),
        install,
      },
      currentVersion: "0.7.0",
    });

    await reconciler.reconcile();

    expect(install).not.toHaveBeenCalled();
    expect((await store.read())?.phase).toBe("succeeded");
  });

  it("turns an unfulfilled legacy success into an actionable Hook conflict", async () => {
    const { coordinator, store } = await legacySucceededUpgrade();
    const conflict = resourceStatus("conflict");
    const reconciler = new ManagedResourceUpgradeReconciler({
      upgrades: coordinator,
      resources: {
        getStatus: async () => conflict,
        install: async () => {
          throw new Error("Refusing to replace unmanaged Hook");
        },
      },
      currentVersion: "0.7.0",
    });

    await reconciler.reconcile();

    expect(await store.read()).toMatchObject({
      phase: "failed",
      completedAt: "2026-08-17T01:00:00.000Z",
      error: { code: "hook_conflict" },
    });
  });

  it("does not misclassify a resource confirmation write failure", async () => {
    const failResourceSync = vi.fn(async () => null);
    const reconciler = new ManagedResourceUpgradeReconciler({
      upgrades: {
        read: async () => ({
          operationId: "upgrade_current_worker",
          targetVersion: "0.7.0",
          phase: "succeeded" as const,
          startedAt: "2026-08-17T00:00:00.000Z",
          updatedAt: "2026-08-17T00:01:00.000Z",
        }),
        confirmResourceSync: async () => {
          throw new Error("state write failed");
        },
        failResourceSync,
      },
      resources: {
        getStatus: async () => resourceStatus("current"),
        install: async () => ({
          skillPaths: [],
          hookPath: "/hooks/codrive.mjs",
        }),
      },
      currentVersion: "0.7.0",
    });

    await expect(reconciler.reconcile()).rejects.toThrow("state write failed");
    expect(failResourceSync).not.toHaveBeenCalled();
  });
});

async function legacySucceededUpgrade(
  extra: Record<string, unknown> = {},
): Promise<{ coordinator: UpgradeCoordinator; store: UpgradeStateStore }> {
  const directory = await mkdtemp(join(tmpdir(), "codrive-resource-upgrade-"));
  const store = new UpgradeStateStore(directory);
  await store.write({
    operationId: "upgrade_legacy_worker",
    targetVersion: "0.7.0",
    phase: "succeeded",
    startedAt: "2026-08-17T00:00:00.000Z",
    updatedAt: "2026-08-17T00:01:00.000Z",
    completedAt: "2026-08-17T00:01:00.000Z",
    ...extra,
  });
  return {
    store,
    coordinator: new UpgradeCoordinator({
      store,
      versions: { read: async () => { throw new Error("unused"); } },
      launcher: { launch: async () => 1 },
      now: () => new Date("2026-08-17T01:00:00.000Z"),
    }),
  };
}

function resourceStatus(
  state: "missing" | "current" | "conflict",
): ManagedResourceInstallationStatus {
  const hookState = state === "conflict" ? "conflict" : state;
  return {
    state,
    bundledVersion: "0.7.0",
    managedSkillCount: 4,
    managedHookCount: 1,
    conflictPaths: state === "conflict" ? ["/home/user/.codex/hooks.json"] : [],
    skills: {
      state: "current",
      bundledVersion: "0.7.0",
      installedVersion: "0.7.0",
      managedSkillCount: 4,
      conflictPaths: [],
    },
    hook: {
      state: hookState,
      bundledVersion: "0.7.0",
      installedVersion: state === "missing" ? null : "0.7.0",
      managedHookCount: 1,
      conflictPaths: state === "conflict" ? ["/home/user/.codex/hooks.json"] : [],
    },
  };
}
