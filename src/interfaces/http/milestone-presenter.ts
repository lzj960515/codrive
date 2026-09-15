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
}

/** 此函数同时供页面内联脚本和展示行为测试使用。 */
export function createMilestonePresenter(escapeHtml: (value: string) => string) {
  function filterTasks<T extends { milestoneId?: string | null }>(tasks: T[], selected: string): T[] {
    if (selected === "all") return tasks;
    return tasks.filter(task => selected === "independent" ? !task.milestoneId : task.milestoneId === selected);
  }

  function filters(milestones: MilestoneView[], selected: string): string {
    if (!milestones.length) return "";
    const options = [{ id: "all", title: "全部任务" }, ...milestones, { id: "independent", title: "独立任务" }];
    return '<nav class="milestone-filters" aria-label="按里程碑筛选任务">' + options.map(option =>
      '<button type="button" data-milestone-filter="' + escapeHtml(option.id) + '" aria-pressed="' + (selected === option.id) + '">' + escapeHtml(option.title) + '</button>',
    ).join("") + '</nav>';
  }

  function cards(milestones: MilestoneView[]): string {
    if (!milestones.length) return "";
    return '<section class="milestone-section" aria-label="里程碑"><div class="milestone-section-heading"><span>阶段目标</span><b>' + milestones.length + ' 个里程碑</b></div><div class="milestone-grid">' + milestones.map(card).join("") + '</div></section>';
  }

  function card(milestone: MilestoneView): string {
    const state = milestone.statusLabel;
    const questions = milestone.questions.map(question => '<p class="milestone-question">' + escapeHtml(question) + '</p>').join("");
    const criteria = milestone.acceptanceCriteria.map(criterion => '<li>' + escapeHtml(criterion) + '</li>').join("");
    const evidence = milestone.evidence.map(item => '<li>' + escapeHtml(item) + '</li>').join("");
    const conversation = milestone.threadId
      ? '<a class="milestone-conversation" href="codex://threads/' + escapeHtml(milestone.threadId) + '">' + (milestone.questions.length ? '前往对话决定' : '打开负责人对话') + ' ↗</a>'
      : '<span class="milestone-conversation pending">等待负责人开始</span>';
    return '<article class="milestone-card" id="milestone-' + escapeHtml(milestone.id) + '" data-state="' + (milestone.questions.length ? 'decision' : milestone.status) + '">' +
      '<div class="milestone-card-heading"><h2>' + escapeHtml(milestone.title) + '</h2><span>' + state + '</span></div>' +
      '<p class="milestone-summary">' + escapeHtml(milestone.summary) + '</p>' + questions +
      '<details class="milestone-goal"><summary>目标与验收</summary><p>' + escapeHtml(milestone.description) + '</p><ul>' + criteria + '</ul>' +
      (evidence ? '<h3>结果依据</h3><ul>' + evidence + '</ul>' : '') + '</details>' +
      '<footer><button type="button" data-milestone-filter="' + escapeHtml(milestone.id) + '">查看 ' + milestone.taskCount + ' 项工作 →</button>' + conversation + '</footer></article>';
  }

  function notices(milestones: MilestoneView[], projectId: string): string {
    return milestones.filter(milestone => milestone.questions.length || ["评估失败", "遇到阻塞"].includes(milestone.statusLabel)).map(milestone =>
      '<div class="planning-notice decision_requested"><b>' + escapeHtml(milestone.title) + '</b><span>' + escapeHtml(milestone.questions[0] || milestone.statusLabel + '：' + milestone.summary) + '</span><a href="/projects/' + encodeURIComponent(projectId) + '#milestone-' + encodeURIComponent(milestone.id) + '">查看里程碑</a></div>',
    ).join("");
  }

  return { filterTasks, filters, cards, notices };
}
