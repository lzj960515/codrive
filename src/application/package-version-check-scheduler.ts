import type {
  PackageVersionStatus,
  VersionStatusChangedEvent,
} from "../domain/system-update.js";
import type { PackageVersionService } from "../infrastructure/package-version-service.js";

export type { VersionStatusChangedEvent } from "../domain/system-update.js";

export interface PackageVersionCheckTrigger {
  checkNow(): Promise<PackageVersionStatus>;
}

export interface VersionStatusEventSource {
  subscribe(listener: (event: VersionStatusChangedEvent) => void): () => void;
}

export interface PackageVersionCheckSchedulerOptions {
  versions: Pick<PackageVersionService, "read" | "refresh">;
  intervalMs?: number;
  now?: () => Date;
  onError?: (error: unknown) => void;
}

const defaultCheckIntervalMs = 60 * 60 * 1_000;

export class PackageVersionCheckScheduler
  implements PackageVersionCheckTrigger, VersionStatusEventSource
{
  private readonly intervalMs: number;
  private readonly now: () => Date;
  private readonly listeners = new Set<
    (event: VersionStatusChangedEvent) => void
  >();
  private timer: NodeJS.Timeout | null = null;
  private scheduleRevision = 0;
  private started = false;

  constructor(private readonly options: PackageVersionCheckSchedulerOptions) {
    this.intervalMs = options.intervalMs ?? defaultCheckIntervalMs;
    this.now = options.now ?? (() => new Date());
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const revision = ++this.scheduleRevision;

    try {
      const status = await this.options.versions.read();
      if (!this.isCurrent(revision)) return;
      const delay = this.nextCheckDelay(status);
      if (delay === 0) this.startAutomaticCheck();
      else this.schedule(delay, revision);
    } catch (error) {
      this.options.onError?.(error);
      if (this.isCurrent(revision)) this.startAutomaticCheck();
    }
  }

  stop(): void {
    this.started = false;
    this.scheduleRevision += 1;
    this.clearTimer();
  }

  async checkNow(): Promise<PackageVersionStatus> {
    const revision = ++this.scheduleRevision;
    this.clearTimer();
    let status: PackageVersionStatus | undefined;
    try {
      const refresh = this.options.versions.refresh({ force: true });
      if (this.isCurrent(revision)) this.publishStatusChanged();
      status = await refresh;
      return status;
    } finally {
      if (this.isCurrent(revision)) {
        this.publishStatusChanged();
        this.schedule(
          status ? this.nextCheckDelay(status) : this.intervalMs,
          revision,
        );
      }
    }
  }

  subscribe(listener: (event: VersionStatusChangedEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private nextCheckDelay(status: PackageVersionStatus): number {
    if (!status.lastCheckedAt) return 0;
    const checkedAt = Date.parse(status.lastCheckedAt);
    if (!Number.isFinite(checkedAt)) return 0;
    const elapsed = this.now().getTime() - checkedAt;
    if (elapsed >= this.intervalMs) return 0;
    if (elapsed <= 0) return this.intervalMs;
    return this.intervalMs - elapsed;
  }

  private startAutomaticCheck(): void {
    void this.checkNow().catch((error: unknown) => {
      this.options.onError?.(error);
    });
  }

  private schedule(delayMs: number, revision: number): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.isCurrent(revision)) this.startAutomaticCheck();
    }, delayMs);
    this.timer.unref();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private isCurrent(revision: number): boolean {
    return this.started && revision === this.scheduleRevision;
  }

  private publishStatusChanged(): void {
    const event: VersionStatusChangedEvent = {
      type: "system.version_status_changed",
    };
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        this.options.onError?.(error);
      }
    }
  }
}
