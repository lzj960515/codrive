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
      schemaVersion: 2,
      host: "127.0.0.1",
      port: 0,
      maxConcurrentTasks: 4,
      models: {
        primary: "gpt-5.6-sol",
        fallback: "gpt-5.6-terra",
      },
      stateDirectory,
    });
    expect(created.accessToken).toMatch(/^[a-f0-9]{64}$/);
    expect(reloaded.accessToken).toBe(created.accessToken);
    expect(mode).toBe(0o600);
  });

  it("rejects an unsupported config schema", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "codrive-config-unsupported-"));
    const store = new ConfigStore(stateDirectory);
    await writeFile(
      store.configPath,
      JSON.stringify({
        schemaVersion: 1,
        host: "127.0.0.1",
        port: 43120,
        maxConcurrentTasks: 1,
        accessToken: "a".repeat(64),
        stateDirectory,
      }),
      "utf8",
    );

    await expect(store.loadOrCreate()).rejects.toThrow(
      "Unsupported Codrive config version 1",
    );
    expect(JSON.parse(await readFile(store.configPath, "utf8"))).toMatchObject({
      schemaVersion: 1,
      maxConcurrentTasks: 1,
    });
  });

  it("preserves a concurrency value saved by the current config format", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "codrive-config-current-"));
    const store = new ConfigStore(stateDirectory);
    const configured = {
      schemaVersion: 2,
      host: "127.0.0.1",
      port: 43121,
      maxConcurrentTasks: 1,
      models: {
        primary: "gpt-5.6-sol",
        fallback: "gpt-5.6-terra",
      },
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
