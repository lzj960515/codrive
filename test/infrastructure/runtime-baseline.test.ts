import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  MINIMUM_NODE_MAJOR,
  supportsNodeVersion,
} from "../../src/infrastructure/runtime-requirements.js";

describe("Node.js runtime baseline", () => {
  it("accepts Node.js 24 and rejects older runtimes", () => {
    expect(MINIMUM_NODE_MAJOR).toBe(24);
    expect(supportsNodeVersion("23.11.1")).toBe(false);
    expect(supportsNodeVersion("24.0.0")).toBe(true);
    expect(supportsNodeVersion("25.1.0")).toBe(true);
  });

  it("keeps package, development, CI, and Skill contracts on Node.js 24", async () => {
    const packageJson = JSON.parse(await readFile(resolve("package.json"), "utf8")) as {
      engines: { node: string };
    };
    const developmentVersion = await readFile(resolve(".node-version"), "utf8");
    const ci = await readFile(resolve(".github/workflows/ci.yml"), "utf8");
    const agentGuide = await readFile(resolve("AGENTS.md"), "utf8");
    const readmes = await Promise.all(
      ["README.md", "README.zh-CN.md"].map((file) =>
        readFile(resolve(file), "utf8"),
      ),
    );
    const skillDirectories = await readdir(resolve("skills"), {
      withFileTypes: true,
    });
    const skills = await Promise.all(
      skillDirectories
        .filter((entry) => entry.isDirectory())
        .map((entry) =>
          readFile(resolve("skills", entry.name, "SKILL.md"), "utf8"),
        ),
    );

    expect(packageJson.engines.node).toBe(">=24");
    expect(developmentVersion.trim()).toBe("24");
    expect(ci).toContain("node-version: 24");
    expect(ci).not.toMatch(/node-version:\s*20|runtime-node-20/);
    expect(ci).toContain("actions/checkout@v7");
    expect(ci).toContain("pnpm/action-setup@v6");
    expect(ci).toContain("actions/setup-node@v7");
    expect(ci).toContain("actions/upload-artifact@v7");
    expect(ci).toContain("actions/download-artifact@v8");
    expect(agentGuide).toContain("Use Node.js 24 for development and runtime.");
    for (const readme of readmes) expect(readme).not.toMatch(/Node(?:\.js)? 20/);
    for (const skill of skills) {
      expect(skill).toMatch(/compatibility: Requires Node\.js 24\+/);
    }
  });
});
