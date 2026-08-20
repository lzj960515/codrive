export const managedHookDefinitions = [
  { configEvent: "UserPromptSubmit", runtimeEvent: "userPromptSubmit" },
  { configEvent: "PreToolUse", runtimeEvent: "preToolUse" },
  { configEvent: "PostToolUse", runtimeEvent: "postToolUse" },
  { configEvent: "Stop", runtimeEvent: "stop" },
] as const;

export const managedHookScriptName = "codrive-activity-hook.mjs";
export const managedHookStatusMessage = "Reporting Codrive activity";

export interface RuntimeHookDefinition {
  eventName: string;
  command: string | null;
  statusMessage: string | null;
  enabled: boolean;
  trustStatus: "managed" | "untrusted" | "trusted" | "modified";
}

export type ManagedHookRuntimeState =
  | "ready"
  | "review_required"
  | "disabled"
  | "missing"
  | "unavailable";

export interface ManagedHookRuntimeStatus {
  state: ManagedHookRuntimeState;
  definitionCount: number;
}

export function inspectManagedHookRuntime(
  hooks: readonly RuntimeHookDefinition[],
): ManagedHookRuntimeStatus {
  const definitions = hooks.filter(
    ({ command, statusMessage }) =>
      statusMessage === managedHookStatusMessage &&
      command?.includes(managedHookScriptName),
  );
  const expected = managedHookDefinitions.map(({ runtimeEvent }) => runtimeEvent);
  const hasExactDefinitions =
    definitions.length === expected.length &&
    expected.every(
      (eventName) =>
        definitions.filter((definition) => definition.eventName === eventName)
          .length === 1,
    );
  if (!hasExactDefinitions) {
    return { state: "missing", definitionCount: definitions.length };
  }
  if (definitions.some(({ enabled }) => !enabled)) {
    return { state: "disabled", definitionCount: definitions.length };
  }
  if (
    definitions.some(
      ({ trustStatus }) => !["trusted", "managed"].includes(trustStatus),
    )
  ) {
    return {
      state: "review_required",
      definitionCount: definitions.length,
    };
  }
  return { state: "ready", definitionCount: definitions.length };
}
