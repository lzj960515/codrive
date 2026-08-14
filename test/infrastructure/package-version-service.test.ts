import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { PackageVersionService } from "../../src/infrastructure/package-version-service.js";

describe("PackageVersionService", () => {
  it("caches a successful npm latest result without blocking later reads", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codrive-version-"));
    let calls = 0;
    const service = new PackageVersionService({
      currentVersion: "0.6.0",
      stateDirectory: directory,
      resolveLatestVersion: async () => {
        calls += 1;
        return "0.7.0";
      },
      now: () => new Date("2026-08-13T05:00:00.000Z"),
    });

    expect(await service.read()).toMatchObject({
      currentVersion: "0.6.0",
      latestVersion: null,
      updateAvailable: false,
    });
    expect(await service.refresh({ force: true })).toMatchObject({
      latestVersion: "0.7.0",
      updateAvailable: true,
      lastCheckedAt: "2026-08-13T05:00:00.000Z",
      checkError: null,
    });

    const restored = new PackageVersionService({
      currentVersion: "0.6.0",
      stateDirectory: directory,
      resolveLatestVersion: async () => {
        calls += 1;
        return "9.0.0";
      },
      now: () => new Date("2026-08-13T05:10:00.000Z"),
    });
    expect(await restored.refresh()).toMatchObject({
      latestVersion: "0.7.0",
      checking: false,
    });
    expect(calls).toBe(1);
  });

  it("preserves the last successful version when npm is unavailable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codrive-version-"));
    const available = new PackageVersionService({
      currentVersion: "0.6.0",
      stateDirectory: directory,
      resolveLatestVersion: async () => "0.7.0",
    });
    await available.refresh({ force: true });

    const offline = new PackageVersionService({
      currentVersion: "0.6.0",
      stateDirectory: directory,
      resolveLatestVersion: async () => {
        throw new Error("network timeout PRIVATE_REGISTRY_TOKEN");
      },
    });
    const status = await offline.refresh({ force: true });

    expect(status.latestVersion).toBe("0.7.0");
    expect(status.updateAvailable).toBe(true);
    expect(status.checkError).toMatchObject({ code: "npm_unavailable" });
    expect(status.checkError?.summary).not.toContain("PRIVATE_REGISTRY_TOKEN");

    const restored = new PackageVersionService({
      currentVersion: "0.6.0",
      stateDirectory: directory,
      resolveLatestVersion: async () => "9.0.0",
    });
    expect(await restored.read()).toMatchObject({
      latestVersion: "0.7.0",
      checkError: { code: "npm_unavailable" },
    });
  });

  it("rejects an invalid npm latest response without replacing its cache", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codrive-version-"));
    const service = new PackageVersionService({
      currentVersion: "0.6.0",
      stateDirectory: directory,
      resolveLatestVersion: async () => "not-a-version",
    });

    await expect(service.refresh({ force: true })).resolves.toMatchObject({
      latestVersion: null,
      updateAvailable: false,
      checkError: { code: "invalid_registry_response" },
    });
    await expect(service.read()).resolves.toMatchObject({
      lastCheckedAt: expect.any(String),
      checkError: { code: "invalid_registry_response" },
    });
  });

  it("deduplicates concurrent forced refreshes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codrive-version-"));
    let resolveLatest!: (version: string) => void;
    let notifyLatestStarted!: () => void;
    const latestStarted = new Promise<void>((resolve) => {
      notifyLatestStarted = resolve;
    });
    let now = new Date("2026-08-14T00:00:00.000Z");
    let calls = 0;
    const service = new PackageVersionService({
      currentVersion: "0.6.0",
      stateDirectory: directory,
      resolveLatestVersion: () => {
        calls += 1;
        notifyLatestStarted();
        return new Promise((resolve) => {
          resolveLatest = resolve;
        });
      },
      now: () => now,
    });

    const first = service.refresh({ force: true });
    const second = service.refresh({ force: true });
    await latestStarted;
    await expect(service.read()).resolves.toMatchObject({ checking: true });
    now = new Date("2026-08-14T00:05:00.000Z");
    resolveLatest("0.7.0");

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({
        latestVersion: "0.7.0",
        lastCheckedAt: "2026-08-14T00:05:00.000Z",
      }),
      expect.objectContaining({
        latestVersion: "0.7.0",
        lastCheckedAt: "2026-08-14T00:05:00.000Z",
      }),
    ]);
    expect(calls).toBe(1);
    await expect(service.read()).resolves.toMatchObject({ checking: false });
  });
});
