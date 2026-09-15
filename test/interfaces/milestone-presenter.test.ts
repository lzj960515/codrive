import { describe, expect, it } from "vitest";
import { createMilestonePresenter } from "../../src/interfaces/http/milestone-presenter.js";

const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");

describe("milestone presentation", () => {
  it("filters milestone and independent tasks without changing task order", () => {
    const view = createMilestonePresenter(escape);
    const tasks = [{ id: "a", milestoneId: "m" }, { id: "b", milestoneId: null }, { id: "c", milestoneId: "m" }];
    expect(view.filterTasks(tasks, "m").map(task => task.id)).toEqual(["a", "c"]);
    expect(view.filterTasks(tasks, "independent").map(task => task.id)).toEqual(["b"]);
    expect(view.filterTasks(tasks, "all")).toEqual(tasks);
  });

  it("shows the actual decision and its conversation while escaping user content", () => {
    const view = createMilestonePresenter(escape);
    const markup = view.cards([{
      id: "m", title: "Social migration", description: "Keep existing results", status: "active", statusLabel: "需要决定",
      summary: "Investigating another consumer", questions: ["Keep <export>?"],
      evidence: [], acceptanceCriteria: ["Existing scenarios work"], threadId: "thread-1", taskCount: 3,
    }]);
    expect(markup).toContain("Social migration");
    expect(markup).toContain("Keep &lt;export>?");
    expect(markup).toContain("codex://threads/thread-1");
    expect(markup).toContain("需要决定");
    expect(markup).not.toContain("reportOpportunityId");
  });

  it("surfaces pending decisions on the board with a link to the milestone", () => {
    const view = createMilestonePresenter(escape);
    const notice = view.notices([{
      id: "m", title: "Social", description: "Migration", status: "active", statusLabel: "需要决定",
      summary: "Inspect consumers", questions: ["Keep old report?"], evidence: [],
      acceptanceCriteria: [], threadId: "thread", taskCount: 2,
    }], "project");
    expect(notice).toContain("Keep old report?");
    expect(notice).toContain('/projects/project#milestone-m');
  });

  it("presents goal evidence as completion rather than task-count progress", () => {
    const view = createMilestonePresenter(escape);
    const markup = view.cards([{
      id: "m", title: "Social migration", description: "Move social", status: "done", statusLabel: "已完成",
      summary: "Verified the deployed flow", questions: [], evidence: ["Export verified"],
      acceptanceCriteria: ["Flow works"], threadId: null, taskCount: 4,
    }]);
    expect(markup).toContain("已完成");
    expect(markup).toContain("Export verified");
    expect(markup).not.toContain("100%");
  });
});
