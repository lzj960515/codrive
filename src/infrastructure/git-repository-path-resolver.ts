import { execFile as executeFile } from "node:child_process";
import { dirname } from "node:path";
import { promisify } from "node:util";

import type { RepositoryPathResolver } from "../application/repository-path-resolver.js";

const execFile = promisify(executeFile);

export class GitRepositoryPathResolver implements RepositoryPathResolver {
  public async resolveWorkspaceRepository(workspacePath: string): Promise<string> {
    const { stdout } = await execFile(
      "git",
      [
        "-C",
        workspacePath,
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ],
      { encoding: "utf8", maxBuffer: 1024 * 1024 },
    );
    const commonDirectory = stdout.trim();
    if (!commonDirectory) {
      throw new Error(`Git did not resolve a repository for ${workspacePath}`);
    }
    return dirname(commonDirectory);
  }
}
