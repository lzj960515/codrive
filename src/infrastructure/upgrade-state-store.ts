import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as lockfile from "proper-lockfile";

import type {
  SystemStatusChangedEvent,
  SystemStatusEventSource,
  UpgradeState,
} from "../domain/system-update.js";

export class UpgradeStateStore implements SystemStatusEventSource {
  readonly path: string;
  private readonly startLockPath: string;
  private writeQueue = Promise.resolve();
  private testSubscriber?: (state: UpgradeState) => void;
  private readonly listeners = new Set<
    (event: SystemStatusChangedEvent) => void
  >();

  constructor(stateDirectory: string) {
    this.path = join(stateDirectory, "system-upgrade.json");
    this.startLockPath = join(stateDirectory, "system-upgrade-start.lock");
  }

  async read(): Promise<UpgradeState | null> {
    try {
      return JSON.parse(await readFile(this.path, "utf8")) as UpgradeState;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async write(state: UpgradeState): Promise<void> {
    const write = async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const temporaryPath = `${this.path}.${randomUUID()}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporaryPath, this.path);
      this.testSubscriber?.(state);
      for (const listener of this.listeners) {
        listener({ type: "system.upgrade_status_changed" });
      }
    };
    const pending = this.writeQueue.then(write, write);
    this.writeQueue = pending.then(
      () => undefined,
      () => undefined,
    );
    await pending;
  }

  async withStartLock<T>(action: () => Promise<T>): Promise<T> {
    await mkdir(dirname(this.startLockPath), { recursive: true });
    const release = await lockfile.lock(this.path, {
      lockfilePath: this.startLockPath,
      realpath: false,
      stale: 10_000,
      update: 2_000,
      retries: {
        retries: 1_500,
        factor: 1,
        minTimeout: 20,
        maxTimeout: 20,
        randomize: true,
      },
    });
    try {
      return await action();
    } finally {
      await release();
    }
  }

  subscribeForTest(subscriber: (state: UpgradeState) => void): void {
    this.testSubscriber = subscriber;
  }

  subscribe(listener: (event: SystemStatusChangedEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
