import { describe, expect, it } from "vitest";

import {
  initialModelRouting,
  planModelCapacityRecovery,
  prepareModelRoutingForTurn,
} from "../../src/application/model-routing.js";
import type { ExecutionModelRouting, ModelRoutingSettings } from "../../src/domain/types.js";

const now = new Date("2026-09-07T00:00:00.000Z");
const settings: ModelRoutingSettings = {
  primary: "gpt-6-astra",
  primaryReasoningEffort: "high",
  fallback: "gpt-5.6-sol",
  fallbackReasoningEffort: "low",
};
const failure = { turnId: "turn_1", message: "Selected model is at capacity" };

describe("reasoning effort model routing", () => {
  it("starts with primary effort and switches to fallback effort on capacity exhaustion", () => {
    const primary = initialModelRouting(settings);
    expect(primary.reasoningEffort).toBe("high");

    const recovery = planModelCapacityRecovery(primary, failure, settings, now, [], 300_000);
    expect(recovery.routing).toMatchObject({
      model: settings.fallback,
      route: "fallback",
      reasoningEffort: "low",
    });
    expect(primary.reasoningEffort).toBe("high");
  });

  it("applies an effort edit at the next turn without resetting route health or mutating the active turn", () => {
    const active: ExecutionModelRouting = {
      ...initialModelRouting(settings),
      retryCount: 2,
    };
    const next = prepareModelRoutingForTurn(active, { ...settings, primaryReasoningEffort: "ultra" }, now, 300_000);

    expect(next).toMatchObject({ reasoningEffort: "ultra", retryCount: 2, route: "primary" });
    expect(active.reasoningEffort).toBe("high");
  });

  it("uses each route's current effort through fallback cooldown, primary probe and failed probe", () => {
    const fallback: ExecutionModelRouting = {
      model: settings.fallback,
      reasoningEffort: "medium",
      route: "fallback",
      retryCount: 2,
      circuitBreaker: { state: "open", primaryProbeAt: new Date(now.getTime() + 300_000).toISOString() },
    };
    const waiting = prepareModelRoutingForTurn(fallback, settings, now, 300_000);
    expect(waiting).toMatchObject({ route: "fallback", reasoningEffort: "low", retryCount: 2 });

    const probe = prepareModelRoutingForTurn(waiting, settings, new Date(now.getTime() + 300_000), 300_000);
    expect(probe).toMatchObject({ route: "primary", reasoningEffort: "high" });

    const failed = planModelCapacityRecovery(probe, failure, settings, now, [], 300_000);
    expect(failed.routing).toMatchObject({ route: "fallback", reasoningEffort: "low", retryCount: 2 });
  });

  it("clears an explicit effort when configuration returns to the model default", () => {
    const defaults = { primary: settings.primary, fallback: settings.fallback };
    const next = prepareModelRoutingForTurn({ ...initialModelRouting(settings), reasoningEffort: "high" }, defaults, now, 300_000);

    expect(next).not.toHaveProperty("reasoningEffort");
    const legacy = initialModelRouting(defaults);
    expect(legacy).not.toHaveProperty("reasoningEffort");
    expect(prepareModelRoutingForTurn(legacy, defaults, now, 300_000)).toBe(legacy);
  });
});
