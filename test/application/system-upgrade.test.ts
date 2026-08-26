import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  utimes,
  writeFile,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { UpgradeCoordinator } from "../../src/application/upgrade-coordinator.js";
import { SystemUpgradeRunner } from "../../src/application/system-upgrade-runner.js";
import { NpmPackageUpgrader } from "../../src/infrastructure/npm-package-upgrader.js";
import { UpgradeStateStore } from "../../src/infrastructure/upgrade-state-store.js";

const executeFile = promisify(execFile);

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

  it("starts one operation across independent coordinators sharing a state directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codrive-upgrade-"));
    const launches: string[] = [];
    let versionReaders = 0;
    let releaseVersionReaders!: () => void;
    const versionReadersReleased = new Promise<void>((resolve) => {
      releaseVersionReaders = resolve;
    });
    const readVersions = async () => {
      versionReaders += 1;
      if (versionReaders === 1) {
        setTimeout(releaseVersionReaders, 25);
      } else {
        releaseVersionReaders();
      }
      await versionReadersReleased;
      return {
        currentVersion: "0.6.0",
        latestVersion: "0.7.0",
        updateAvailable: true,
        lastCheckedAt: "2026-08-13T05:00:00.000Z",
        lastSuccessfulCheckAt: "2026-08-13T05:00:00.000Z",
        checkError: null,
        checking: false,
      };
    };
    const createCoordinator = (operationId: string) =>
      new UpgradeCoordinator({
        store: new UpgradeStateStore(directory),
        versions: { read: readVersions },
        launcher: {
          launch: async (request) => {
            launches.push(request.operationId);
            return 8123;
          },
        },
        createOperationId: () => operationId,
        isProcessRunning: () => true,
      });
    const first = createCoordinator("upgrade_first");
    const second = createCoordinator("upgrade_second");

    const operations = await Promise.all([
      first.start("0.7.0"),
      second.start("0.7.0"),
    ]);

    expect(launches).toHaveLength(1);
    expect(launches[0]).toMatch(/^upgrade_(first|second)$/);
    expect(operations[0].operationId).toBe(operations[1].operationId);
    expect(await new UpgradeStateStore(directory).read()).toMatchObject({
      operationId: operations[0].operationId,
      workerPid: 8123,
    });
  });

  it("starts one operation when independent Node processes race", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codrive-upgrade-processes-"));
    const scriptPath = join(directory, "start-upgrade.mjs");
    const launchLog = join(directory, "launches.log");
    const coordinatorUrl = new URL(
      "../../src/application/upgrade-coordinator.ts",
      import.meta.url,
    ).href;
    const storeUrl = new URL(
      "../../src/infrastructure/upgrade-state-store.ts",
      import.meta.url,
    ).href;
    await writeFile(
      scriptPath,
      `import { appendFile } from "node:fs/promises";\n` +
        `import { setTimeout as sleep } from "node:timers/promises";\n` +
        `import { UpgradeCoordinator } from ${JSON.stringify(coordinatorUrl)};\n` +
        `import { UpgradeStateStore } from ${JSON.stringify(storeUrl)};\n` +
        `const [directory, operationId, launchLog] = process.argv.slice(2);\n` +
        `const coordinator = new UpgradeCoordinator({\n` +
        `  store: new UpgradeStateStore(directory),\n` +
        `  versions: { read: async () => ({ currentVersion: "0.6.0", latestVersion: "0.7.0", updateAvailable: true, lastCheckedAt: null, lastSuccessfulCheckAt: null, checkError: null, checking: false }) },\n` +
        `  launcher: { launch: async request => { await appendFile(launchLog, request.operationId + "\\n"); await sleep(100); return process.pid; } },\n` +
        `  createOperationId: () => operationId,\n` +
        `  isProcessRunning: () => true,\n` +
        `});\n` +
        `const operation = await coordinator.start("0.7.0");\n` +
        `process.stdout.write(operation.operationId + "\\n");\n`,
      "utf8",
    );

    const run = (operationId: string) =>
      executeFile(
        process.execPath,
        ["--import", "tsx/esm", scriptPath, directory, operationId, launchLog],
        { cwd: process.cwd(), encoding: "utf8" },
      );
    const [first, second] = await Promise.all([
      run("upgrade_process_first"),
      run("upgrade_process_second"),
    ]);
    const operationIds = [first.stdout.trim(), second.stdout.trim()];
    const launched = readFile(launchLog, "utf8");

    expect(new Set(operationIds).size).toBe(1);
    await expect(launched).resolves.toMatch(/^upgrade_process_(first|second)\n$/);
    expect(await new UpgradeStateStore(directory).read()).toMatchObject({
      operationId: operationIds[0],
      workerPid: expect.any(Number),
    });
  });

  it("recovers an abandoned start lock and releases ownership after failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codrive-upgrade-lock-"));
    const lockPath = join(directory, "system-upgrade-start.lock");
    const store = new UpgradeStateStore(directory);
    await mkdir(lockPath);
    const staleAt = new Date(Date.now() - 60_000);
    await utimes(lockPath, staleAt, staleAt);

    await expect(
      store.withStartLock(async () => {
        throw new Error("simulated start failure");
      }),
    ).rejects.toThrow("simulated start failure");
    await expect(store.withStartLock(async () => "recovered")).resolves.toBe(
      "recovered",
    );
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

  it("finishes a failed current-version operation after managed resources are repaired", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codrive-upgrade-"));
    const store = new UpgradeStateStore(directory);
    await store.write({
      operationId: "upgrade_skills",
      targetVersion: "0.7.0",
      phase: "failed",
      startedAt: "2026-08-13T05:00:00.000Z",
      updatedAt: "2026-08-13T05:01:00.000Z",
      error: { code: "resource_sync_failed", summary: "retry" },
    });
    const coordinator = new UpgradeCoordinator({
      store,
      versions: { read: async () => { throw new Error("unused"); } },
      launcher: { launch: async () => 99123 },
    });

    await expect(
      coordinator.completeAfterResourceRepair("0.7.0"),
    ).resolves.toMatchObject({
      phase: "succeeded",
      completedAt: expect.any(String),
    });
    expect(await store.read()).not.toHaveProperty("error");
  });
});

