import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const executeFile = promisify(execFile);

describe("本机 Codex 项目查询", () => {
  let directory: string;

  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "codrive-local-projects-")); });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  async function readProjects() {
    const { stdout } = await executeFile(process.execPath, [
      resolve("skills/codrive-control/scripts/codrive-control.mjs"), "local-projects",
    ], { env: { ...process.env, CODEX_HOME: directory, CODEDRIVE_HOME: join(directory, "no-service") } });
    return JSON.parse(stdout);
  }

  it("按本机保存的工作空间名称返回目录，只投影项目身份，不读取产品登记或泄漏其他桌面状态", async () => {
    await writeFile(join(directory, ".codex-global-state.json"), JSON.stringify({
      "local-projects": {
        workspace: { id: "workspace", name: "pietra-ai-workspace", rootPaths: ["/workspace/pietra-ai-workspace"] },
      },
      "unrelated-private-setting": "private-test-value",
    }));

    const result = await readProjects();
    expect(result).toEqual({
      available: true,
      projects: [{ name: "pietra-ai-workspace", rootPaths: ["/workspace/pietra-ai-workspace"] }],
    });
    expect(JSON.stringify(result)).not.toContain("private-test-value");
  });

  it("未安装桌面端或没有已保存项目时如实返回不可用", async () => {
    expect(await readProjects()).toMatchObject({ available: false, projects: [] });
    await writeFile(join(directory, ".codex-global-state.json"), JSON.stringify({ "active-workspace-roots": ["/workspace/other"] }));
    expect(await readProjects()).toMatchObject({ available: false, projects: [] });
  });
});
