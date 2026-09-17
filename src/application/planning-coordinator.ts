import { isDeepStrictEqual } from "node:util";
import { WorkflowConflictError } from "../domain/errors.js";
import { projectCanSchedule } from "../domain/project.js";
import type { Milestone, MilestoneReport } from "../domain/milestone.js";
import type {
  CodriveEvent,
  ModelRoutingSettings,
  Project,
  ProjectReport,
} from "../domain/types.js";
import type { ProjectStore } from "../infrastructure/project-store.js";
import type { PlanningExecutor, PlanningRequest } from "./planning-executor.js";
import {
  initialModelRouting,
  isModelCapacityFailure,
  isRetryDue,
  markRetryStarted,
  planModelCapacityRecovery,
  prepareModelRoutingForTurn,
  resetCapacityFailuresAfterStableTurn,
  type CodexTurnFailure,
} from "./model-routing.js";

type Owner = Project | Milestone;
type Report = ProjectReport | MilestoneReport;
const active = new Set([
  "pending",
  "running",
  "retry_scheduled",
  "awaiting_report",
]);
const inFlight = new Set(["running", "awaiting_report"]);
export interface PlanningCoordinatorOptions {
  now: () => string;
  createId: (prefix: string) => string;
  leaseExpiration: () => string;
  modelSettings: (project: Project) => ModelRoutingSettings;
  modelCapacityRetryDelaysMs: readonly number[];
  modelCapacityRetryResetAfterMs: number;
  modelPrimaryProbeAfterMs: number;
  recordEvent: (
    event: Omit<CodriveEvent, "schemaVersion" | "eventId" | "occurredAt">,
  ) => Promise<void>;
}

export class PlanningCoordinator {
  constructor(
    private readonly store: ProjectStore,
    private readonly executor: PlanningExecutor,
    private readonly options: PlanningCoordinatorOptions,
  ) {}

  async start<T extends Owner>(
    owner: T,
    context: { planningRevision?: number; selectionCapacity?: number } = {},
  ): Promise<T> {
    const request = await this.request(owner);
    if (!projectCanSchedule(request.project) || owner.status === "done")
      throw new WorkflowConflictError("Planning owner cannot schedule");
    if (owner.currentExecution && active.has(owner.currentExecution.status))
      throw new WorkflowConflictError(
        `Planning ${owner.id} already has an active execution`,
      );
    const milestone = isMilestone(owner);
    const execution = {
      attemptId: this.options.createId(
        milestone ? "milestone_attempt" : "project_attempt",
      ),
      reportOpportunityId: this.options.createId("report_opportunity"),
      action: milestone
        ? ("assess_milestone" as const)
        : ("select_tasks" as const),
      status: "pending" as const,
      startedAt: this.options.now(),
      modelRouting:
        owner.currentExecution?.modelRouting ??
        (!milestone ? owner.modelRouting : undefined) ??
        initialModelRouting(this.options.modelSettings(request.project)),
      leaseExpiresAt: this.options.leaseExpiration(),
      planningRevision: owner.planning.revision,
      ...(isMilestone(owner)
        ? { definitionVersion: owner.definitionVersion }
        : {}),
      ...context,
    };
    const pending = {
      ...owner,
      ...(!milestone ? { requestedAction: "select_tasks" } : {}),
      currentExecution: execution,
      updatedAt: this.options.now(),
    } as T;
    await this.save(pending);
    await this.event(
      pending,
      milestone
        ? "milestone.assessment_started"
        : "project.select_tasks_started",
    );
    return this.dispatch(pending);
  }