describe("SystemUpgradeRunner", () => {
  it("reports success only after exact install, restart, resource sync, and version health", async () => {
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
        install: async (target) => {
          calls.push(`install:${target}`);
          return { cliPath: "/global/codrive/dist/interfaces/cli/index.js" };
        },
        restart: async (_cliPath, stateDirectory) => {
          calls.push(`restart:${stateDirectory}`);
        },
      },
      installResources: async (packageRoot, target) => {
        calls.push(`resources:${packageRoot}:${target}`);
        return currentResources();
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
      "resources:/global/codrive:0.7.0",
      "health:0.7.0",
    ]);
    expect((await store.read())?.phase).toBe("succeeded");
    expect(phases).toEqual([
      "installing",
      "restarting",
      "syncing_resources",
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
        install: async () => {
          throw new Error("EACCES /Users/person/.npmrc SUPER_SECRET");
        },
        restart: async () => undefined,
      },
      installResources: async () => currentResources(),
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

  it("reports a managed Hook conflict separately from Skill conflicts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codrive-upgrade-"));
    const store = await createUpgradeStore(directory, "upgrade_hook_conflict");
    const runner = new SystemUpgradeRunner({
      store,
      packageUpgrader: {
        install: async () => ({
          cliPath: "/global/codrive/dist/interfaces/cli/index.js",
        }),
        restart: async () => undefined,
      },
      installResources: async () => ({
        state: "conflict",
        skills: { state: "current" },
        hook: { state: "conflict" },
      }),
      verifyHealth: async () => undefined,
    });

    await expect(
      runner.run(upgradeRequest(directory, "upgrade_hook_conflict")),
    ).rejects.toThrow(/Hook/);
    expect(await store.read()).toMatchObject({
      phase: "failed",
      error: { code: "hook_conflict" },
    });
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
        install: async () => {
          throw new Error("No matching version found for codrive@0.7.0");
        },
        restart: async () => undefined,
      },
      installResources: async () => currentResources(),
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
          install: async () => ({ cliPath: "/global/codrive/dist/interfaces/cli/index.js" }),
          restart: async () => undefined,
        },
        installResources: async () => currentResources(),
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

  it("classifies real package permission output without persisting command details", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codrive-upgrade-command-"));
    const executable = await createExecutable(
      directory,
      "npm-failure",
      'process.stderr.write("npm ERR! code EACCES SECRET_TOKEN\\n"); process.exit(1);',
    );
    const store = await createUpgradeStore(directory, "upgrade_permission");
    const runner = createCommandRunner(
      store,
      new NpmPackageUpgrader(undefined, { npmExecutable: executable }),
    );

    await expect(
      runner.run(upgradeRequest(directory, "upgrade_permission")),
    ).rejects.toThrow(/permissions/i);
    const state = await store.read();
    expect(state?.error?.code).toBe("permission_denied");
    expect(JSON.stringify(state)).not.toContain("SECRET_TOKEN");
  });

  it("uses a restart-specific recovery message for real permission failures", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codrive-upgrade-command-"));
    const npmExecutable = await createExecutable(
      directory,
      "npm-success",
      'if (process.argv.includes("root")) process.stdout.write("/global/node_modules\\n");',
    );
    const nodeExecutable = await createExecutable(
      directory,
      "restart-denied",
      'process.stderr.write("EPERM service manager\\n"); process.exit(1);',
    );
    const store = await createUpgradeStore(directory, "upgrade_restart_denied");
    const runner = createCommandRunner(
      store,
      new NpmPackageUpgrader(undefined, { npmExecutable, nodeExecutable }),
    );

    await expect(
      runner.run(upgradeRequest(directory, "upgrade_restart_denied")),
    ).rejects.toThrow(/service could not restart with the current permissions/i);
    expect(await store.read()).toMatchObject({
      error: {
        code: "permission_denied",
        summary: expect.stringMatching(/local service access/i),
      },
    });
  });

  it("classifies a real upgraded CLI failure as a service restart failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codrive-upgrade-command-"));
    const npmExecutable = await createExecutable(
      directory,
      "npm-success",
      'if (process.argv.includes("root")) process.stdout.write("/global/node_modules\\n");',
    );
    const nodeExecutable = await createExecutable(
      directory,
      "restart-failure",
      'process.stderr.write("restart supervisor rejected request\\n"); process.exit(1);',
    );
    const store = await createUpgradeStore(directory, "upgrade_restart");
    const runner = createCommandRunner(
      store,
      new NpmPackageUpgrader(undefined, { npmExecutable, nodeExecutable }),
    );

    await expect(
      runner.run(upgradeRequest(directory, "upgrade_restart")),
    ).rejects.toThrow(/restart/i);
    expect((await store.read())?.error?.code).toBe("service_restart_failed");
  });
});

