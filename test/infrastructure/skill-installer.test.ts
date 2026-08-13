import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { SkillInstaller } from "../../src/infrastructure/skill-installer.js";

const skills = [
  "codrive-forge",
  "codrive-task",
  "codrive-work",
  "codrive-control",
];

describe("SkillInstaller", () => {
  it("reports missing, current, and outdated bundled Skills", async () => {
    const source = await mkdtemp(join(tmpdir(), "codrive-skill-source-"));
    const target = await mkdtemp(join(tmpdir(), "codrive-skill-target-"));
    await createSkillBundle(source, "first version");
    const installer = new SkillInstaller(source, target, "0.2.0");

    await expect(installer.getStatus()).resolves.toMatchObject({
      state: "missing",
      bundledVersion: "0.2.0",
      installedVersion: null,
    });

    await installer.install();
    await expect(installer.getStatus()).resolves.toMatchObject({
      state: "current",
      bundledVersion: "0.2.0",
      installedVersion: "0.2.0",
    });

    await writeFile(
      join(source, "codrive-task", "SKILL.md"),
      "---\nname: codrive-task\ndescription: updated\n---\n",
      "utf8",
    );
    await expect(installer.getStatus()).resolves.toMatchObject({
      state: "outdated",
      bundledVersion: "0.2.0",
      installedVersion: "0.2.0",
    });
  });

  it("writes a versioned installation marker", async () => {
    const source = await mkdtemp(join(tmpdir(), "codrive-skill-source-"));
    const target = await mkdtemp(join(tmpdir(), "codrive-skill-target-"));
    await createSkillBundle(source, "current version");
    const installer = new SkillInstaller(source, target, "0.2.0");

    await installer.install();

    const marker = JSON.parse(
      await readFile(
        join(target, "codrive-task", ".codrive-managed"),
        "utf8",
      ),
    ) as { version: string; fingerprint: string };
    expect(marker.version).toBe("0.2.0");
    expect(marker.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("keeps unchanged Skills current across package releases", async () => {
    const source = await mkdtemp(join(tmpdir(), "codrive-skill-source-"));
    const target = await mkdtemp(join(tmpdir(), "codrive-skill-target-"));
    await createSkillBundle(source, "unchanged Skills");
    await new SkillInstaller(source, target, "0.2.0").install();

    await expect(
      new SkillInstaller(source, target, "0.2.1").getStatus(),
    ).resolves.toMatchObject({
      state: "current",
      bundledVersion: "0.2.1",
      installedVersion: "0.2.0",
    });
  });

  it("reports every unmanaged conflict path and leaves all Skills untouched", async () => {
    const source = await mkdtemp(join(tmpdir(), "codrive-skill-source-"));
    const target = await mkdtemp(join(tmpdir(), "codrive-skill-target-"));
    await createSkillBundle(source, "managed content");
    const conflictingPath = join(target, "codrive-task");
    await mkdir(conflictingPath, { recursive: true });
    await writeFile(join(conflictingPath, "SKILL.md"), "LOCAL CONTENT\n", "utf8");
    const installer = new SkillInstaller(source, target, "0.7.0");

    await expect(installer.getStatus()).resolves.toMatchObject({
      state: "conflict",
      managedSkillCount: 4,
      conflictPaths: [conflictingPath],
    });
    await expect(installer.install()).rejects.toThrow(conflictingPath);
    await expect(
      readFile(join(conflictingPath, "SKILL.md"), "utf8"),
    ).resolves.toBe("LOCAL CONTENT\n");
    await expect(
      readFile(join(target, "codrive-forge", "SKILL.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function createSkillBundle(root: string, content: string): Promise<void> {
  for (const skill of skills) {
    const directory = join(root, skill);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "SKILL.md"),
      `---\nname: ${skill}\ndescription: ${content}\n---\n`,
      "utf8",
    );
  }
}
