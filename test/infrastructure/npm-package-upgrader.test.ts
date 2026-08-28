import { join } from "node:path";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  NpmPackageUpgrader,
  type PackageCommandRunner,
} from "../../src/infrastructure/npm-package-upgrader.js";

describe("NpmPackageUpgrader", () => {
  it("routes the normal CLI update through the running service command boundary", async () => {
    const cli = await readFile(
      new URL("../../src/interfaces/cli/index.ts", import.meta.url),
      "utf8",
    );

    expect(cli).toContain('type: "system.check_for_updates"');
    expect(cli).toContain('type: "system.start_upgrade"');
    expect(cli).toContain('"x-codrive-token": accessToken');
    expect(cli).toContain("waitForUpgradeCompletion");
    expect(cli).not.toContain("supportsUnifiedUpdateApi");
    expect(cli).not.toContain("predates unified updates");
  });

  it("installs an exact global package without changing service state", async () => {
    const calls: Array<{ command: string; args: string[]; capture: boolean }> = [];
    const runner: PackageCommandRunner = {
      async run(command, args, captureOutput) {
        calls.push({ command, args, capture: captureOutput });
        return {
          exitCode: 0,
          stdout: args.join(" ") === "root --global" ? "/global/node_modules\n" : "",
          stderr: "",
        };
      },
    };
    const upgrader = new NpmPackageUpgrader(runner, {
      npmExecutable: "npm-test",
      nodeExecutable: "/node-test",
    });

    await expect(upgrader.install("0.7.0")).resolves.toEqual({
      cliPath: join(
        "/global/node_modules",
        "codrive",
        "dist/interfaces/cli/index.js",
      ),
    });
    expect(calls).toEqual([
      {
        command: "npm-test",
        args: ["install", "--global", "codrive@0.7.0"],
        capture: false,
      },
      {
        command: "npm-test",
        args: ["root", "--global"],
        capture: true,
      },
    ]);
  });

  it("runs stop, migration, and start through the upgraded CLI", async () => {
    const calls: Array<{
      command: string;
      args: string[];
      environment?: NodeJS.ProcessEnv;
    }> = [];
    const runner: PackageCommandRunner = {
      async run(command, args, _captureOutput, environment) {
        calls.push({ command, args, ...(environment ? { environment } : {}) });
        return {
          exitCode: 0,
          stdout: args.join(" ") === "root --global" ? "/global/node_modules\n" : "",
          stderr: "",
        };
      },
    };
    const upgrader = new NpmPackageUpgrader(runner, {
      npmExecutable: "npm-test",
      nodeExecutable: "/node-test",
    });

    const cliPath = "/global/node_modules/codrive/dist/interfaces/cli/index.js";
    await upgrader.stop(cliPath, "/state/codrive");
    await upgrader.migrate(cliPath, "/state/codrive");
    await upgrader.start(cliPath, "/state/codrive");

    expect(calls).toHaveLength(3);
    expect(calls.map(({ args }) => args)).toEqual([
      [cliPath, "stop"],
      [cliPath, "_migrate-state"],
      [cliPath, "start"],
    ]);
    expect(
      calls.every(
        ({ environment }) => environment?.CODEDRIVE_HOME === "/state/codrive",
      ),
    ).toBe(true);
  });
});
