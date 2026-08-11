import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("Codrive release command", () => {
  it("keeps npm Web OTP inside one interactive publish process", async () => {
    const instructions = await readFile(
      resolve(".claude/commands/release.md"),
      "utf8",
    );

    expect(instructions).toContain("interactive TTY");
    expect(instructions).toContain("Press ENTER to open in the browser...");
    expect(instructions).toContain("same `npm publish` process");
    expect(instructions).toContain("npm owns the authentication URL");
    expect(instructions).toMatch(
      /Browser\s+automation is not part of this release flow/,
    );
  });
});
