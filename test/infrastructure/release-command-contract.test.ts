import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("Codrive release command", () => {
  it("delegates tagged npm releases to GitHub Actions", async () => {
    const [instructions, workflow] = await Promise.all([
      readFile(resolve(".claude/commands/release.md"), "utf8"),
      readFile(resolve(".github/workflows/release.yml"), "utf8"),
    ]);

    expect(instructions).toContain("GitHub Actions");
    expect(instructions).toContain("git push origin main --follow-tags");
    expect(instructions).toContain("gh run watch");
    expect(instructions).not.toContain("npm whoami");
    expect(instructions).not.toContain("npm publish --access public");
    expect(instructions).not.toContain("interactive TTY");
    expect(instructions).not.toContain("Web OTP");

    expect(workflow).toMatch(/push:\s*\n\s*tags:\s*\n\s*- ["']v\*["']/);
    expect(workflow).toContain("environment: npm");
    expect(workflow).toContain('node-version: 24');
    expect(workflow).toContain(
      "registry-url: https://registry.npmjs.org",
    );
    expect(workflow).toContain("pnpm install --frozen-lockfile");
    expect(workflow).toContain("pnpm test");
    expect(workflow).toContain("pnpm typecheck");
    expect(workflow).toContain("pnpm build");
    expect(workflow).toContain("npm publish --access public");
    expect(workflow).toContain(
      "NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}",
    );
    expect(workflow).toContain("RELEASE_TAG: ${{ github.ref_name }}");
    expect(workflow).toContain(
      'test "$RELEASE_TAG" = "v${package_version}"',
    );
  });
});
