import { describe, expect, it } from "vitest";

import { SemanticAtlasCli } from "../../src/infrastructure/semantic-atlas-cli.js";

describe("SemanticAtlasCli", () => {
  it("detects the public CLI and returns only Semantic Atlas actionable domains", async () => {
    const calls: Array<{ executable: string; arguments_: readonly string[] }> = [];
    const cli = new SemanticAtlasCli({
      execute: async (executable, arguments_) => {
        calls.push({ executable, arguments_ });
        if (arguments_[0] === "--version") return { stdout: "2.2.0\n" };
        return {
          stdout: JSON.stringify({
            schemaVersion: 1,
            ok: true,
            command: "reconcile candidates",
            data: {
              summary: { waitingForEvidenceOccurrences: 3 },
              domains: [
                { businessDomainId: "commerce", candidates: [] },
                { businessDomainId: "support", candidates: [] },
              ],
            },
          }),
        };
      },
    });

    await expect(cli.readInstallation()).resolves.toEqual({ installed: true });
    await expect(
      cli.listActionableBusinessDomains("/workspace/product"),
    ).resolves.toEqual(["commerce", "support"]);
    expect(calls).toEqual([
      { executable: "semantic-atlas", arguments_: ["--version"] },
      {
        executable: "semantic-atlas",
        arguments_: ["reconcile", "candidates", "--repo", "/workspace/product"],
      },
    ]);
  });

  it("treats an unavailable command as not installed and rejects invalid candidate output", async () => {
    const missing = new SemanticAtlasCli({
      execute: async () => {
        throw new Error("ENOENT");
      },
    });
    await expect(missing.readInstallation()).resolves.toEqual({ installed: false });

    const invalid = new SemanticAtlasCli({
      execute: async () => ({ stdout: JSON.stringify({ ok: true, data: {} }) }),
    });
    await expect(
      invalid.listActionableBusinessDomains("/workspace/product"),
    ).rejects.toThrow();
  });
});
