import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SlackDeliveryService } from "../../src/application/slack-delivery.js";
import { SlackNotifications } from "../../src/application/slack-notifications.js";
import { createTaskReportActivity } from "../../src/domain/task-activity.js";
import type { SlackTransport } from "../../src/domain/slack.js";
import type { Task, TaskActivity, TaskReport } from "../../src/domain/types.js";
import type { SlackReplyTarget } from "../../src/domain/work-source.js";
import { ConfigStore } from "../../src/infrastructure/config-store.js";
import { ProjectStore } from "../../src/infrastructure/project-store.js";
import { SlackStateStore } from "../../src/infrastructure/slack-state-store.js";
import { testModelRouting } from "../support/recording-executors.js";

const target: SlackReplyTarget = {
  kind: "slack", teamId: "T_owner", channelId: "C_original", threadTs: "100.000001",
};
const now = "2026-11-03T03:00:00.000Z";

describe("SlackNotifications", () => {
  let directory: string;
  let projects: ProjectStore;
  let configStore: ConfigStore;
  let state: SlackStateStore;
  let projectId: string;
  let task: Task;
  let sendMessage: ReturnType<typeof vi.fn<SlackTransport["sendMessage"]>>;
  let errors: unknown[];
  let notifications: SlackNotifications;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "codrive-slack-notifications-"));
    projects = new ProjectStore(directory);
    configStore = new ConfigStore(directory);
    const config = await configStore.loadOrCreate();
    const snapshot = await projects.createProject({
      name: "登录服务", repositoryPath: "/workspace/login", defaultBranch: "main",
      productDocument: "# 登录服务\n", tasks: [{
        title: "恢复登录", description: "核实登录失败并恢复既有行为", acceptanceCriteria: [],
        source: { kind: "slack", requestId: "event_login_failure" }, replyTarget: target,
      }],
    });
    projectId = snapshot.project.id;
    task = snapshot.tasks[0]!;
    await configStore.save({ ...config, slack: {
      enabled: true, teamId: "T_owner", authorizedUserId: "U_owner", botToken: "test-bot", appToken: "test-app",
      projectBindings: [{ projectId, channelId: "C_rebound" }],
    } });
    state = new SlackStateStore(directory);
    sendMessage = vi.fn<SlackTransport["sendMessage"]>().mockImplementation(async () => ({ messageTs: `200.${String(sendMessage.mock.calls.length).padStart(6, "0")}` }));
    errors = [];
    notifications = notifier();
  });

  afterEach(async () => {
    await notifications.stop();
    await rm(directory, { recursive: true, force: true });
  });

  function notifier() {
    return new SlackNotifications({
      projects, configStore, state,
      deliveries: new SlackDeliveryService(state, { sendMessage }, "T_owner"),
      onError: (error) => errors.push(error),
    });
  }

  async function saveReport(outcome: TaskReport["outcome"], status: Task["status"], summary: string, question?: string) {
    const opportunity = `opportunity_${randomUUID()}`;
    const activity = createTaskReportActivity({
      activityId: `activity_${randomUUID()}`, projectId, action: "work", occurredAt: now,
      report: {
        taskId: task.id, attemptId: "attempt_work", reportOpportunityId: opportunity, outcome, summary,
        ...(question ? { question } : {}),
      },
    });
    task = { ...task, status, requestedAction: null, currentExecution: {
      attemptId: "attempt_work", action: "work", reportOpportunityId: opportunity,
      status: status === "waiting_for_input" ? "waiting_for_input" : "completed",
      threadId: "thread_work", turnId: "turn_work", submittedActivityId: activity.id,
      startedAt: now, turnCompletedAt: now, modelRouting: testModelRouting(),
    } };
    await projects.saveTask(projectId, task);
    await appendTaskActivity(activity);
    return activity;
  }

  async function appendTaskActivity(activity: TaskActivity) {
    await projects.appendEvent({
      schemaVersion: 1, eventId: randomUUID(), type: "task.activity_recorded", projectId,
      taskId: task.id, occurredAt: now, data: { activity },
    });
  }

  it("waits for the whole task to finish and reports to its original thread once across restarts", async () => {
    await saveReport("completed", "reviewing", "已修复登录，仍待独立审查及发布核实。");
    await notifications.start();
    expect(sendMessage).not.toHaveBeenCalled();
    const completed = await saveReport("completed", "done", "已恢复登录并发布，线上登录验证通过。");
    await notifications.stop();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]![0]).toEqual(target);
    expect(sendMessage.mock.calls[0]![1]).toContain("线上登录验证通过");
    expect(await state.getDelivery(`task:${task.id}:done`)).toMatchObject({
      source: task.source, target, sentAt: expect.any(String),
    });

    notifications = notifier();
    await notifications.start();
    await appendTaskActivity(completed);
    await notifications.stop();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(errors).toEqual([]);
  });

  it("makes only delivered current questions replyable and discards stale decision identities", async () => {
    await notifications.start();
    await saveReport("needs_input", "waiting_for_input", "已审查候选，预览：https://preview.example.com/login", "是否合入并发布？");
    const [decision] = await notifications.pendingDecisions(target);
    expect(decision).toMatchObject({
      scope: "task", id: task.id, reportOpportunityId: task.currentExecution!.reportOpportunityId,
      question: "是否合入并发布？",
    });
    expect(sendMessage.mock.calls[0]![1]).toContain("https://preview.example.com/login");
    expect(await notifications.pendingDecisions({ ...target, threadTs: "other.000001" })).toEqual([]);

    task = { ...task, status: "working", currentExecution: {
      ...task.currentExecution!, reportOpportunityId: "new_opportunity", status: "running",
    } };
    await projects.saveTask(projectId, task);
    expect(await notifications.pendingDecisions(target)).toEqual([]);
  });

  it("keeps development successful when Slack fails and restores only the pending notification", async () => {
    sendMessage.mockRejectedValueOnce(new Error("Slack unavailable"));
    await saveReport("completed", "done", "修复、发布及线上验证已完成。");
    await notifications.start();
    expect((await projects.findTask(task.id))!.task.status).toBe("done");
    expect((await state.getDelivery(`task:${task.id}:done`))?.sentAt).toBeUndefined();
    expect(errors).toHaveLength(1);

    await notifications.stop();
    notifications = notifier();
    await notifications.start();
    expect((await state.getDelivery(`task:${task.id}:done`))?.sentAt).toEqual(expect.any(String));
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect((await projects.findTask(task.id))!.task.status).toBe("done");
  });

  it("reports a blocked opportunity once while allowing a later distinct blocker to be reported", async () => {
    await saveReport("blocked", "blocked", "发布凭据缺失，尚未上线。");
    await notifications.start();
    await projects.appendEvent({ schemaVersion: 1, eventId: randomUUID(), type: "task.updated", projectId, taskId: task.id, occurredAt: now });
    await notifications.stop();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]![1]).toContain("尚未上线");

    notifications = notifier();
    await notifications.start();
    await saveReport("blocked", "blocked", "凭据已补齐，发布服务当前不可用。");
    await notifications.stop();
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it("waits for the current execution failure evidence before describing a blocked task", async () => {
    await saveReport("completed", "reviewing", "上一轮工作已完成。");
    await notifications.start();
    task = { ...task, status: "blocked", currentExecution: {
      ...task.currentExecution!, attemptId: "attempt_failed", reportOpportunityId: "opportunity_failed", status: "failed",
    } };
    delete task.currentExecution!.submittedActivityId;
    await projects.saveTask(projectId, task);
    await projects.appendEvent({ schemaVersion: 1, eventId: randomUUID(), type: "turn.failed", projectId, taskId: task.id, occurredAt: now });
    await notifications.pendingDecisions(target);
    expect(sendMessage).not.toHaveBeenCalled();
    await appendTaskActivity({
      id: "failure_current", projectId, taskId: task.id, type: "execution_failed", attemptId: "attempt_failed", occurredAt: now,
      summary: "发布服务不可用，尚未上线。",
    });
    await notifications.stop();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]![1]).toContain("发布服务不可用");
    expect(sendMessage.mock.calls[0]![1]).not.toContain("上一轮工作已完成");
  });

  it("sends project and milestone questions as channel roots and binds replies to the delivered message", async () => {
    const snapshot = (await projects.getProject(projectId))!;
    const project = { ...snapshot.project, planningThreadId: "thread_plan", planningQuestion: "优先恢复哪个功能？", currentExecution: {
      attemptId: "attempt_plan", action: "select_tasks" as const, reportOpportunityId: "project_question",
      status: "completed" as const, startedAt: now, turnCompletedAt: now, threadId: "thread_plan",
      modelRouting: testModelRouting(), planningRevision: snapshot.project.planning.revision,
      result: { projectId, attemptId: "attempt_plan", reportOpportunityId: "project_question", outcome: "needs_input" as const, summary: "需要排列顺序", question: "优先恢复哪个功能？" },
    } };
    await projects.saveProject(project);
    const milestone = {
      id: "milestone_launch", projectId, title: "交付", description: "完成交付", acceptanceCriteria: [], definitionVersion: 1,
      status: "active" as const, planning: project.planning, threadId: "thread_milestone", createdAt: now, updatedAt: now,
      currentExecution: {
        attemptId: "attempt_milestone", action: "assess_milestone" as const, reportOpportunityId: "milestone_question",
        status: "completed" as const, startedAt: now, turnCompletedAt: now, threadId: "thread_milestone", modelRouting: testModelRouting(),
      },
    };
    await projects.saveMilestone(projectId, milestone);
    await projects.appendEvent({
      schemaVersion: 1, eventId: randomUUID(), type: "milestone.activity_recorded", projectId, milestoneId: milestone.id, occurredAt: now,
      data: { milestoneActivity: {
        id: "resolution_preview", projectId, milestoneId: milestone.id, type: "resolution", summary: "需要决定交付顺序", occurredAt: now,
        assessmentActivityId: "assessment_preview", resolution: { sourceActivityIds: [], summary: "需要决定交付顺序", question: "先开放给内测用户吗？" },
      } },
    });
    await notifications.start();
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls.every(([destination]) => destination.channelId === "C_rebound" && destination.threadTs === undefined)).toBe(true);
    const delivered = await state.listDeliveries();
    for (const delivery of delivered) {
      expect(await notifications.pendingDecisions({ kind: "slack", teamId: "T_owner", channelId: "C_rebound", threadTs: delivery.messageTs! })).toEqual([
        expect.objectContaining({ ...delivery.decision, question: expect.any(String) }),
      ]);
    }
    expect(await notifications.pendingDecisions({ kind: "slack", teamId: "T_owner", channelId: "C_rebound" })).toEqual([]);
  });

  it("does not treat an unsent question or a still-finishing turn as an accepted reply target", async () => {
    await saveReport("needs_input", "waiting_for_input", "等待确认", "是否发布？");
    delete task.currentExecution!.turnCompletedAt;
    await projects.saveTask(projectId, task);
    await notifications.start();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(await notifications.pendingDecisions(target)).toEqual([]);
    await notifications.stop();

    task.currentExecution!.turnCompletedAt = now;
    await projects.saveTask(projectId, task);
    sendMessage.mockRejectedValue(new Error("offline"));
    notifications = notifier();
    await notifications.start();
    expect(await notifications.pendingDecisions(target)).toEqual([]);
  });

  it("accepts a direct-message task answer directly or under its delivered question, while excluding other threads", async () => {
    const directTarget: SlackReplyTarget = { kind: "slack", teamId: "T_owner", channelId: "D_owner" };
    task = { ...task, replyTarget: directTarget };
    await saveReport("needs_input", "waiting_for_input", "预览已经准备好。", "是否发布？");
    await notifications.start();
    const [delivery] = await state.listDeliveries();
    const direct = await notifications.pendingDecisions(directTarget);
    expect(direct).toEqual([expect.objectContaining({ scope: "task", id: task.id })]);
    expect(await notifications.pendingDecisions({ ...directTarget, threadTs: delivery!.messageTs! })).toEqual(direct);
    expect(await notifications.pendingDecisions({ ...directTarget, threadTs: "unrelated.000001" })).toEqual([]);
  });
});
