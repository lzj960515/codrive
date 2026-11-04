import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { CodexLocalProjects } from "../../src/infrastructure/codex-local-projects.js";
import { ProjectStore } from "../../src/infrastructure/project-store.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function directory(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "codrive-local-projects-"));
  directories.push(value);
  return value;
}

describe("Codex 保存的本机工作空间", () => {
  it("只投影工作空间名称和根目录，不把桌面其他状态或产品内容混入目录", async () => {
    const root = await directory();
    await writeFile(join(root, ".codex-global-state.json"), JSON.stringify({
      "local-projects": {
        workspace: { name: "pietra-ai-workspace", rootPaths: ["/work/pietra-ai-workspace", 1], unrelated: "不应公开的桌面字段" },
        invalid: { name: 123, rootPaths: [] },
      },
      privateState: "其他桌面状态",
    }));
    expect(await new CodexLocalProjects(root).read()).toEqual({
      available: true,
      projects: [{ name: "pietra-ai-workspace", rootPaths: ["/work/pietra-ai-workspace"] }],
    });
  });

  it.each([undefined, "{broken", JSON.stringify({ "local-projects": [] })])(
    "保存目录缺失或格式不可用时明确返回不可用，允许普通聊天继续：%s",
    async (contents) => {
      const root = await directory();
      if (contents !== undefined) await writeFile(join(root, ".codex-global-state.json"), contents);
      const result = await new CodexLocalProjects(root).read();
      expect(result.available).toBe(false);
      expect(result.projects).toEqual([]);
      if (result.available) throw new Error("本用例的保存目录应不可用");
      expect(result.reason).toEqual(expect.any(String));
    },
  );

  it("只读取产品身份，即使任务正文存储不可读仍能列出已登记产品", async () => {
    const root = await directory();
    const store = new ProjectStore(root);
    const { project } = await store.createProject({
      name: "Pietra Social / Pulse",
      repositoryPath: "/work/pietra-ai-workspace",
      defaultBranch: "main",
      productDocument: "# Pulse\n与同目录工作空间分别登记的业务产品。",
      tasks: [],
    });
    const created = { ...project, scheduling: "paused" as const, archivedAt: "2026-11-01T00:00:00.000Z" };
    await store.saveProject(created);
    await writeFile(join(store.projectDirectory(project.id), "tasks", "broken.json"), "不是任务JSON");
    await mkdir(join(root, "projects", "removed-project"));
    expect(await store.listProjectIdentities()).toEqual([{
      id: project.id,
      name: "Pietra Social / Pulse",
      repositoryPath: "/work/pietra-ai-workspace",
      status: "active",
      scheduling: "paused",
      archivedAt: "2026-11-01T00:00:00.000Z",
    }]);
  });
});
