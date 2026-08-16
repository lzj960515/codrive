import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { HookInstaller } from "../../src/infrastructure/hook-installer.js";

describe("HookInstaller", () => {
  it("preserves user Hooks while installing and fingerprinting one Codrive Hook", async () => {
    const fixture = await createFixture();
    await writeFile(
      fixture.configPath,
      JSON.stringify({
        description: "User hooks",
        hooks: {
          SessionStart: [{ hooks: [{ type: "command", command: "user-hook" }] }],
        },
      }),
      "utf8",
    );

    await expect(fixture.installer.getStatus()).resolves.toMatchObject({
      state: "missing",
      managedHookCount: 1,
      bundledVersion: "0.7.0",
    });
    await fixture.installer.install();

    const config = JSON.parse(await readFile(fixture.configPath, "utf8")) as {
      description: string;
      hooks: Record<string, Array<{ hooks: Array<Record<string, unknown>> }>>;
    };
    expect(config.description).toBe("User hooks");
    expect(config.hooks.SessionStart).toEqual([
      { hooks: [{ type: "command", command: "user-hook" }] },
    ]);
    for (const event of ["UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"]) {
      expect(config.hooks[event]).toEqual([
        {
          hooks: [
            expect.objectContaining({
              type: "command",
              async: true,
              timeout: 2,
              statusMessage: "Reporting Codrive activity",
            }),
          ],
        },
      ]);
    }
    await expect(fixture.installer.getStatus()).resolves.toMatchObject({
      state: "current",
      installedVersion: "0.7.0",
      conflictPaths: [],
    });
    expect(
      JSON.parse(
        await readFile(join(fixture.targetDirectory, ".codrive-managed"), "utf8"),
      ),
    ).toMatchObject({ version: "0.7.0", fingerprint: expect.any(String) });
  });

  it("reports an unmanaged same-name directory without changing user files", async () => {
    const fixture = await createFixture();
    await mkdir(fixture.targetDirectory, { recursive: true });
    await writeFile(join(fixture.targetDirectory, "local.mjs"), "LOCAL\n", "utf8");

    await expect(fixture.installer.getStatus()).resolves.toMatchObject({
      state: "conflict",
      conflictPaths: [fixture.targetDirectory],
    });
    await expect(fixture.installer.install()).rejects.toThrow(
      fixture.targetDirectory,
    );
    await expect(
      readFile(join(fixture.targetDirectory, "local.mjs"), "utf8"),
    ).resolves.toBe("LOCAL\n");
  });

  it("reports an invalid user hooks file as a conflict instead of overwriting it", async () => {
    const fixture = await createFixture();
    await writeFile(fixture.configPath, "{ user owned invalid json\n", "utf8");

    await expect(fixture.installer.getStatus()).resolves.toMatchObject({
      state: "conflict",
      conflictPaths: [fixture.configPath],
    });
    await expect(fixture.installer.install()).rejects.toThrow(fixture.configPath);
    await expect(readFile(fixture.configPath, "utf8")).resolves.toBe(
      "{ user owned invalid json\n",
    );
  });
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "codrive-hook-installer-"));
  const sourceDirectory = join(root, "source");
  const targetDirectory = join(root, "codex", "hooks", "codrive");
  const configPath = join(root, "codex", "hooks.json");
  await mkdir(sourceDirectory, { recursive: true });
  await mkdir(join(root, "codex"), { recursive: true });
  await writeFile(
    join(sourceDirectory, "codrive-activity-hook.mjs"),
    "process.stdout.write('{}\\n');\n",
    "utf8",
  );
  return {
    targetDirectory,
    configPath,
    installer: new HookInstaller(
      sourceDirectory,
      targetDirectory,
      configPath,
      "0.7.0",
    ),
  };
}
