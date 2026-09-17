import type { DecisionReplyTarget } from "../../domain/decision-reply.js";

export interface MilestoneView {
  id: string;
  title: string;
  description: string;
  status: "active" | "done";
  statusLabel: string;
  summary: string;
  questions: string[];
  evidence: string[];
  acceptanceCriteria: string[];
  threadId: string | null;
  taskCount: number;
  decisionReply: DecisionReplyTarget | null;
}

/** 此函数同时供页面内联脚本和展示行为测试使用。 */
export function createMilestonePresenter(
  escapeHtml: (value: string) => string,
  decisionActions: (target: DecisionReplyTarget | null | undefined, question: string, threadId: string | null, conversationLabel: string) => string,
) {
  function filterTasks<T extends { milestoneId?: string | null }>(tasks: T[], selected: string): T[] {
    return tasks.filter(task => selected === "all" || task.milestoneId === selected);
  }

  function state(milestone: MilestoneView): string {
    return milestone.questions.length ? "decision" : milestone.status;
  }

  function summary(milestone: MilestoneView): string {
    return milestone.questions[0] || milestone.summary;
  }

  function activeFilters(milestones: MilestoneView[], selected: string): string {
    const active = milestones.filter(milestone => milestone.status === "active");
    const goals = active.map(milestone =>
      '<div class="milestone-filter-card" data-state="' + state(milestone) + '">' +
      '<div class="milestone-filter-heading"><button class="milestone-filter" type="button" data-milestone-filter="' + escapeHtml(milestone.id) + '" aria-pressed="' + (selected === milestone.id) + '" title="' + escapeHtml(milestone.title) + '"><strong>' + escapeHtml(milestone.title) + '</strong></button>' +
      '<button class="milestone-detail-link" type="button" data-open-milestone="' + escapeHtml(milestone.id) + '" aria-label="查看' + escapeHtml(milestone.title) + '详情">详情</button>' +
      '<span class="milestone-state">' + escapeHtml(milestone.statusLabel) + '</span></div>' +
      '<span class="milestone-excerpt" title="' + escapeHtml(summary(milestone)) + '">' + escapeHtml(summary(milestone)) + '</span></div>',
    ).join("");
    if (!active.length) return "";
    return '<nav class="milestone-filters" aria-label="筛选任务"><div class="milestone-filter-options">' + goals + '</div><button class="milestone-reset" type="button" data-milestone-filter="all"' + (selected === "all" ? ' disabled' : '') + '>重置</button></nav>';

  }

  function list(milestones: MilestoneView[], filter: "all" | "active" | "done"): string {
    const filters = [{ id: "all", title: "全部" }, { id: "active", title: "活动中" }, { id: "done", title: "已完成" }].map(option =>
      '<button type="button" data-milestone-status="' + option.id + '" aria-pressed="' + (filter === option.id) + '">' + option.title + '</button>',
    ).join("");
    const visible = milestones.filter(milestone => filter === "all" || milestone.status === filter);
    const rows = visible.map(milestone =>
      '<button class="milestone-row" type="button" data-open-milestone="' + escapeHtml(milestone.id) + '" data-state="' + state(milestone) + '">' +
      '<span class="milestone-heading"><strong>' + escapeHtml(milestone.title) + '</strong><span class="milestone-state">' + escapeHtml(milestone.statusLabel) + '</span></span>' +
      '<span class="milestone-excerpt">' + escapeHtml(summary(milestone)) + '</span>' +
      '<span class="milestone-task-count">' + milestone.taskCount + ' 项任务</span><span class="milestone-row-arrow" aria-hidden="true">→</span></button>',
    ).join("");
    return '<section class="milestone-list" aria-label="里程碑"><nav class="milestone-status-filters" aria-label="按状态筛选里程碑">' + filters + '</nav>' +
      '<div class="milestone-rows">' + (rows || '<p class="milestone-empty">' + (filter === "done" ? '还没有已完成的里程碑' : filter === "active" ? '当前没有活动中的里程碑' : '还没有里程碑，独立任务可以照常推进') + '</p>') + '</div></section>';
  }

  function criteria(items: string[], complete = false): string {
    return '<ul class="criteria-list' + (complete ? ' complete' : '') + '">' + items.map(item =>
      '<li><i aria-hidden="true">' + (complete ? '✓' : '') + '</i><span>' + escapeHtml(item) + '</span></li>',
    ).join("") + '</ul>';
  }

  function detail(milestone: MilestoneView, tasksMarkup: string): string {
    const conversation = decisionActions(milestone.decisionReply, milestone.questions.join("\n\n"), milestone.threadId, milestone.questions.length ? "前往负责人对话决定" : "打开负责人对话");
    const questions = milestone.questions.length
      ? '<section class="milestone-questions" aria-label="需要决定">' + milestone.questions.map(question => '<p class="milestone-question">' + escapeHtml(question) + '</p>').join("") + '</section>'
      : '';
    return '<header class="detail-head"><strong>里程碑详情</strong><button id="close-detail" class="icon-button" type="button" aria-label="关闭里程碑详情">×</button></header>' +
      '<div class="detail-body milestone-detail" data-state="' + state(milestone) + '"><div class="detail-status"><span></span>' + escapeHtml(milestone.statusLabel) + '</div>' +
      '<h2>' + escapeHtml(milestone.title) + '</h2><p class="detail-description">' + escapeHtml(milestone.summary) + '</p>' + questions + conversation +
      '<section class="detail-section"><h3>目标</h3><p class="detail-description">' + escapeHtml(milestone.description) + '</p></section>' +
      '<section class="detail-section"><h3>验收标准 <span>' + milestone.acceptanceCriteria.length + '</span></h3>' +
      (milestone.acceptanceCriteria.length ? criteria(milestone.acceptanceCriteria, milestone.status === "done") : '<p class="detail-description">尚未设置验收标准</p>') + '</section>' +
      '<section class="detail-section"><h3>结果依据</h3>' + (milestone.evidence.length ? criteria(milestone.evidence) : '<p class="detail-description">尚无验收依据</p>') + '</section>' +
      '<section class="detail-section"><h3>关联任务 <span>' + milestone.taskCount + '</span></h3>' + (tasksMarkup || '<p class="detail-description">尚无关联任务</p>') + '</section></div>';
  }

  return { filterTasks, activeFilters, list, detail };
}