  async replyToDecision<T extends Owner>(
    owner: T,
    message: string,
  ): Promise<T> {
    const request = await this.request(owner);
    const snapshot = (await this.store.getProject(request.project.id))!;
    if (
      [snapshot.project, ...snapshot.milestones].some(
        (other) =>
          other.id !== owner.id &&
          other.currentExecution &&
          active.has(other.currentExecution.status),
      )
    )
      throw new WorkflowConflictError(
        "当前项目还有规划或评估正在执行，请等它结束后再回复。",
      );
    const threadId = owner.currentExecution!.threadId!;
    const attachedThreadId = await this.executor.openThread(request);
    if (threadId !== attachedThreadId)
      throw new WorkflowConflictError("待决定的原会话已变化，请刷新后重试。");
    if (await this.executor.isThreadActive?.(threadId))
      throw new WorkflowConflictError(
        "原会话仍在处理上一轮，请等它结束后再发送。",
      );
    const startedAt = this.options.now();
    const pending = {
      ...owner,
      ...(!isMilestone(owner) ? { requestedAction: "select_tasks" } : {}),
      currentExecution: {
        attemptId: this.options.createId(
          isMilestone(owner) ? "milestone_attempt" : "project_attempt",
        ),
        reportOpportunityId: this.options.createId("report_opportunity"),
        action: isMilestone(owner) ? "assess_milestone" : "select_tasks",
        status: "pending",
        threadId,
        startedAt,
        planningRevision: owner.planning.revision,
        ...(isMilestone(owner)
          ? { definitionVersion: owner.definitionVersion }
          : {}),
        modelRouting: prepareModelRoutingForTurn(
          owner.currentExecution!.modelRouting,
          this.options.modelSettings(request.project),
          new Date(startedAt),
          this.options.modelPrimaryProbeAfterMs,
        ),
        leaseExpiresAt: this.options.leaseExpiration(),
      },
      updatedAt: startedAt,
    } as T;
    await this.save(pending);
    let turnId: string;
    try {
      turnId = await this.executor.replyToDecision(
        await this.request(pending),
        threadId,
        message,
      );
    } catch (error) {
      // 发送失败仍保留原问题与报告机会，用户可以修复占用后重新发送。
      await this.save(owner);
      throw error;
    }
    const running = {
      ...pending,
      currentExecution: {
        ...pending.currentExecution!,
        status: "running",
        turnId,
        turnStartedAt: this.options.now(),
      },
    } as T;
    await this.save(running);
    await this.event(running, "decision.replied");
    await this.event(running, "turn.started");
    return running;
  }

  async submitReport(
    report: ProjectReport,
    validate: (owner: Project, report: ProjectReport) => Promise<void>,
  ): Promise<Project> {
    const owner = await this.require<Project>(report.projectId);
    const execution = owner.currentExecution;
    if (execution?.result && isDeepStrictEqual(execution.result, report))
      return owner;
    assertPlanningReportIdentity(owner, report);
    await validate(owner, report);
    const reported = {
      ...owner,
      currentExecution: { ...execution, result: report },
      updatedAt: this.options.now(),
    } as Project;
    await this.save(reported);
    await this.event(
      reported,
      isMilestone(owner) ? "milestone.reported" : "project.reported",
    );
    return reported;
  }

  async completeTurn<T extends Owner = Project>(
    ownerId: string,
    attemptId: string,
    turnId: string,
  ): Promise<T> {
    const owner = await this.require<T>(ownerId);
    const execution = owner.currentExecution;
    if (
      !execution ||
      execution.attemptId !== attemptId ||
      execution.turnId !== turnId ||
      !inFlight.has(execution.status)
    )
      return owner;
    if (execution.turnCompletedAt && !execution.result)
      return this.dispatch(owner);
    const completed = {
      ...owner,
      currentExecution: { ...execution, turnCompletedAt: this.options.now() },
      updatedAt: this.options.now(),
    } as T;
    await this.save(completed);
    await this.event(completed, "turn.completed");
    if (execution.result) return completed;
    const reportReminderCount = (execution.reportReminderCount ?? 0) + 1;
    if (reportReminderCount >= 3)
      return this.fail(completed, "missing_report", reportReminderCount);
    const awaiting = {
      ...completed,
      currentExecution: {
        ...completed.currentExecution!,
        status: "awaiting_report",
        reportReminderCount,
      },
    } as T;
    await this.save(awaiting);
    return this.dispatch(awaiting);
  }

  async resume<T extends Owner>(
    owner: T,
    expectedAttemptId: string,
  ): Promise<T> {
    if (!(await this.canResume(owner, expectedAttemptId))) return owner;
    if (owner.currentExecution?.status === "pending")
      return this.dispatch(owner);
    return owner;
  }

