import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ConfigStore } from "../../src/infrastructure/config-store.js";
import { LocalServiceManager } from "../../src/infrastructure/local-service-manager.js";

describe("LocalServiceManager", () => {
  it("allows persisted task recovery to run longer than the old ten-second limit", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "codrive-service-"));
    await new ConfigStore(stateDirectory).loadOrCreate();
    let clock = 0;
    let running = false;
    const service = new LocalServiceManager({
      stateDirectory,
      entryPath: "/package/codrive.js",
      healthCheck: async () => running && clock >= 15_000,
      readOwnerPid: async () => (running ? 7200 : null),
      isProcessRunning: () => running,
      spawnService: () => {
        running = true;
        return { exitCode: null };
      },
      now: () => clock,
      sleep: async (milliseconds) => {
        clock += milliseconds;
      },
    });

    await expect(service.start()).resolves.toMatchObject({
      outcome: "started",
      pid: 7200,
    });
    expect(clock).toBeGreaterThanOrEqual(15_000);
  });

  it("starts idempotently and restarts the detached Codrive service", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "codrive-service-"));
    const configStore = new ConfigStore(stateDirectory);
    await configStore.loadOrCreate();
    let clock = 0;
    let healthy = false;
    let running = false;
    let pid: number | null = null;
    let starts = 0;
    const service = new LocalServiceManager({
      stateDirectory,
      entryPath: "/package/codrive.js",
      healthCheck: async () => healthy,
      readOwnerPid: async () => pid,
      isProcessRunning: (candidate) => running && candidate === pid,
      spawnService: () => {
        starts += 1;
        pid = 7000 + starts;
        running = true;
        healthy = true;
        return { exitCode: null };
      },
      stopProcess: (candidate) => {
        expect(candidate).toBe(pid);
        running = false;
        healthy = false;
      },
      now: () => clock,
      sleep: async (milliseconds) => {
        clock += milliseconds;
      },
    });

    await expect(service.start()).resolves.toMatchObject({
      outcome: "started",
      url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:/),
    });
    await expect(service.start()).resolves.toMatchObject({
      outcome: "already_running",
    });
    await expect(service.restart()).resolves.toMatchObject({
      outcome: "started",
      pid: 7002,
    });
    expect(starts).toBe(2);
  });

  it("reports an external supervisor that restarts the process during stop", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "codrive-service-"));
    await new ConfigStore(stateDirectory).loadOrCreate();
    let clock = 0;
    const service = new LocalServiceManager({
      stateDirectory,
      entryPath: "/package/codrive.js",
      healthCheck: async () => true,
      readOwnerPid: async () => 7100,
      isProcessRunning: () => true,
      spawnService: () => ({ exitCode: null }),
      stopProcess: () => undefined,
      timeoutMs: 10,
      pollIntervalMs: 5,
      now: () => clock,
      sleep: async (milliseconds) => {
        clock += milliseconds;
      },
    });

    await expect(service.stop()).rejects.toThrow(/external service manager/i);
  });
});
