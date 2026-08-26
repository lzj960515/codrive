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

  it("installs the latest global package and restarts through the upgraded CLI", async () => {
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

    await expect(upgrader.upgrade()).resolves.toEqual({
      cliPath: join(
        "/global/node_modules",
        "codrive",
        "dist/interfaces/cli/index.js",
      ),
    });
    expect(calls).toEqual([
      {
        command: "npm-test",
        args: ["install", "--global", "codrive@latest"],
        capture: false,
      },
      {
        command: "npm-test",
        args: ["root", "--global"],
        capture: true,
      },
      {
        command: "/node-test",
        args: [
          join(
            "/global/node_modules",
            "codrive",
            "dist/interfaces/cli/index.js",
          ),
          "restart",
        ],
        capture: false,
      },
    ]);
  });

  it("installs a fixed target and restarts the same state directory", async () => {
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

    const installed = await upgrader.install("0.7.0");
    await upgrader.restart(installed.cliPath, "/state/codrive");

    expect(calls[0]?.args).toEqual([
      "install",
      "--global",
      "codrive@0.7.0",
    ]);
    expect(calls[2]).toMatchObject({
      command: "/node-test",
      args: [installed.cliPath, "restart"],
      environment: { CODEDRIVE_HOME: "/state/codrive" },
    });
  });
});
