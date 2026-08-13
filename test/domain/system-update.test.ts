import { describe, expect, it } from "vitest";

import {
  compareSemanticVersions,
  isActiveUpgradePhase,
} from "../../src/domain/system-update.js";

describe("system update contracts", () => {
  it("compares stable semantic versions numerically", () => {
    expect(compareSemanticVersions("0.9.9", "0.10.0")).toBeLessThan(0);
    expect(compareSemanticVersions("2.0.0", "1.99.99")).toBeGreaterThan(0);
    expect(compareSemanticVersions("1.2.3", "1.2.3")).toBe(0);
  });

  it("rejects values that are not stable semantic versions", () => {
    expect(() => compareSemanticVersions("1.0.0-beta.1", "1.0.0")).toThrow(
      /stable semantic version/i,
    );
    expect(() => compareSemanticVersions("latest", "1.0.0")).toThrow(
      /stable semantic version/i,
    );
  });

  it("distinguishes active phases from recoverable terminal states", () => {
    expect(isActiveUpgradePhase("checking")).toBe(true);
    expect(isActiveUpgradePhase("restarting")).toBe(true);
    expect(isActiveUpgradePhase("succeeded")).toBe(false);
    expect(isActiveUpgradePhase("failed")).toBe(false);
  });
});
