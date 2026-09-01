import { execFile as executeFile } from "node:child_process";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { GitRepositoryPathResolver } from "../../src/infrastructure/git-repository-path-resolver.js";

const execFile = promisify(executeFile);

describe("GitRepositoryPathResolver", () => {
  it("returns the persistent repository root for a linked worktree", async () => {
    const temporaryDirectory = await mkdtemp(
      join(tmpdir(), "codrive-repository-path-"),
    );
    const repositoryPath = join(temporaryDirectory, "product-api");
    const workspacePath = join(repositoryPath, ".worktrees", "task-1");
    await execFile("git", ["init", "--initial-branch=main", repositoryPath]);
    await writeFile(join(repositoryPath, "README.md"), "# Product API\n");
    await execFile("git", ["-C", repositoryPath, "add", "README.md"]);
    await execFile("git", [
      "-C",
      repositoryPath,
      "-c",
      "user.name=Codrive Test",
      "-c",
      "user.email=codrive@example.invalid",
      "commit",
      "-m",
      "Initial commit",
    ]);
    await execFile("git", [
      "-C",
      repositoryPath,
      "worktree",
      "add",
      "-b",
      "task-1",
      workspacePath,
    ]);

    await expect(
      new GitRepositoryPathResolver().resolveWorkspaceRepository(workspacePath),
    ).resolves.toBe(await realpath(repositoryPath));
  });
});
