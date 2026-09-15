import { projectMilestoneActivities } from "../../domain/milestone-activity.js";
import type { Milestone, MilestoneActivity } from "../../domain/milestone.js";
import type { ProjectSnapshot } from "../../domain/types.js";
import type { ProjectStore } from "../../infrastructure/project-store.js";
import type { MilestoneView } from "./milestone-presenter.js";

export function createMilestoneView(
  milestone: Milestone,
  activities: readonly MilestoneActivity[],
  taskCount: number,
): MilestoneView {
  const projection = projectMilestoneActivities(activities);
  const latest = projection.latestAssessment;
  const questions = projection.unresolvedActivities.flatMap(activity =>
    activity.type === "resolution" && activity.resolution.question ? [activity.resolution.question] : [],
  );
  return {
    id: milestone.id,
    title: milestone.title,
    description: milestone.description,
    status: milestone.status,
    statusLabel: milestoneStatusLabel(milestone, questions),
    summary: latest?.summary ?? "负责人将根据当前目标梳理工作。",
    questions,
    evidence: latest?.report.evidence ?? [],
    acceptanceCriteria: milestone.acceptanceCriteria,
    threadId: milestone.threadId ?? null,
    taskCount,
  };
}

export async function readMilestoneActivities(
  store: ProjectStore,
  snapshots: readonly ProjectSnapshot[],
): Promise<Map<string, MilestoneActivity[]>> {
  const activityLists = await Promise.all(
    snapshots.map(snapshot => store.listMilestoneActivities(snapshot.project.id)),
  );
  const grouped = new Map<string, MilestoneActivity[]>();
  for (const activities of activityLists) {
    for (const activity of activities) {
      const entries = grouped.get(activity.milestoneId) ?? [];
      entries.push(activity);
      grouped.set(activity.milestoneId, entries);
    }
  }
  return grouped;
}

export function milestoneTaskWait(
  milestone: Milestone,
  activities: readonly MilestoneActivity[],
  taskId: string,
) {
  const unresolved = projectMilestoneActivities(activities).unresolvedActivities;
  const reasons = unresolved.filter(activity =>
    activity.type === "resolution" && activity.resolution.affectedTaskIds?.includes(taskId),
  );
  if (!reasons.length) return null;
  return {
    summary: reasons.map(activity => activity.summary).join("\n"),
    threadId: milestone.threadId ?? null,
  };
}

function milestoneStatusLabel(milestone: Milestone, questions: readonly string[]): string {
  if (milestone.status === "done") return "已完成";
  if (questions.length) return "需要决定";
  const execution = milestone.currentExecution;
  if (execution?.status === "failed") return "评估失败";
  if (execution?.status === "retry_scheduled") return "等待重试";
  if (execution?.status === "running" || execution?.status === "awaiting_report") return "正在评估";
  if (execution?.result?.outcome === "blocked") return "遇到阻塞";
  return "进行中";
}
