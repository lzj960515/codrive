import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { DetachedUpgradeLauncher } from "../../src/infrastructure/detached-upgrade-launcher.js";

describe("DetachedUpgradeLauncher", () => {
  it("hands a fixed target and CODEDRIVE_HOME to an independent worker process", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codrive-upgrade-process-"));
    const outputPath = join(directory, "worker.json");
    const scriptPath = join(directory, "worker.mjs");
    await writeFile(
      scriptPath,
      `import { writeFileSync } from "node:fs";\n` +
        `writeFileSync(${JSON.stringify(outputPath)}, JSON.stringify({ args: process.argv.slice(2), stateDirectory: process.env.CODEDRIVE_HOME, pid: process.pid }));\n`,
      "utf8",
    );
    const launcher = new DetachedUpgradeLauncher(scriptPath, process.execPath);

    const pid = await launcher.launch({
      operationId: "upgrade_process",
      targetVersion: "0.7.0",
      stateDirectory: directory,
    });
    await waitForFile(outputPath);
    const observed = JSON.parse(await readFile(outputPath, "utf8")) as {
      args: string[];
      stateDirectory: string;
      pid: number;
    };

    expect(observed).toEqual({
      args: ["_upgrade-worker", "upgrade_process", "0.7.0"],
      stateDirectory: directory,
      pid,
    });
    expect(pid).not.toBe(process.pid);
  });
});

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() <= deadline) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Detached worker did not write ${path}`);
}
