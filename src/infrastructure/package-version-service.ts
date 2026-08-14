import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import {
  assertStableSemanticVersion,
  compareSemanticVersions,
  type PackageVersionStatus,
  type SystemUpdateError,
} from "../domain/system-update.js";

interface VersionCache {
  latestVersion: string | null;
  lastCheckedAt: string;
  lastSuccessfulCheckAt: string | null;
  checkError: SystemUpdateError | null;
}

export interface PackageVersionServiceOptions {
  currentVersion: string;
  stateDirectory: string;
  resolveLatestVersion?: () => Promise<string>;
  now?: () => Date;
  cacheTtlMs?: number;
}

const executeFile = promisify(execFile);
const defaultCacheTtlMs = 60 * 60 * 1_000;

export class PackageVersionService {
  private readonly cachePath: string;
  private readonly resolveLatestVersion: () => Promise<string>;
  private readonly now: () => Date;
  private readonly cacheTtlMs: number;
  private inFlight: Promise<PackageVersionStatus> | null = null;

  constructor(private readonly options: PackageVersionServiceOptions) {
    assertStableSemanticVersion(options.currentVersion);
    this.cachePath = join(options.stateDirectory, "version-check.json");
    this.resolveLatestVersion = options.resolveLatestVersion ?? resolveNpmLatestVersion;
    this.now = options.now ?? (() => new Date());
    this.cacheTtlMs = options.cacheTtlMs ?? defaultCacheTtlMs;
  }

  async read(): Promise<PackageVersionStatus> {
    const cache = await this.readCache();
    return this.createStatus(cache, cache?.checkError ?? null);
  }

  async refresh(options: { force?: boolean } = {}): Promise<PackageVersionStatus> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.refreshCache(options).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async refreshCache(
    options: { force?: boolean },
  ): Promise<PackageVersionStatus> {
    const cache = await this.readCache();
    if (!options.force && cache && this.isFresh(cache)) {
      return this.createStatus(cache, cache.checkError, null, false);
    }
    return this.fetchAndCache(cache);
  }

  private async fetchAndCache(cache: VersionCache | null): Promise<PackageVersionStatus> {
    try {
      const latestVersion = (await this.resolveLatestVersion()).trim();
      assertStableSemanticVersion(latestVersion);
      const checkedAt = this.now().toISOString();
      const nextCache = {
        latestVersion,
        lastCheckedAt: checkedAt,
        lastSuccessfulCheckAt: checkedAt,
        checkError: null,
      };
      await this.writeCache(nextCache);
      return this.createStatus(nextCache, null, null, false);
    } catch (error) {
      const checkError = classifyVersionError(error);
      const checkedAt = this.now().toISOString();
      const failedCache: VersionCache = {
        latestVersion: cache?.latestVersion ?? null,
        lastCheckedAt: checkedAt,
        lastSuccessfulCheckAt: cache?.lastSuccessfulCheckAt ?? null,
        checkError,
      };
      await this.writeCache(failedCache);
      return this.createStatus(failedCache, checkError, null, false);
    }
  }

  private createStatus(
    cache: VersionCache | null,
    checkError: SystemUpdateError | null,
    failedCheckAt: string | null = null,
    checking = this.inFlight !== null,
  ): PackageVersionStatus {
    return {
      currentVersion: this.options.currentVersion,
      latestVersion: cache?.latestVersion ?? null,
      updateAvailable:
        cache?.latestVersion !== null && cache?.latestVersion !== undefined &&
        compareSemanticVersions(this.options.currentVersion, cache.latestVersion) < 0,
      lastCheckedAt: cache?.lastCheckedAt ?? failedCheckAt,
      lastSuccessfulCheckAt: cache?.lastSuccessfulCheckAt ?? null,
      checkError,
      checking,
    };
  }

  private isFresh(cache: VersionCache): boolean {
    return (
      cache.lastSuccessfulCheckAt !== null &&
      cache.checkError === null &&
      this.now().getTime() - Date.parse(cache.lastSuccessfulCheckAt) < this.cacheTtlMs
    );
  }

  private async readCache(): Promise<VersionCache | null> {
    try {
      const cache = JSON.parse(await readFile(this.cachePath, "utf8")) as VersionCache;
      if (cache.latestVersion !== null) {
        assertStableSemanticVersion(cache.latestVersion);
      }
      return cache;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return null;
      }
      return null;
    }
  }

  private async writeCache(cache: VersionCache): Promise<void> {
    await mkdir(dirname(this.cachePath), { recursive: true });
    const temporaryPath = `${this.cachePath}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(cache, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, this.cachePath);
  }
}

async function resolveNpmLatestVersion(): Promise<string> {
  const executable = process.platform === "win32" ? "npm.cmd" : "npm";
  const { stdout } = await executeFile(
    executable,
    ["view", "codrive", "dist-tags.latest", "--json"],
    { encoding: "utf8", timeout: 5_000, maxBuffer: 64 * 1_024 },
  );
  const value = JSON.parse(stdout) as unknown;
  if (typeof value !== "string") throw new InvalidRegistryResponseError();
  return value;
}

class InvalidRegistryResponseError extends Error {}

function classifyVersionError(error: unknown): SystemUpdateError {
  const invalid =
    error instanceof InvalidRegistryResponseError ||
    (error instanceof Error && /stable semantic version|JSON/.test(error.message));
  return invalid
    ? {
        code: "invalid_registry_response",
        summary: "npm returned an invalid stable-version response. Try checking again later.",
      }
    : {
        code: "npm_unavailable",
        summary: "npm could not be reached. The board remains available; check the network and retry.",
      };
}
