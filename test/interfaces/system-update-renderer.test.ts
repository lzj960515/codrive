import { describe, expect, it } from "vitest";

import { createSystemUpdateRenderer } from "../../src/interfaces/http/system-update-renderer.js";

describe("SystemUpdateRenderer", () => {
  it("renders a missing Hook independently without treating rendering as a read failure", () => {
    const view = createView();

    const result = view.render(systemUpdate("current", "missing"), null);

    expect(result).toEqual({ shouldPoll: false, resourcesInstalled: false });
    expect(view.element("update-skills").textContent).toBe("4 / 4 已对齐");
    expect(view.element("update-hook").textContent).toBe("待补齐");
    expect(view.element("update-summary").textContent).toBe(
      "Codrive 已安装；需要从当前包补齐 1 个托管 Hook。",
    );
    expect(view.element("update-primary").textContent).toBe("补齐托管资源");
    expect(view.element("update-primary").disabled).toBe(false);
    expect(view.element("update-status").textContent).toBe("");
  });

  it("shows both resources as current and disables the completed action", () => {
    const view = createView();

    view.render(systemUpdate("current", "current"), null);

    expect(view.element("update-skills").textContent).toBe("4 / 4 已对齐");
    expect(view.element("update-hook").textContent).toBe("1 / 1 已对齐");
    expect(view.element("update-primary").textContent).toBe("已是最新版");
    expect(view.element("update-primary").disabled).toBe(true);
  });

  it("identifies a Hook conflict without collapsing it into the Skill state", () => {
    const view = createView();

    view.render(systemUpdate("current", "conflict"), null);

    expect(view.element("update-skills").textContent).toBe("4 / 4 已对齐");
    expect(view.element("update-hook").textContent).toBe("存在冲突");
    expect(view.element("update-conflict").innerHTML).toContain(
      "保留了本地 Codex Hook",
    );
    expect(view.element("update-primary").disabled).toBe(true);
  });
});

function createView() {
  const elements = new Map<string, FakeElement>();
  const element = (id: string) => {
    let found = elements.get(id);
    if (!found) {
      found = new FakeElement();
      elements.set(id, found);
    }
    return found;
  };
  return {
    element,
    render: createSystemUpdateRenderer({
      getElementById: (id) => element(id),
      label: (state) => ({
        missing: "待补齐",
        outdated: "待同步",
        current: "已对齐",
        conflict: "存在冲突",
      })[state] ?? state,
      formatTime: (value) => value ?? "—",
      escapeHtml: (value) => String(value),
    }),
  };
}

function systemUpdate(
  skillState: "missing" | "outdated" | "current" | "conflict",
  hookState: "missing" | "outdated" | "current" | "conflict",
) {
  const resourcesState = [skillState, hookState].includes("conflict")
    ? "conflict"
    : [skillState, hookState].includes("missing")
      ? "missing"
      : [skillState, hookState].includes("outdated")
        ? "outdated"
        : "current";
  const skills = {
    state: skillState,
    bundledVersion: "0.7.1",
    installedVersion: skillState === "missing" ? null : "0.7.1",
    managedSkillCount: 4,
    conflictPaths: skillState === "conflict" ? ["/skills/codrive-task"] : [],
  };
  const hook = {
    state: hookState,
    bundledVersion: "0.7.1",
    installedVersion: hookState === "missing" ? null : "0.7.1",
    managedHookCount: 1,
    conflictPaths: hookState === "conflict" ? ["/hooks.json"] : [],
  };
  return {
    version: {
      currentVersion: "0.7.1",
      latestVersion: "0.7.1",
      updateAvailable: false,
      lastCheckedAt: "2026-08-17T00:00:00.000Z",
      lastSuccessfulCheckAt: "2026-08-17T00:00:00.000Z",
      checkError: null,
      checking: false,
    },
    upgrade: null,
    resources: {
      state: resourcesState,
      bundledVersion: "0.7.1",
      managedSkillCount: 4,
      managedHookCount: 1,
      conflictPaths: [...skills.conflictPaths, ...hook.conflictPaths],
      skills,
      hook,
    },
    skills,
    hook,
  };
}

class FakeElement {
  textContent = "";
  innerHTML = "";
  hidden = false;
  disabled = false;
  readonly dataset: Record<string, string> = {};
  readonly style = { width: "" };
}
