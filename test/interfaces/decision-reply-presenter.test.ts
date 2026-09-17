import { describe, expect, it } from "vitest";
import { createDecisionReplyPresenter } from "../../src/interfaces/http/decision-reply-presenter.js";
import { createMilestonePresenter, type MilestoneView } from "../../src/interfaces/http/milestone-presenter.js";

const escapeHtml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
const actions = createDecisionReplyPresenter(escapeHtml);

describe("decision reply presentation", () => {
  it.each(["task", "project", "milestone"] as const)("binds a %s reply to its current report and retains the Codex link", scope => {
    const markup = actions({ scope, id: "current-id", reportOpportunityId: "report-current" }, 'Continue <release> "now"?', "codex-thread");
    expect(markup).toContain('href="codex://threads/codex-thread"');
    expect(markup).toContain("前往对应对话回复");
    expect(markup).toContain("在此回复");
    expect(markup).toContain('&quot;reportOpportunityId&quot;:&quot;report-current&quot;');
    expect(markup).toContain('data-decision-question="Continue &lt;release> &quot;now&quot;?"');
  });

  it("keeps a normal conversation link without offering replies to a past decision", () => {
    expect(actions(null, "Past decision", "past-thread", "打开对话")).not.toContain("data-decision-reply");
    expect(actions(null, "Past decision", "past-thread", "打开对话")).toContain("打开对话");
  });

  it("offers one reply for a milestone's current unresolved questions", () => {
    const milestone: MilestoneView = {
      id: "m", title: "Release", description: "Release flow", status: "active", statusLabel: "需要决定",
      summary: "Ready", questions: ["继续发布？", "使用新域名？"], evidence: [], acceptanceCriteria: [],
      threadId: "thread", taskCount: 1,
      decisionReply: { scope: "milestone", id: "m", reportOpportunityId: "report" },
    };
    const markup = createMilestonePresenter(escapeHtml, actions).detail(milestone, "");
    expect(markup.match(/data-decision-reply=/g)).toHaveLength(1);
    expect(markup).toContain("继续发布？\n\n使用新域名？");
    const completed = createMilestonePresenter(escapeHtml, actions).detail({ ...milestone, status: "done", questions: [], decisionReply: null }, "");
    expect(completed).not.toContain("在此回复");
  });
});
