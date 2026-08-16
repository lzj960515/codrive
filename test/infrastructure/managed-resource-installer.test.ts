import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { HookInstaller } from "../../src/infrastructure/hook-installer.js";
import { ManagedResourceInstaller } from "../../src/infrastructure/managed-resource-installer.js";
import { SkillInstaller } from "../../src/infrastructure/skill-installer.js";

const skillNames = [
  "codrive-forge",
  "codrive-task",
  "codrive-work",
  "codrive-control",
];

describe("ManagedResourceInstaller", () => {
  it("preflights a Hook conflict before writing any managed Skill", async () => {
    const fixture = await createFixture();
    await mkdir(fixture.hookTarget, { recursive: true });
    await writeFile(join(fixture.hookTarget, "local.mjs"), "LOCAL\n", "utf8");

    await expect(fixture.installer.install()).rejects.toThrow(fixture.hookTarget);
    await expect(
      access(join(fixture.skillTarget, "codrive-task", "SKILL.md")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports current only when all four Skills and the Hook are current", async () => {
    const fixture = await createFixture();

    await expect(fixture.installer.getStatus()).resolves.toMatchObject({
      state: "missing",
      managedSkillCount: 4,
      managedHookCount: 1,
      skills: { state: "missing" },
      hook: { state: "missing" },
    });

    await fixture.installer.install();

    await expect(fixture.installer.getStatus()).resolves.toMatchObject({
      state: "current",
      managedSkillCount: 4,
      managedHookCount: 1,
      conflictPaths: [],
      skills: { state: "current" },
      hook: { state: "current" },
    });

    await writeFile(
      join(fixture.hookSource, "codrive-activity-hook.mjs"),
      "process.stdout.write('{\"changed\":true}\\n');\n",
      "utf8",
    );
    await expect(fixture.installer.getStatus()).resolves.toMatchObject({
      state: "outdated",
      skills: { state: "current" },
      hook: { state: "outdated" },
    });
  });
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "codrive-managed-resources-"));
  const skillSource = join(root, "package", "skills");
  const hookSource = join(root, "package", "hooks", "codrive");
  const skillTarget = join(root, "home", ".agents", "skills");
  const hookTarget = join(root, "home", ".codex", "hooks", "codrive");
  const hookConfig = join(root, "home", ".codex", "hooks.json");
  for (const skill of skillNames) {
    const directory = join(skillSource, skill);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "SKILL.md"),
      `---\nname: ${skill}\ndescription: managed\n---\n`,
      "utf8",
    );
  }
  await mkdir(hookSource, { recursive: true });
  await writeFile(
    join(hookSource, "codrive-activity-hook.mjs"),
    "process.stdout.write('{}\\n');\n",
    "utf8",
  );
  return {
    skillTarget,
    hookSource,
    hookTarget,
    installer: new ManagedResourceInstaller(
      new SkillInstaller(skillSource, skillTarget, "0.7.0"),
      new HookInstaller({
        sourceDirectory: hookSource,
        targetDirectory: hookTarget,
        configPath: hookConfig,
        version: "0.7.0",
      }),
    ),
  };
}
