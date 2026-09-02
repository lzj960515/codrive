import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CodriveServer } from "../src/codrive-server.js";
import { PackageVersionCheckScheduler } from "../src/application/package-version-check-scheduler.js";
import { RecoveryManager } from "../src/application/recovery-manager.js";
import { SemanticAtlasMaintenanceCoordinator } from "../src/application/semantic-atlas-maintenance-coordinator.js";
import { CodexAppServerClient } from "../src/infrastructure/codex-app-server-client.js";
import { ManagedResourceInstaller } from "../src/infrastructure/managed-resource-installer.js";

describe("CodriveServer startup readiness", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fails before App Server and recovery when managed resources are outdated", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "codrive-startup-"));
    await writeFile(
      join(stateDirectory, "state-schema.json"),
      '{"schemaVersion":4,"createdAt":"2026-08-28T00:00:00.000Z"}\n',
      "utf8",
    );
    vi.spyOn(ManagedResourceInstaller.prototype, "getStatus").mockResolvedValue({
      state: "outdated",
      bundledVersion: "0.9.3",
      managedSkillCount: 4,
      managedHookCount: 1,
      conflictPaths: [],
      skills: {
        state: "outdated",
        bundledVersion: "0.9.3",
        installedVersion: "0.9.2",
        managedSkillCount: 4,
        conflictPaths: [],
      },
      hook: {
        state: "outdated",
        bundledVersion: "0.9.3",
        installedVersion: "0.9.2",
        managedHookCount: 1,
        conflictPaths: [],
      },
    });
    const appServerStart = vi
      .spyOn(CodexAppServerClient.prototype, "start")
      .mockRejectedValue(new Error("App Server must not start"));
    vi.spyOn(CodexAppServerClient.prototype, "stop").mockResolvedValue();
    const recoveryStart = vi.spyOn(RecoveryManager.prototype, "start");

    await expect(new CodriveServer(stateDirectory).start()).rejects.toThrow(
      /managed resources.*outdated/i,
    );

    expect(appServerStart).not.toHaveBeenCalled();
    expect(recoveryStart).not.toHaveBeenCalled();
  });

  it("fails before resources and App Server when state still needs migration", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "codrive-startup-"));
    const markerPath = join(stateDirectory, "state-schema.json");
    const marker =
      '{"schemaVersion":3,"createdAt":"2026-08-28T00:00:00.000Z"}\n';
    await writeFile(markerPath, marker, "utf8");
    const resourceStatus = vi.spyOn(
      ManagedResourceInstaller.prototype,
      "getStatus",
    );
    const appServerStart = vi
      .spyOn(CodexAppServerClient.prototype, "start")
      .mockRejectedValue(new Error("App Server must not start"));
    vi.spyOn(CodexAppServerClient.prototype, "stop").mockResolvedValue();
    const recoveryStart = vi.spyOn(RecoveryManager.prototype, "start");

    await expect(new CodriveServer(stateDirectory).start()).rejects.toThrow(
      /offline migration/i,
    );

    expect(resourceStatus).not.toHaveBeenCalled();
    expect(appServerStart).not.toHaveBeenCalled();
    expect(recoveryStart).not.toHaveBeenCalled();
    await expect(readFile(markerPath, "utf8")).resolves.toBe(marker);
  });

  it("captures code-review availability once during server startup", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "codrive-startup-"));
    vi.spyOn(ManagedResourceInstaller.prototype, "getStatus").mockResolvedValue({
      state: "current",
      bundledVersion: "0.11.1",
      managedSkillCount: 4,
      managedHookCount: 1,
      conflictPaths: [],
      skills: {
        state: "current",
        bundledVersion: "0.11.1",
        installedVersion: "0.11.1",
        managedSkillCount: 4,
        conflictPaths: [],
      },
      hook: {
        state: "current",
        bundledVersion: "0.11.1",
        installedVersion: "0.11.1",
        managedHookCount: 1,
        conflictPaths: [],
      },
    });
    vi.spyOn(CodexAppServerClient.prototype, "start").mockResolvedValue();
    const hasSkill = vi
      .spyOn(CodexAppServerClient.prototype, "hasSkill")
      .mockResolvedValue(true);
    vi.spyOn(CodexAppServerClient.prototype, "stop").mockResolvedValue();
    vi.spyOn(RecoveryManager.prototype, "start").mockResolvedValue();
    vi.spyOn(RecoveryManager.prototype, "stop").mockImplementation(() => undefined);
    vi.spyOn(
      SemanticAtlasMaintenanceCoordinator.prototype,
      "start",
    ).mockResolvedValue();
    vi.spyOn(
      SemanticAtlasMaintenanceCoordinator.prototype,
      "stop",
    ).mockResolvedValue();
    vi.spyOn(PackageVersionCheckScheduler.prototype, "start").mockResolvedValue();

    const server = new CodriveServer(stateDirectory);
    try {
      await server.start();
    } finally {
      await server.stop();
    }

    expect(hasSkill).toHaveBeenCalledTimes(1);
    expect(hasSkill).toHaveBeenCalledWith(stateDirectory, "code-review");
  });
});