  async restart<T extends Owner>(
    owner: T,
    expectedAttemptId?: string,
  ): Promise<T> {
    if (expectedAttemptId && !(await this.canResume(owner, expectedAttemptId)))
      return owner;
    if (!owner.currentExecution) return owner;
    if (["failed", "completed"].includes(owner.currentExecution.status))
      return this.start(owner);
    // 持久会话恢复沿用 attempt 和报告机会，后续 turn 使用新身份。
    const pending = {
      ...owner,
      currentExecution: {
        ...owner.currentExecution,
        status: "pending",
        turnId: undefined,
        turnCompletedAt: undefined,
      },
      updatedAt: this.options.now(),
    } as T;
    await this.save(pending);
    return this.dispatch(pending);
  }

  async renewLease<T extends Owner = Project>(
    ownerId: string,
    attemptId: string,
  ): Promise<T> {
    const owner = await this.require<T>(ownerId);
    if (owner.currentExecution?.attemptId !== attemptId) return owner;
    const renewed = {
      ...owner,
      currentExecution: {
        ...owner.currentExecution,
        leaseExpiresAt: this.options.leaseExpiration(),
      },
    } as T;
    await this.save(renewed);
    return renewed;
  }

  async cancel<T extends Owner>(owner: T): Promise<T> {
    const execution = owner.currentExecution;
    if (!execution || !active.has(execution.status)) return owner;
    if (inFlight.has(execution.status))
      await this.executor.interrupt(await this.request(owner));
    return {
      ...owner,
      currentExecution: {
        ...execution,
        status: "interrupted",
        finishedAt: this.options.now(),
      },
    } as T;
  }

  async failTurn<T extends Owner = Project>(
    ownerId: string,
    attemptId: string,
    failure: CodexTurnFailure,
  ): Promise<T> {
    const owner = await this.require<T>(ownerId);
    const execution = owner.currentExecution;
    if (
      !execution ||
      execution.attemptId !== attemptId ||
      execution.turnId !== failure.turnId ||
      !inFlight.has(execution.status)
    )
      return owner;
    if (!isModelCapacityFailure(failure))
      return this.fail(owner, failure.message);
    const request = await this.request(owner);
    const now = new Date(this.options.now());
    const routing = resetCapacityFailuresAfterStableTurn(
      execution.modelRouting,
      execution.turnStartedAt,
      now,
      this.options.modelCapacityRetryResetAfterMs,
    );
    const recovery = planModelCapacityRecovery(
      routing,
      failure,
      this.options.modelSettings(request.project),
      now,
      this.options.modelCapacityRetryDelaysMs,
      this.options.modelPrimaryProbeAfterMs,
    );
    if (recovery.outcome === "exhausted")
      return this.fail(
        {
          ...owner,
          currentExecution: { ...execution, modelRouting: recovery.routing },
        } as T,
        failure.message,
      );
    const scheduled = {
      ...owner,
      currentExecution: {
        ...execution,
        status: "retry_scheduled",
        modelRouting: recovery.routing,
      },
      updatedAt: this.options.now(),
    } as T;
    await this.save(scheduled);
    await this.event(scheduled, "turn.retry_scheduled", failure.message);
    return scheduled;
  }

  async retryScheduled<T extends Owner>(owner: T, now: Date): Promise<T> {
    const execution = owner.currentExecution;
    if (
      !execution ||
      execution.status !== "retry_scheduled" ||
      !isRetryDue(execution.modelRouting, now) ||
      !(await this.canResume(owner, execution.attemptId))
    )
      return owner;
    const pending = {
      ...owner,
      currentExecution: {
        ...execution,
        status: execution.reportReminderCount ? "awaiting_report" : "pending",
        modelRouting: markRetryStarted(execution.modelRouting),
      },
      updatedAt: this.options.now(),
    } as T;
    await this.save(pending);
    return this.dispatch(pending);
  }

