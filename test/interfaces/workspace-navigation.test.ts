import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { renderBoardClient } from "../../src/interfaces/http/board-client.js";

const milestone = {
  id: "goal", title: "首版可用", description: "完成问候页面", status: "done",
  statusLabel: "已完成", summary: "独立验收通过", questions: [], evidence: ["问候验证通过"],
  acceptanceCriteria: ["显示问候"], threadId: null, taskCount: 1,
};
const task = {
  id: "task", projectId: "archived", milestoneId: "goal", milestoneTitle: "首版可用",
  title: "实现问候", description: "显示 Hello World", status: "done", displayStatus: "done",
  acceptanceCriteria: ["显示问候"], reviewCount: 1, cancellation: null as { reason: string } | null,
};
const archived = {
  project: {
    id: "archived", name: "完成的项目", status: "active", displayStatus: "archived",
    archivedAt: "2026-09-15T00:00:00Z", scheduling: "paused", planning: { status: "idle" },
  },
  tasks: [task], milestones: [milestone],
};

// 只替代 DOM 的输出容器；真实内联客户端负责读 API、URL、选择状态和详情渲染。
class OutputElement {
  innerHTML = "";
  textContent = "";
  scrollTop = 0;
  hidden = false;
  style: Record<string, string> = {};
  attributes = new Map<string, string>();
  classes = new Set<string>();
  classList = {
    add: (name: string) => this.classes.add(name),
    remove: (name: string) => this.classes.delete(name),
    contains: (name: string) => this.classes.has(name),
  };
  onclick: (() => void) | null = null;
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  querySelector(selector: string): OutputElement | null {
    return selector === "[data-project-info]" ? this : null;
  }
  querySelectorAll() { return []; }
  focus() {}
  addEventListener() {}
}

function client(search: string, snapshot = archived) {
  const elements = new Map<string, OutputElement>();
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, new OutputElement());
    return elements.get(id)!;
  };
  const body = new OutputElement();
  let location = "/" + search;
  const responses: Record<string, unknown> = {
    "/api/board": [],
    "/api/board/archived": { projects: [snapshot] },
    "/api/board/projects/archived": snapshot,
    "/api/tasks/task": { task, activities: [], currentDecisionRequest: null },
  };
  const context = createContext({
    URLSearchParams, HTMLElement: OutputElement,
    document: {
      body, activeElement: null, scrollingElement: null,
      getElementById: (id: string) => id === "current-execution-activity" ? null : element(id),
      querySelector: () => null, querySelectorAll: () => [], addEventListener() {},
    },
    window: {
      location: { pathname: "/", search },
      history: { replaceState: (_state: unknown, _title: string, url: string) => { location = url; } },
    },
    localStorage: { getItem: () => null, setItem() {} },
    io: () => ({ connected: false, on() {} }),
    fetch: async (path: string) => {
      if (!(path in responses)) throw new Error("Unexpected request: " + path);
      return { ok: true, json: async () => responses[path] };
    },
  });
  const script = renderBoardClient("test").slice("<script>".length).replace(/<\/script>$/, "");
  const startup = script.lastIndexOf("    void (async () => {");
  runInContext(script.slice(0, startup), context);
  return { element, body, location: () => location, run: (code: string) => runInContext(code, context) };
}

describe("workspace navigation", () => {
  it("keeps archived milestone history reachable after initial and scoped refreshes", async () => {
    const page = client("?project=archived&tab=milestones&milestone=goal");
    await page.run("refresh()");
    expect(page.element("offline").style.display).toBe("none");
    expect(page.element("archived-project-list").innerHTML).toContain("/?project=archived&tab=milestones");
    expect(page.element("project").innerHTML).toContain("完成的项目");
    expect(page.element("project").innerHTML).not.toMatch(/data-project-action="(?:pause|replan|archive)"/);
    expect(page.element("task-detail-content").innerHTML).toContain("问候验证通过");
    expect(page.element("task-detail-content").innerHTML).toContain('data-task="task"');
    await page.run("refreshProjectLists()");
    await page.run("refreshSelectedProject()");
    expect(page.location()).toContain("milestone=goal");
    expect(page.element("task-detail-content").innerHTML).toContain("问候验证通过");
  });

  it("restores a task URL with its milestone parent and returns to the same goal", async () => {
    const page = client("?project=archived&tab=milestones&status=done&milestone=goal&task=task");
    await page.run("refresh()");
    expect(page.element("offline").style.display).toBe("none");
    expect(page.body.classes.has("detail-open")).toBe(true);
    expect(page.element("task-detail").attributes.get("aria-label")).toBe("任务详情");
    expect(page.element("task-detail-content").innerHTML).toContain("显示 Hello World");
    expect(page.element("task-detail-content").innerHTML).toContain("data-back-milestone");
    page.run("returnToMilestone()");
    expect(page.location()).toContain("status=done");
    expect(page.location()).toContain("milestone=goal");
    expect(new URLSearchParams(page.location().split("?")[1]).has("task")).toBe(false);
    expect(page.element("task-detail").attributes.get("aria-label")).toBe("里程碑详情");
    expect(page.element("task-detail-content").innerHTML).toContain("问候验证通过");
  });

  it("routes archived projects without milestones to the complete task board", async () => {
    const page = client("?project=archived", {
      ...archived, milestones: [], tasks: [{ ...task, milestoneId: "", milestoneTitle: "" }],
    });
    await page.run("refresh()");
    expect(page.element("offline").style.display).toBe("none");
    expect(page.element("archived-project-list").innerHTML).toContain("/?project=archived");
    expect(page.element("project").innerHTML).toContain("实现问候");
  });

  it("filters task ownership without hiding completed or cancelled work", async () => {
    const page = client("?project=archived", {
      ...archived, milestones: [{ ...milestone, status: "active" }, { ...milestone, id: "past", title: "旧里程碑" }],
      tasks: [task, { ...task, id: "independent", title: "独立完成项", milestoneId: "", milestoneTitle: "" },
        { ...task, id: "cancelled", title: "独立取消项", milestoneId: "", milestoneTitle: "", status: "cancelled", cancellation: { reason: "测试取消" } },
        { ...task, id: "past-task", title: "旧里程碑任务", milestoneId: "past" }],
    });
    await page.run("refresh()");
    const all = page.element("project").innerHTML;
    expect(all).toContain('data-milestone-filter="all" disabled>重置</button>');
    expect(all).toContain("实现问候");
    expect(all).toContain("独立完成项");
    expect(all).toContain("独立取消项");
    expect(all).toContain("旧里程碑任务");
    expect(all).not.toContain('data-milestone-filter="past"');
    expect(all).not.toContain('data-milestone-filter="independent"');
    expect(all).not.toContain("独立任务历史");
    expect(all).not.toContain("filter-label");
    page.run('selectTaskScope("goal")');
    const goal = page.element("project").innerHTML;
    expect(goal).toContain('data-milestone-filter="goal" aria-pressed="true"');
    expect(goal).toContain('data-column="done"');
    expect(goal).toContain('data-column="cancelled"');
    expect(goal).toContain("实现问候");
    expect(goal).not.toContain("独立完成项");
    expect(goal).not.toContain("workspace-task-tools");
    page.run('selectTaskScope("all")');
    expect(page.element("project").innerHTML).toContain("独立完成项");
    expect(page.element("project").innerHTML).toContain("旧里程碑任务");
  });
});
