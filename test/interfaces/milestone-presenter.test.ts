import { describe, expect, it } from "vitest";
import { createMilestonePresenter, type MilestoneView } from "../../src/interfaces/http/milestone-presenter.js";

const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
const goal = (overrides: Partial<MilestoneView> = {}): MilestoneView => ({
  id: "m", title: "Social migration", description: "Keep existing results", status: "active", statusLabel: "需要决定",
  summary: "Investigating another consumer", questions: ["Keep <export>?"], evidence: [],
  acceptanceCriteria: ["Existing scenarios work"], threadId: "thread-1", taskCount: 3, ...overrides,
});

describe("milestone presentation", () => {
  it("filters milestones without changing task order", () => {
    const view = createMilestonePresenter(escape);
    const tasks = [{ id: "a", milestoneId: "m" }, { id: "b", milestoneId: null }, { id: "c", milestoneId: "m" }];
    expect(view.filterTasks(tasks, "m").map(task => task.id)).toEqual(["a", "c"]);
    expect(view.filterTasks(tasks, "all")).toEqual(tasks);
  });

  it("includes all task statuses in every ownership filter", () => {
    const view = createMilestonePresenter(escape);
    const tasks = [
      { id: "active", milestoneId: "m", status: "working" },
      { id: "completed", milestoneId: "m", status: "done" },
      { id: "independent", milestoneId: null, status: "done" },
      { id: "cancelled", milestoneId: null, status: "cancelled" },
      { id: "queued", milestoneId: null, status: "backlog" },
    ];
    expect(view.filterTasks(tasks, "all")).toEqual(tasks);
    expect(view.filterTasks(tasks, "m").map(task => task.id)).toEqual(["active", "completed"]);
  });

  it("separates active goal selection from an adjacent detail action", () => {
    const view = createMilestonePresenter(escape);
    const markup = view.activeFilters([goal(), goal({ id: "past", title: "Past goal", status: "done" })], "m");
    expect(markup).not.toContain("filter-label");
    expect(markup).toContain('data-milestone-filter="all">重置</button>');
    expect(markup).not.toContain("全部未完成");
    expect(markup).not.toContain("独立任务");
    expect(markup).toContain("Keep &lt;export>?");
    expect(markup).toContain('data-milestone-filter="m" aria-pressed="true"');
    expect(markup).not.toContain("Past goal");
    expect(markup.match(/data-open-milestone="m"/g)).toHaveLength(1);
    expect(markup).toMatch(/<button[^>]*data-milestone-filter="m"[^>]*>[\s\S]*?<\/button><button[^>]*data-open-milestone="m"/);
    expect(markup).toContain('class="milestone-excerpt"');
    expect(markup).toContain('class="milestone-filter-card"');
    expect(markup).not.toContain("查看全部里程碑");
  });

  it("retains milestone access when no goal is selected", () => {
    const view = createMilestonePresenter(escape);
    const markup = view.activeFilters([goal()], "");
    expect(markup).toContain('data-milestone-filter="m" aria-pressed="false"');
    expect(markup).toContain('data-open-milestone="m"');
    expect(markup).not.toContain('aria-pressed="true"');
    expect(view.activeFilters([goal()], "all")).toContain('data-milestone-filter="all" disabled>重置</button>');
    expect(view.activeFilters([], "all")).toBe("");
  });

  it("keeps the full milestone collection discoverable with status filters", () => {
    const view = createMilestonePresenter(escape);
    const goals = [goal(), goal({ id: "past", title: "Past goal", status: "done", statusLabel: "已完成", questions: [] })];
    const all = view.list(goals, "all");
    expect(all).toContain("Social migration");
    expect(all).toContain("Past goal");
    expect(all.match(/data-open-milestone=/g)).toHaveLength(2);
    const done = view.list(goals, "done");
    expect(done).toContain('data-milestone-status="done" aria-pressed="true"');
    expect(done).toContain("Past goal");
    expect(done).not.toContain("Social migration");
    expect(view.list(goals, "active")).not.toContain("Past goal");
  });

  it("shows goal, criteria, evidence and full tasks directly in the familiar detail panel", () => {
    const view = createMilestonePresenter(escape);
    const markup = view.detail(goal({ evidence: ["Export <verified>"] }), '<button data-task="a">Completed task</button>');
    expect(markup).toContain('class="detail-head"');
    expect(markup).toContain('aria-label="关闭里程碑详情"');
    expect(markup).toContain("Keep existing results");
    expect(markup).toContain("Existing scenarios work");
    expect(markup).toContain("Export &lt;verified>");
    expect(markup).toContain("Keep &lt;export>?");
    expect(markup).toContain("codex://threads/thread-1");
    expect(markup).toContain('<button data-task="a">Completed task</button>');
    expect(markup).not.toContain("<details");
    expect(markup).not.toContain("reportOpportunityId");
  });

  it("presents goal acceptance independently of task-count progress", () => {
    const view = createMilestonePresenter(escape);
    const markup = view.detail(goal({ status: "done", statusLabel: "已完成", questions: [], threadId: null, evidence: ["Flow verified"] }), "");
    expect(markup).toContain("已完成");
    expect(markup).toContain("Flow verified");
    expect(markup).not.toContain("100%");
    expect(markup).not.toContain("等待负责人开始");
  });
});