  async synchronizeConversation<T extends Owner>(owner: T): Promise<T> {
    // 已调度的执行由实时通知和恢复流程推进，读取历史 context 保留其执行身份。
    if (
      owner.currentExecution?.turnId &&
      inFlight.has(owner.currentExecution.status)
    )
      return owner;
    const threadId = isMilestone(owner)
      ? owner.threadId
      : owner.planningThreadId;
    if (!threadId || !this.executor.activeTurnId) return owner;
    const turnId = await this.executor.activeTurnId(threadId);
    return turnId && owner.currentExecution?.turnId !== turnId
      ? this.adoptTurn(owner, turnId)
      : owner;
  }

  async adoptTurn<T extends Owner>(owner: T, turnId: string): Promise<T> {
    const request = await this.request(owner);
    if (!projectCanSchedule(request.project) || owner.status === "done")
      return owner;
    const existing = owner.currentExecution;
    if (existing?.turnId === turnId) return owner;
    const threadId = isMilestone(owner)
      ? owner.threadId
      : owner.planningThreadId;
    if (!threadId) return owner;
    const adopted = {
      ...owner,
      currentExecution: {
        attemptId: this.options.createId("planning_attempt"),
        reportOpportunityId: this.options.createId("report_opportunity"),
        action: isMilestone(owner) ? "assess_milestone" : "select_tasks",
        status: "running",
        threadId,
        turnId,
        startedAt: this.options.now(),
        turnStartedAt: this.options.now(),
        leaseExpiresAt: this.options.leaseExpiration(),
        planningRevision: owner.planning.revision,
        ...(isMilestone(owner)
          ? { definitionVersion: owner.definitionVersion }
          : {}),
        modelRouting:
          existing?.modelRouting ??
          initialModelRouting(this.options.modelSettings(request.project)),
      },
    } as T;
    await this.save(adopted);
    await this.event(adopted, "turn.started");
    return adopted;
  }