async function createExecutable(
  directory: string,
  name: string,
  source: string,
): Promise<string> {
  const path = join(directory, name);
  await writeFile(path, `#!/usr/bin/env node\n${source}\n`, "utf8");
  await chmod(path, 0o700);
  return path;
}

async function createUpgradeStore(
  directory: string,
  operationId: string,
): Promise<UpgradeStateStore> {
  const store = new UpgradeStateStore(directory);
  await store.write({
    operationId,
    targetVersion: "0.7.0",
    phase: "checking",
    startedAt: "2026-08-13T05:00:00.000Z",
    updatedAt: "2026-08-13T05:00:00.000Z",
  });
  return store;
}

function createCommandRunner(
  store: UpgradeStateStore,
  packageUpgrader: NpmPackageUpgrader,
): SystemUpgradeRunner {
  return new SystemUpgradeRunner({
    store,
    packageUpgrader,
    installResources: async () => currentResources(),
    verifyHealth: async () => undefined,
  });
}

function upgradeRequest(directory: string, operationId: string) {
  return {
    operationId,
    targetVersion: "0.7.0",
    stateDirectory: directory,
  };
}

function currentResources() {
  return {
    state: "current" as const,
    skills: { state: "current" as const },
    hook: { state: "current" as const },
  };
}
