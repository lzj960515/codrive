import { mkdtemp, stat } from "node:fs/promises";
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
      host: "127.0.0.1",
      port: 0,
      maxConcurrentTasks: 4,
      stateDirectory,
    });
    expect(created.accessToken).toMatch(/^[a-f0-9]{64}$/);
    expect(reloaded.accessToken).toBe(created.accessToken);
    expect(mode).toBe(0o600);
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
