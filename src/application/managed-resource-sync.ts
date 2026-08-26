import type { SystemUpdateError } from "../domain/system-update.js";
import type { ManagedResourceInstallationStatus } from "../infrastructure/managed-resource-installer.js";

export type ManagedResourceSyncStatus = Pick<
  ManagedResourceInstallationStatus,
  "state"
> & {
  skills: Pick<ManagedResourceInstallationStatus["skills"], "state">;
  hook: Pick<ManagedResourceInstallationStatus["hook"], "state">;
};

export function managedResourceSyncError(
  resources: ManagedResourceSyncStatus,
): SystemUpdateError {
  if (resources.hook.state === "conflict") {
    return {
      code: "hook_conflict",
      summary:
        "A local unmanaged Codex Hook conflicts with Codrive. Move it aside, then retry the update.",
    };
  }
  if (resources.skills.state === "conflict") {
    return {
      code: "skill_conflict",
      summary:
        "A local unmanaged Skill has the same name. Move it aside, then retry the update.",
    };
  }
  return {
    code: "resource_sync_failed",
    summary:
      "Managed Skills and Hook did not match the updated Codrive package. Retry the update.",
  };
}