  private async dispatch<T extends Owner>(owner: T): Promise<T> {
    let request = await this.request(owner);
    const execution = owner.currentExecution!;
    if (!projectCanSchedule(request.project) || owner.status === "done")
      return owner;
    const snapshot = (await this.store.getProject(request.project.id))!;
    if (
      [snapshot.project, ...snapshot.milestones].some(
        (other) =>
          other.id !== owner.id &&
          ["running", "awaiting_report"].includes(
            other.currentExecution?.status ?? "",
          ) &&
          !other.currentExecution?.turnCompletedAt,
      )
    )
      return owner;
    let threadId = execution.threadId;
    try {
      const attachedThreadId = await this.executor.openThread(request);
      if (!threadId) {
        threadId = attachedThreadId;
        owner = {
          ...owner,
          ...(isMilestone(owner)
            ? { threadId }
            : { planningThreadId: threadId }),
          currentExecution: { ...execution, threadId },
        } as T;
        await this.save(owner);
        await this.event(owner, "thread.created");
      }
      if (threadId !== attachedThreadId)
        throw new WorkflowConflictError(
          "Planning conversation identity changed during recovery",
        );
      if (await this.executor.isThreadActive?.(threadId)) return owner;
      const modelRouting = prepareModelRoutingForTurn(
        owner.currentExecution!.modelRouting,
        this.options.modelSettings(request.project),
        new Date(this.options.now()),
        this.options.modelPrimaryProbeAfterMs,
      );
      owner = {
        ...owner,
        currentExecution: { ...owner.currentExecution!, modelRouting },
      } as T;
      request = await this.request(owner);
      const turnId = execution.reportReminderCount
        ? await this.executor.requestReport(request, threadId)
        : await this.executor.startTurn(request, threadId);
      const running = {
        ...owner,
        currentExecution: {
          ...owner.currentExecution!,
          turnId,
          status: execution.reportReminderCount ? "awaiting_report" : "running",
          turnStartedAt: this.options.now(),
          turnCompletedAt: undefined,
          leaseExpiresAt: this.options.leaseExpiration(),
        },
        updatedAt: this.options.now(),
      } as T;
      await this.save(running);
      await this.event(running, "turn.started");
      return running;
    } catch (error) {
      return this.fail(
        await this.require<T>(owner.id),
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async fail<T extends Owner>(
    owner: T,
    reason: string,
    reportReminderCount?: number,
  ): Promise<T> {
    const execution = owner.currentExecution!;
    const failed = {
      ...owner,
      planning: {
        ...owner.planning,
        evaluatedRevision:
          execution.planningRevision ?? owner.planning.revision,
      },
      currentExecution: {
        ...execution,
        status: "failed",
        finishedAt: this.options.now(),
        reportReminderCount,
        result: isMilestone(owner)
          ? {
              milestoneId: owner.id,
              attemptId: execution.attemptId,
              reportOpportunityId: execution.reportOpportunityId,
              definitionVersion: owner.definitionVersion,
              planningRevision:
                execution.planningRevision ?? owner.planning.revision,
              outcome: "blocked",
              summary: reason,
            }
          : {
              projectId: owner.id,
              attemptId: execution.attemptId,
              reportOpportunityId: execution.reportOpportunityId,
              outcome: "blocked",
              summary: reason,
            },
      },
      updatedAt: this.options.now(),
    } as T;
    await this.save(failed);
    await this.event(
      failed,
      isMilestone(owner)
        ? "milestone.execution_failed"
        : "project.execution_failed",
      reason,
    );
    return failed;
  }

  private async canResume(owner: Owner, attemptId: string): Promise<boolean> {
    const request = await this.request(owner);
    const allowed =
      projectCanSchedule(request.project) &&
      owner.status !== "done" &&
      owner.currentExecution?.attemptId === attemptId;
    if (!allowed)
      await this.event(
        owner,
        "recovery.execution_suppressed",
        request.project.archivedAt
          ? "project_archived"
          : request.project.scheduling !== "running"
          ? "project_paused"
          : owner.currentExecution?.attemptId !== attemptId
          ? "execution_changed"
          : "project_not_active",
      );
    return allowed;
  }
  private async request(owner: Owner): Promise<PlanningRequest> {
    if (!isMilestone(owner)) return { project: owner };
    const snapshot = await this.store.getProject(owner.projectId);
    if (!snapshot) throw new Error(`Project ${owner.projectId} not found`);
    return { project: snapshot.project, milestone: owner };
  }
  private async require<T extends Owner>(id: string): Promise<T> {
    const project = await this.store.getProject(id);
    const owner =
      project?.project ?? (await this.store.findMilestone(id))?.milestone;
    if (!owner) throw new Error(`Planning owner ${id} not found`);
    return owner as T;
  }
  private save(owner: Owner): Promise<void> {
    return isMilestone(owner)
      ? this.store.saveMilestone(owner.projectId, owner)
      : this.store.saveProject(owner);
  }
  private event(owner: Owner, type: string, reason?: string): Promise<void> {
    const execution = owner.currentExecution;
    return this.options.recordEvent({
      type,
      projectId: isMilestone(owner) ? owner.projectId : owner.id,
      ...(isMilestone(owner) ? { milestoneId: owner.id } : {}),
      ...(execution
        ? {
            attemptId: execution.attemptId,
            threadId: execution.threadId,
            turnId: execution.turnId,
          }
        : {}),
      ...(reason ? { reason } : {}),
      data: {
        scope: isMilestone(owner) ? "milestone" : "project",
        ...(isMilestone(owner) ? { milestoneId: owner.id } : {}),
      },
      ...(isMilestone(owner) ? { state: { milestone: owner } } : {}),
    });
  }
}
function isMilestone(owner: Owner): owner is Milestone {
  return "projectId" in owner;
}

export function assertPlanningReportIdentity(
  owner: Owner,
  report: Report,
): void {
  const execution = owner.currentExecution;
  if (
    !execution ||
    execution.attemptId !== report.attemptId ||
    execution.reportOpportunityId !== report.reportOpportunityId ||
    !["pending", "running", "awaiting_report"].includes(execution.status)
  )
    throw new WorkflowConflictError(
      "Report does not match current planning execution",
    );
  if (execution.result)
    throw new WorkflowConflictError(
      "Report conflicts with recorded planning result",
    );
}
