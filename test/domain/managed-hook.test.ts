import { describe, expect, it } from "vitest";

import {
  inspectManagedHookRuntime,
  managedHookDefinitions,
  managedHookStatusMessage,
  type RuntimeHookDefinition,
} from "../../src/domain/managed-hook.js";

describe("managed Hook runtime", () => {
  it.each(["untrusted", "modified"] as const)(
    "requires review when a managed definition is %s",
    (trustStatus) => {
      const hooks = runtimeHooks("trusted");
      hooks[1] = { ...hooks[1]!, trustStatus };

      expect(inspectManagedHookRuntime(hooks)).toEqual({
        state: "review_required",
        definitionCount: 4,
      });
    },
  );

  it("accepts definitions trusted by the user or managed policy", () => {
    const hooks = runtimeHooks("trusted");
    hooks[0] = { ...hooks[0]!, trustStatus: "managed" };

    expect(inspectManagedHookRuntime(hooks)).toEqual({
      state: "ready",
      definitionCount: 4,
    });
  });

  it("distinguishes disabled and missing definitions from trust review", () => {
    const disabled = runtimeHooks("trusted");
    disabled[2] = { ...disabled[2]!, enabled: false };

    expect(inspectManagedHookRuntime(disabled)).toEqual({
      state: "disabled",
      definitionCount: 4,
    });
    expect(inspectManagedHookRuntime(disabled.slice(0, 3))).toEqual({
      state: "missing",
      definitionCount: 3,
    });
  });
});

function runtimeHooks(
  trustStatus: RuntimeHookDefinition["trustStatus"],
): RuntimeHookDefinition[] {
  return managedHookDefinitions.map(({ runtimeEvent }) => ({
    eventName: runtimeEvent,
    command: 'node "/home/user/.codex/hooks/codrive/codrive-activity-hook.mjs"',
    statusMessage: managedHookStatusMessage,
    enabled: true,
    trustStatus,
  }));
}
