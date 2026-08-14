import { afterEach, describe, expect, it, vi } from "vitest";

import { PackageVersionCheckScheduler } from "../../src/application/package-version-check-scheduler.js";
import type { PackageVersionStatus } from "../../src/domain/system-update.js";

const checkIntervalMs = 60 * 60 * 1_000;
const initialTime = "2026-08-14T00:00:00.000Z";

function versionStatus(lastCheckedAt: string | null): PackageVersionStatus {
  return {
    currentVersion: "0.6.2",
    latestVersion: "0.6.2",
    updateAvailable: false,
    lastCheckedAt,
    lastSuccessfulCheckAt: lastCheckedAt,
    checkError: null,
    checking: false,
  };
}

function createVersionService(lastCheckedAt: string | null) {
  let current = versionStatus(lastCheckedAt);
  const read = vi.fn(async () => current);
  const refresh = vi.fn(async () => {
    current = versionStatus(new Date(Date.now()).toISOString());
    return current;
  });
  return { read, refresh };
}

async function settleChecks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("PackageVersionCheckScheduler", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ["missing", null],
    ["invalid", "not-a-time"],
    ["expired", "2026-08-13T22:59:59.999Z"],
  ])(
    "checks immediately when the persisted timestamp is %s",
    async (_case, checkedAt) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(initialTime));
      const versions = createVersionService(checkedAt);
      const scheduler = new PackageVersionCheckScheduler({ versions });

      await scheduler.start();
      await settleChecks();

      expect(versions.refresh).toHaveBeenCalledTimes(1);
      expect(versions.refresh).toHaveBeenCalledWith({ force: true });
      expect(vi.getTimerCount()).toBe(1);
      scheduler.stop();
    },
  );

  it("uses the remaining interval from a fresh persisted check", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(initialTime));
    const versions = createVersionService("2026-08-13T23:20:00.000Z");
    const scheduler = new PackageVersionCheckScheduler({ versions });

    await scheduler.start();
    expect(versions.refresh).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(19 * 60 * 1_000 + 59_000);
    expect(versions.refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(versions.refresh).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    scheduler.stop();
  });

  it("continues checking once per hour while the service stays running", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(initialTime));
    const versions = createVersionService(initialTime);
    const scheduler = new PackageVersionCheckScheduler({ versions });

    await scheduler.start();
    await vi.advanceTimersByTimeAsync(3 * checkIntervalMs);

    expect(versions.refresh).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(1);
    scheduler.stop();
  });

  it("restarts the hourly interval after a manual check", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(initialTime));
    const versions = createVersionService(initialTime);
    const scheduler = new PackageVersionCheckScheduler({ versions });
    await scheduler.start();

    await vi.advanceTimersByTimeAsync(10 * 60 * 1_000);
    await scheduler.checkNow();
    expect(versions.refresh).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(59 * 60 * 1_000);
    expect(versions.refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60 * 1_000);
    expect(versions.refresh).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });

  it("anchors the next timer to the persisted lastCheckedAt", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(initialTime));
    const versions = createVersionService(initialTime);
    const scheduler = new PackageVersionCheckScheduler({ versions });
    await scheduler.start();
    versions.refresh.mockImplementationOnce(async () => {
      const checkedAt = new Date(Date.now()).toISOString();
      vi.setSystemTime(new Date(Date.now() + 5 * 60 * 1_000));
      return versionStatus(checkedAt);
    });

    await scheduler.checkNow();
    await vi.advanceTimersByTimeAsync(54 * 60 * 1_000 + 59_000);
    expect(versions.refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(versions.refresh).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });

  it("waits until the next hourly interval after a failed automatic check", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(initialTime));
    const versions = createVersionService(null);
    versions.refresh
      .mockRejectedValueOnce(new Error("version cache is read-only"))
      .mockResolvedValue(versionStatus("2026-08-14T01:00:00.000Z"));
    const onError = vi.fn();
    const scheduler = new PackageVersionCheckScheduler({ versions, onError });

    await scheduler.start();
    await settleChecks();
    expect(versions.refresh).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.any(Error));

    await vi.advanceTimersByTimeAsync(checkIntervalMs - 1);
    expect(versions.refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(versions.refresh).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });

  it("recovers a cache-read failure without blocking service startup", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(initialTime));
    const versions = createVersionService(null);
    versions.read.mockRejectedValueOnce(new Error("invalid cache"));
    const onError = vi.fn();
    const scheduler = new PackageVersionCheckScheduler({ versions, onError });

    await expect(scheduler.start()).resolves.toBeUndefined();
    await settleChecks();

    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    expect(versions.refresh).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    scheduler.stop();
  });

  it("publishes background check start and completion to current board subscribers", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(initialTime));
    const versions = createVersionService(null);
    const scheduler = new PackageVersionCheckScheduler({ versions });
    const listener = vi.fn();
    const unsubscribe = scheduler.subscribe(listener);

    await scheduler.start();
    await settleChecks();

    expect(listener).toHaveBeenNthCalledWith(1, {
      type: "system.version_status_changed",
    });
    expect(listener).toHaveBeenNthCalledWith(2, {
      type: "system.version_status_changed",
    });
    unsubscribe();
    await scheduler.checkNow();
    expect(listener).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });

  it("keeps one timer across duplicate starts and clears it on stop", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(initialTime));
    const versions = createVersionService(initialTime);
    const scheduler = new PackageVersionCheckScheduler({ versions });

    await Promise.all([scheduler.start(), scheduler.start()]);
    expect(versions.read).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);

    scheduler.stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(2 * checkIntervalMs);
    expect(versions.refresh).not.toHaveBeenCalled();
  });

  it("does not reschedule an in-flight check after stop", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(initialTime));
    const versions = createVersionService(null);
    let completeCheck!: (status: PackageVersionStatus) => void;
    versions.refresh.mockImplementationOnce(
      () => new Promise((resolve) => {
        completeCheck = resolve;
      }),
    );
    const scheduler = new PackageVersionCheckScheduler({ versions });

    await scheduler.start();
    expect(versions.refresh).toHaveBeenCalledTimes(1);
    scheduler.stop();
    completeCheck(versionStatus(initialTime));
    await settleChecks();

    expect(vi.getTimerCount()).toBe(0);
  });
});
