import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ConfigStore } from "../../src/infrastructure/config-store.js";
import { InstanceLock } from "../../src/infrastructure/instance-lock.js";

describe("local runtime state", () => {
  it("creates a private config with a persistent local token", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "codrive-config-"));
    const store = new ConfigStore(stateDirectory);

    const created = await store.loadOrCreate();
    const reloaded = await store.read();
    const mode = (await stat(store.configPath)).mode & 0o777;

    expect(created).toMatchObject({
      schemaVersion: 1,
      host: "127.0.0.1",
      port: 0,
      maxConcurrentTasks: 4,
      stateDirectory,
    });
    expect(created.accessToken).toMatch(/^[a-f0-9]{64}$/);
    expect(reloaded.accessToken).toBe(created.accessToken);
    expect(mode).toBe(0o600);
  });

  it("upgrades the early single-task default to four concurrent tasks", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "codrive-config-legacy-"));
    const store = new ConfigStore(stateDirectory);
    await writeFile(
      store.configPath,
      JSON.stringify({
        host: "127.0.0.1",
        port: 43120,
        maxConcurrentTasks: 1,
        accessToken: "a".repeat(64),
        stateDirectory,
      }),
      "utf8",
    );

    const upgraded = await store.loadOrCreate();
    const persisted = JSON.parse(await readFile(store.configPath, "utf8"));

    expect(upgraded).toMatchObject({
      schemaVersion: 1,
      maxConcurrentTasks: 4,
      port: 43120,
    });
    expect(persisted).toEqual(upgraded);
  });

  it("preserves a concurrency value saved by the current config format", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "codrive-config-current-"));
    const store = new ConfigStore(stateDirectory);
    const configured = {
      schemaVersion: 1,
      host: "127.0.0.1",
      port: 43121,
      maxConcurrentTasks: 1,
      accessToken: "b".repeat(64),
      stateDirectory,
    };
    await writeFile(store.configPath, JSON.stringify(configured), "utf8");

    await expect(store.loadOrCreate()).resolves.toEqual(configured);
  });

  it("allows only one Codrive process to own a state directory", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "codrive-lock-"));
    const first = new InstanceLock(stateDirectory);
    const second = new InstanceLock(stateDirectory);

    await first.acquire();
    await expect(second.acquire()).rejects.toThrow(/already running/i);
    await first.release();

    await second.acquire();
    await second.release();
  });
});
