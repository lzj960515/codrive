import { spawnSync } from "node:child_process";
import { join } from "node:path";

export interface PackageCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export interface PackageCommandRunner {
  run(
    command: string,
    args: string[],
    captureOutput: boolean,
    environment?: NodeJS.ProcessEnv,
  ): PackageCommandResult;
}

export interface NpmPackageUpgraderOptions {
  npmExecutable?: string;
  nodeExecutable?: string;
}

export class NpmPackageUpgrader {
  private readonly npmExecutable: string;
  private readonly nodeExecutable: string;

  constructor(
    private readonly runner: PackageCommandRunner = new SpawnPackageCommandRunner(),
    options: NpmPackageUpgraderOptions = {},
  ) {
    this.npmExecutable =
      options.npmExecutable ?? (process.platform === "win32" ? "npm.cmd" : "npm");
    this.nodeExecutable = options.nodeExecutable ?? process.execPath;
  }

  upgrade(): { cliPath: string } {
    const installed = this.install("latest");
    this.restart(installed.cliPath);
    return installed;
  }

  install(targetVersion: string): { cliPath: string } {
    this.runChecked(
      this.npmExecutable,
      ["install", "--global", `codrive@${targetVersion}`],
      false,
    );
    const globalRoot = this.runChecked(
      this.npmExecutable,
      ["root", "--global"],
      true,
    ).stdout.trim();
    if (!globalRoot) throw new Error("npm did not return its global package root");
    const cliPath = join(
      globalRoot,
      "codrive",
      "dist/interfaces/cli/index.js",
    );
    return { cliPath };
  }

  restart(cliPath: string, stateDirectory?: string): void {
    this.runChecked(
      this.nodeExecutable,
      [cliPath, "restart"],
      false,
      stateDirectory
        ? { ...process.env, CODEDRIVE_HOME: stateDirectory }
        : process.env,
    );
  }

  private runChecked(
    command: string,
    args: string[],
    captureOutput: boolean,
    environment?: NodeJS.ProcessEnv,
  ): PackageCommandResult {
    const result = this.runner.run(command, args, captureOutput, environment);
    if (result.error) throw result.error;
    if (result.exitCode !== 0) {
      const detail = result.stderr.trim();
      throw new Error(
        `${command} ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`,
      );
    }
    return result;
  }
}

class SpawnPackageCommandRunner implements PackageCommandRunner {
  run(
    command: string,
    args: string[],
    captureOutput: boolean,
    environment?: NodeJS.ProcessEnv,
  ): PackageCommandResult {
    const result = spawnSync(command, args, {
      encoding: "utf8",
      stdio: captureOutput ? "pipe" : "inherit",
      env: environment,
    });
    return {
      exitCode: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      ...(result.error ? { error: result.error } : {}),
    };
  }
}
