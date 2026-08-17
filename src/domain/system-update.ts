export type UpgradePhase =
  | "checking"
  | "installing"
  | "restarting"
  | "syncing_skills"
  | "succeeded"
  | "failed";

export type SystemUpdateErrorCode =
  | "npm_unavailable"
  | "invalid_registry_response"
  | "permission_denied"
  | "package_install_failed"
  | "service_restart_failed"
  | "service_start_timeout"
  | "wrong_version"
  | "skill_sync_failed"
  | "skill_conflict"
  | "hook_conflict"
  | "resource_sync_failed";

export interface SystemUpdateError {
  code: SystemUpdateErrorCode;
  summary: string;
}

export interface PackageVersionStatus {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  lastCheckedAt: string | null;
  lastSuccessfulCheckAt: string | null;
  checkError: SystemUpdateError | null;
  checking: boolean;
}

export interface UpgradeState {
  operationId: string;
  targetVersion: string;
  phase: UpgradePhase;
  startedAt: string;
  updatedAt: string;
  workerPid?: number;
  phaseStartedAt?: Partial<Record<UpgradePhase, string>>;
  completedAt?: string;
  error?: SystemUpdateError;
  resourceSync?: {
    packageVersion: string;
    completedAt: string;
  };
}

export interface VersionStatusChangedEvent {
  type: "system.version_status_changed";
}

export interface UpgradeStatusChangedEvent {
  type: "system.upgrade_status_changed";
}

export type SystemStatusChangedEvent =
  | VersionStatusChangedEvent
  | UpgradeStatusChangedEvent;

export interface SystemStatusEventSource {
  subscribe(listener: (event: SystemStatusChangedEvent) => void): () => void;
}

export function compareSemanticVersions(left: string, right: string): number {
  const leftParts = parseStableSemanticVersion(left);
  const rightParts = parseStableSemanticVersion(right);
  for (let index = 0; index < leftParts.length; index += 1) {
    const difference = leftParts[index]! - rightParts[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
}

export function assertStableSemanticVersion(version: string): string {
  parseStableSemanticVersion(version);
  return version;
}

export function isActiveUpgradePhase(phase: UpgradePhase): boolean {
  return !["succeeded", "failed"].includes(phase);
}

function parseStableSemanticVersion(version: string): [number, number, number] {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  if (!match) {
    throw new Error(`${version} is not a stable semantic version`);
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}
