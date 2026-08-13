import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { UpgradeState } from "../domain/system-update.js";

export class UpgradeStateStore {
  readonly path: string;
  private writeQueue = Promise.resolve();
  private testSubscriber?: (state: UpgradeState) => void;

  constructor(stateDirectory: string) {
    this.path = join(stateDirectory, "system-upgrade.json");
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
    };
    const pending = this.writeQueue.then(write, write);
    this.writeQueue = pending.then(
      () => undefined,
      () => undefined,
    );
    await pending;
  }

  subscribeForTest(subscriber: (state: UpgradeState) => void): void {
    this.testSubscriber = subscriber;
  }
}
