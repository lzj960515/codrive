import {
  milestoneDecisionReply,
  projectDecisionReply,
  taskDecisionReply,
  type DecisionReplyTarget,
} from "../domain/decision-reply.js";
import { projectMilestoneActivities } from "../domain/milestone-activity.js";
import type { MilestoneActivity } from "../domain/milestone.js";
import type { SlackDeliveryRecord } from "../domain/slack-state.js";
import type { Project, Task, TaskActivity } from "../domain/types.js";
import type { SlackReplyTarget } from "../domain/work-source.js";
import type { ConfigStore } from "../infrastructure/config-store.js";
import type { ProjectStore } from "../infrastructure/project-store.js";
import type { SlackStateStore } from "../infrastructure/slack-state-store.js";
import type { SlackPendingDecision } from "../domain/slack.js";
import type { SlackDeliveryService } from "./slack-delivery.js";

interface SlackNotificationsOptions {
  projects: ProjectStore;
  configStore: ConfigStore;
  state: SlackStateStore;
  deliveries: SlackDeliveryService;
  onError(error: unknown): void;
}

/** 观察已保存的业务结果；通知失败只影响送达，不回写开发阶段或重新执行工作。 */
export class SlackNotifications {
  private queue: Promise<void> = Promise.resolve();
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly options: SlackNotificationsOptions) {}

  async start(): Promise<void> {
    if (this.unsubscribe) return;
    this.unsubscribe = this.options.projects.subscribe((event) => {
      this.enqueue(event.projectId);
    });
    for (const { project } of await this.options.projects.listProjects()) {
      this.enqueue(project.id);
    }
    await this.queue;
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    await this.queue;
  }

  async pendingDecisions(target: SlackReplyTarget): Promise<SlackPendingDecision[]> {
    await this.queue;
    const config = await this.options.configStore.read();
    if (!config.slack?.enabled || target.teamId !== config.slack.teamId) return [];
    const pending = new Map<string, SlackPendingDecision>();
    for (const delivery of await this.options.state.listDeliveries()) {
      if (!delivery.sentAt || !delivery.decision || !this.isReplyDestination(delivery, target)) continue;
      const current = await this.currentQuestion(delivery.decision);
      if (current && current.reportOpportunityId === delivery.decision.reportOpportunityId) {
        pending.set(`${current.scope}:${current.id}:${current.reportOpportunityId}`, current);
      }
    }
    return [...pending.values()];
  }

  private enqueue(projectId: string): void {
    // Store 的同步订阅回调只排队，外部发送不占用业务状态转换。
    this.queue = this.queue.then(() => this.notifyProject(projectId)).catch(this.options.onError);
  }

  private async notifyProject(projectId: string): Promise<void> {
    const config = await this.options.configStore.read();
    const slack = config.slack;
    if (!slack?.enabled) return;
    const snapshot = await this.options.projects.getProject(projectId);
    if (!snapshot) return;
    const taskActivities = await this.options.projects.listTaskActivities(projectId);
    for (const task of snapshot.tasks) {
      if (!task.replyTarget || task.replyTarget.teamId !== slack.teamId) continue;
      const activities = taskActivities.filter(({ taskId }) => taskId === task.id);
      await this.notifyTask(snapshot.project, task, activities);
    }

    const channelId = slack.projectBindings.find((binding) => binding.projectId === projectId)?.channelId;
    if (!channelId) return;
    const target: SlackReplyTarget = { kind: "slack", teamId: slack.teamId, channelId };
    const projectDecision = projectDecisionReply(snapshot.project);
    if (projectDecision) {
      await this.sendQuestion(
        projectId, target, projectDecision, snapshot.project.name,
        this.projectQuestion(snapshot.project),
        snapshot.project.currentExecution?.result?.summary,
      );
    }
    const milestoneActivities = await this.options.projects.listMilestoneActivities(projectId);
    for (const milestone of snapshot.milestones) {
      const activities = milestoneActivities.filter(({ milestoneId }) => milestoneId === milestone.id);
      const decision = milestoneDecisionReply(snapshot.project, milestone, activities);
      if (decision) {
        await this.sendQuestion(
          projectId, target, decision, milestone.title, this.milestoneQuestion(activities),
          milestone.currentExecution?.result?.summary,
        );
      }
    }
  }

  private async notifyTask(project: Project, task: Task, activities: TaskActivity[]): Promise<void> {
    const currentActivity = activities.find(({ id }) => id === task.currentExecution?.submittedActivityId)
      ?? activities.at(-1);
    const identity = {
      projectId: project.id,
      target: task.replyTarget!,
      ...(task.source ? { source: task.source } : {}),
    };
    if (task.status === "done") {
      await this.publish({
        ...identity, id: `task:${task.id}:done`, createdAt: task.updatedAt,
        markdown: this.taskResult("工作已完成", task, currentActivity),
      });
      return;
    }
    if (task.status === "blocked") {
      const execution = task.currentExecution;
      const failedActivity = [...activities].reverse().find((activity) =>
        activity.type === "execution_failed" && activity.attemptId === execution?.attemptId,
      );
      const blockedActivity = failedActivity ?? (
        currentActivity?.type === "blocked" && currentActivity.reportOpportunityId === execution?.reportOpportunityId
          ? currentActivity
          : undefined
      );
      // 失败状态先保存，原因活动随后追加；等原因到达后再发送同一机会的通知。
      if (!blockedActivity) return;
      const opportunity = execution
        ? `${execution.attemptId}:${execution.reportOpportunityId}`
        : task.updatedAt;
      await this.publish({
        ...identity, id: `task:${task.id}:blocked:${opportunity}`, createdAt: task.updatedAt,
        markdown: this.taskResult("工作受阻", task, blockedActivity),
      });
      return;
    }
    const decision = taskDecisionReply(project, task, activities);
    if (decision) {
      await this.sendQuestion(
        project.id, task.replyTarget!, decision, task.title,
        currentActivity?.evidence?.question ?? currentActivity?.summary ?? "请确认后续处理方式。",
        currentActivity?.summary,
        task.source,
      );
    }
  }

  private taskResult(title: string, task: Task, activity: TaskActivity | undefined): string {
    const summary = activity?.summary ?? "请查看该工作的记录了解当前结果。";
    const tests = activity?.evidence?.tests;
    return `## ${title}：${task.title}\n\n${summary}${tests ? `\n\n**验证**\n\n${tests}` : ""}`;
  }

  private async sendQuestion(
    projectId: string,
    target: SlackReplyTarget,
    decision: DecisionReplyTarget,
    title: string,
    question: string,
    summary?: string,
    source?: Task["source"],
  ): Promise<void> {
    await this.publish({
      id: `decision:${decision.scope}:${decision.id}:${decision.reportOpportunityId}`,
      projectId, target, decision, createdAt: new Date().toISOString(),
      ...(source ? { source } : {}),
      markdown: `## 需要你决定：${title}\n\n${summary && summary !== question ? `${summary}\n\n` : ""}${question}\n\n请在此处回复决定。`,
    });
  }

  private async publish(notification: SlackDeliveryRecord): Promise<void> {
    // 同一结果继续使用首次保存的正文和地址，频道后续改绑不会搬走已产生的通知。
    const existing = await this.options.state.getDelivery(notification.id);
    if (existing?.sentAt) return;
    try {
      await this.options.deliveries.deliver(existing ?? notification);
    } catch (error) {
      this.options.onError(error);
    }
  }

  private async currentQuestion(decision: DecisionReplyTarget): Promise<SlackPendingDecision | null> {
    if (decision.scope === "task") {
      const found = await this.options.projects.findTask(decision.id);
      if (!found) return null;
      const activities = await this.options.projects.listTaskActivities(found.project.id, found.task.id);
      const current = taskDecisionReply(found.project, found.task, activities);
      if (!current) return null;
      const activity = activities.find(({ id }) => id === found.task.currentExecution?.submittedActivityId);
      return { ...current, question: activity?.evidence?.question ?? activity?.summary ?? "请确认后续处理方式。" };
    }
    if (decision.scope === "project") {
      const snapshot = await this.options.projects.getProject(decision.id);
      if (!snapshot) return null;
      const current = projectDecisionReply(snapshot.project);
      return current ? { ...current, question: this.projectQuestion(snapshot.project) } : null;
    }
    const found = await this.options.projects.findMilestone(decision.id);
    if (!found) return null;
    const activities = await this.options.projects.listMilestoneActivities(found.project.id, found.milestone.id);
    const current = milestoneDecisionReply(found.project, found.milestone, activities);
    return current ? { ...current, question: this.milestoneQuestion(activities) } : null;
  }

  private projectQuestion(project: Project): string {
    return project.planningQuestion ?? project.currentExecution?.result?.question
      ?? project.currentExecution?.result?.summary ?? "请确认后续处理方式。";
  }

  private milestoneQuestion(activities: MilestoneActivity[]): string {
    return projectMilestoneActivities(activities).unresolvedActivities.flatMap((activity) =>
      activity.type === "resolution" && activity.resolution.question ? [activity.resolution.question] : [],
    ).join("\n\n");
  }

  private isReplyDestination(delivery: SlackDeliveryRecord, target: SlackReplyTarget): boolean {
    const destination = delivery.target;
    if (destination.teamId !== target.teamId || destination.channelId !== target.channelId) return false;
    if (destination.threadTs) return destination.threadTs === target.threadTs;
    // 私信任务可直接回答，也可在已送达的问题下开串；频道根问题在对应串内回答。
    if (delivery.decision?.scope === "task" && !target.threadTs) return true;
    return delivery.messageTs === target.threadTs;
  }
}
