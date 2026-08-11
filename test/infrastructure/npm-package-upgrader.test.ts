import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  NpmPackageUpgrader,
  type PackageCommandRunner,
} from "../../src/infrastructure/npm-package-upgrader.js";

describe("NpmPackageUpgrader", () => {
  it("installs the latest global package and restarts through the upgraded CLI", () => {
    const calls: Array<{ command: string; args: string[]; capture: boolean }> = [];
    const runner: PackageCommandRunner = {
      run(command, args, captureOutput) {
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

    expect(upgrader.upgrade()).toEqual({
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
});
