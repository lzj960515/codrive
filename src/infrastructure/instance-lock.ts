import { open, readFile, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";

export class InstanceLock {
  private handle: FileHandle | null = null;
  readonly path: string;

  constructor(stateDirectory: string) {
    this.path = join(stateDirectory, "server.lock");
  }

  async readOwnerPid(): Promise<number | null> {
    try {
      const pid = Number.parseInt(await readFile(this.path, "utf8"), 10);
      return Number.isFinite(pid) ? pid : null;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async acquire(): Promise<void> {
    try {
      this.handle = await open(this.path, "wx", 0o600);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
        throw error;
      }
      const pid = await this.readOwnerPid();
      if (pid !== null && processIsRunning(pid)) {
        throw new Error(`Codrive is already running with PID ${pid}`);
      }
      await unlink(this.path);
      this.handle = await open(this.path, "wx", 0o600);
    }
    await this.handle.writeFile(`${process.pid}\n`, "utf8");
  }

  async release(): Promise<void> {
    await this.handle?.close();
    this.handle = null;
    try {
      await unlink(this.path);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
  }
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
