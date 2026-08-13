import { spawn } from "node:child_process";

import type {
  UpgradeLauncher,
  UpgradeRequest,
} from "../application/upgrade-coordinator.js";

export class DetachedUpgradeLauncher implements UpgradeLauncher {
  constructor(
    private readonly cliPath: string,
    private readonly nodeExecutable = process.execPath,
  ) {}

  async launch(request: UpgradeRequest): Promise<number> {
    const child = spawn(
      this.nodeExecutable,
      [
        this.cliPath,
        "_upgrade-worker",
        request.operationId,
        request.targetVersion,
      ],
      {
        detached: true,
        stdio: "ignore",
        env: {
          ...process.env,
          CODEDRIVE_HOME: request.stateDirectory,
        },
      },
    );
    child.unref();
    if (child.pid === undefined) {
      throw new Error("Codrive could not start the independent update process");
    }
    return child.pid;
  }
}
