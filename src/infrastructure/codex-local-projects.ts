import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { LocalProject, LocalProjectCatalog, LocalProjectList } from "../domain/local-projects.js";

/** 桌面保存目录只提供定位线索，文件不可用时仍允许普通助理交流。 */
export class CodexLocalProjects implements LocalProjectCatalog {
  constructor(private readonly codexDirectory = process.env.CODEX_HOME ?? join(homedir(), ".codex")) {}

  async read(): Promise<LocalProjectList> {
    let contents: string;
    try {
      contents = await readFile(join(this.codexDirectory, ".codex-global-state.json"), "utf8");
    } catch {
      return { available: false, projects: [], reason: "当前机器的 Codex 保存项目记录不可读取，请按用户给定目录核实。" };
    }
    let saved: unknown;
    try {
      saved = JSON.parse(contents);
    } catch {
      return { available: false, projects: [], reason: "当前 Codex 保存项目格式不可用，请按用户给定目录核实。" };
    }
    if (!isRecord(saved) || !isRecord(saved["local-projects"])) {
      return { available: false, projects: [], reason: "当前 Codex 保存项目格式不可用，请按用户给定目录核实。" };
    }
    const projects: LocalProject[] = [];
    for (const value of Object.values(saved["local-projects"])) {
      if (!isRecord(value) || typeof value.name !== "string" || !Array.isArray(value.rootPaths)) continue;
      projects.push({ name: value.name, rootPaths: value.rootPaths.filter((path): path is string => typeof path === "string") });
    }
    return { available: true, projects };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
