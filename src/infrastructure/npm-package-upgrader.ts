import { spawn } from "node:child_process";
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
  ): Promise<PackageCommandResult>;
}

export interface NpmPackageUpgraderOptions {
  npmExecutable?: string;
  nodeExecutable?: string;
}

const maximumCapturedOutputLength = 256 * 1_024;

export type PackageUpgradeStep =
  | "install"
  | "locate"
  | "stop"
  | "migrate"
  | "start";
export type PackageCommandFailureKind = "permission_denied" | "command_failed";

export class PackageCommandError extends Error {
  override readonly name = "PackageCommandError";

  constructor(
    readonly step: PackageUpgradeStep,
    readonly kind: PackageCommandFailureKind,
  ) {
    super(
      kind === "permission_denied"
        ? `The Codrive ${step} command was denied by local permissions`
        : `The Codrive ${step} command failed`,
    );
  }
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

  async install(targetVersion: string): Promise<{ cliPath: string }> {
    await this.runChecked(
      "install",
      this.npmExecutable,
      ["install", "--global", `codrive@${targetVersion}`],
      false,
    );
    const globalRoot = (await this.runChecked(
      "locate",
      this.npmExecutable,
      ["root", "--global"],
      true,
    )).stdout.trim();
    if (!globalRoot) throw new Error("npm did not return its global package root");
    const cliPath = join(
      globalRoot,
      "codrive",
      "dist/interfaces/cli/index.js",
    );
    return { cliPath };
  }

  async stop(cliPath: string, stateDirectory: string): Promise<void> {
    await this.runCliStep("stop", cliPath, "stop", stateDirectory);
  }

  async migrate(cliPath: string, stateDirectory: string): Promise<void> {
    await this.runCliStep("migrate", cliPath, "_migrate-state", stateDirectory);
  }

  async start(cliPath: string, stateDirectory: string): Promise<void> {
    await this.runCliStep("start", cliPath, "start", stateDirectory);
  }

  private async runCliStep(
    step: PackageUpgradeStep,
    cliPath: string,
    command: string,
    stateDirectory: string,
  ): Promise<void> {
    await this.runChecked(
      step,
      this.nodeExecutable,
      [cliPath, command],
      false,
      { ...process.env, CODEDRIVE_HOME: stateDirectory },
    );
  }

  private async runChecked(
    step: PackageUpgradeStep,
    command: string,
    args: string[],
    captureOutput: boolean,
    environment?: NodeJS.ProcessEnv,
  ): Promise<PackageCommandResult> {
    const result = await this.runner.run(command, args, captureOutput, environment);
    if (result.error || result.exitCode !== 0) {
      const diagnostic = [
        result.error?.message,
        result.stderr,
        result.stdout,
      ].filter(Boolean).join("\n");
      throw new PackageCommandError(
        step,
        /EACCES|EPERM|permission denied/i.test(diagnostic)
          ? "permission_denied"
          : "command_failed",
      );
    }
    return result;
  }
}

class SpawnPackageCommandRunner implements PackageCommandRunner {
  async run(
    command: string,
    args: string[],
    captureOutput: boolean,
    environment?: NodeJS.ProcessEnv,
  ): Promise<PackageCommandResult> {
    return new Promise((resolve) => {
      const child = spawn(command, args, {
        stdio: ["inherit", "pipe", "pipe"],
        env: environment,
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout = appendCapturedOutput(stdout, chunk);
        if (!captureOutput) process.stdout.write(chunk);
      });
      child.stderr.on("data", (chunk: string) => {
        stderr = appendCapturedOutput(stderr, chunk);
        if (!captureOutput) process.stderr.write(chunk);
      });
      child.once("error", (error) => {
        resolve({ exitCode: null, stdout, stderr, error });
      });
      child.once("close", (exitCode) => {
        resolve({ exitCode, stdout, stderr });
      });
    });
  }
}

function appendCapturedOutput(current: string, chunk: string): string {
  const combined = current + chunk;
  return combined.length <= maximumCapturedOutputLength
    ? combined
    : combined.slice(-maximumCapturedOutputLength);
}
