import { RecoveryManager } from "../../src/application/recovery-manager.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { WorkflowEngine } from "../../src/application/workflow-engine.js";
import { ProjectStore } from "../../src/infrastructure/project-store.js";
import {
  RecordingProjectExecutor,
  RecordingTaskDispatcher,
  TestRepositoryPathResolver,
  testModels,
} from "../support/recording-executors.js";
import { taskHoldsIntegrationLease } from "../../src/application/integration-lease.js";
import type { TaskReport } from "../../src/domain/types.js";
import type { MilestoneReport } from "../../src/domain/milestone.js";

async function setup() {
  const store = new ProjectStore(
    await mkdtemp(join(tmpdir(), "codrive-milestone-")),
  );
  const planner = new RecordingProjectExecutor();
  const tasks = new RecordingTaskDispatcher();
  const workflow = new WorkflowEngine(
    store,
    tasks,
    { maxConcurrentTasks: 2, models: testModels },
    new TestRepositoryPathResolver(),
    planner,
  );
  const snapshot = await workflow.registerProject({
    name: "Social",
    repositoryPath: "/workspace/social",
    defaultBranch: "main",
    productDocument: "# Social\n",
    tasks: [],
    milestones: [
      {
        title: "Migrate",
        description: "Preserve results",
        acceptanceCriteria: ["No old readers"],
      },
    ],
  });
  return {
    store,
    planner,
    tasks,
    workflow,
    projectId: snapshot.project.id,
    milestoneId: snapshot.milestones[0]!.id,
  };
}
async function reportFor(
  env: Awaited<ReturnType<typeof setup>>,
  changes: Partial<MilestoneReport> = {},
): Promise<MilestoneReport> {
  const { milestone } = (await env.store.findMilestone(env.milestoneId))!;
  return {
    milestoneId: milestone.id,
    attemptId: milestone.currentExecution!.attemptId,
    reportOpportunityId: milestone.currentExecution!.reportOpportunityId,
    definitionVersion: milestone.definitionVersion,
    planningRevision: milestone.currentExecution!.planningRevision!,
    outcome: "progress",
    summary: "Plan",
    ...changes,
  };
}
async function finishAssessment(env: Awaited<ReturnType<typeof setup>>) {
  const { milestone } = (await env.store.findMilestone(env.milestoneId))!;
  await env.workflow.completeMilestoneTurn(
    milestone.id,
    milestone.currentExecution!.attemptId,
    milestone.currentExecution!.turnId!,
  );
}

async function selectTasks(
  env: Awaited<ReturnType<typeof setup>>,
  taskIds: string[],
) {
  const project = (await env.store.getProject(env.projectId))!.project;
  const execution = project.currentExecution!;
  await env.workflow.submitProjectReport({
    projectId: project.id,
    attemptId: execution.attemptId,
    reportOpportunityId: execution.reportOpportunityId,
    outcome: "selected",
    summary: "Proceed",
    taskIds,
  });
  await env.workflow.completeProjectTurn(
    project.id,
    execution.attemptId,
    execution.turnId!,
  );
}
async function reportTask(
  env: Awaited<ReturnType<typeof setup>>,
  taskId: string,
  outcome: TaskReport["outcome"],
  details: Partial<TaskReport> = {},
) {
  const task = (await env.store.findTask(taskId))!.task;
  const execution = task.currentExecution!;
  await env.workflow.submitReport({
    taskId,
    attemptId: execution.attemptId,
    reportOpportunityId: execution.reportOpportunityId,
    outcome,
    summary: "Verified",
    tests: "evidence verified",
    ...details,
  });
  await env.workflow.completeTurn(
    taskId,
    execution.attemptId,
    execution.turnId!,
  );
}
async function planTwoTasks(waitForFirst = false) {
  const env = await setup();
  await env.workflow.submitMilestoneReport(
    await reportFor(env, {
      plan: {
        tasks: [
          {
            key: "first",
            title: "Investigate",
            description: "Check evidence",
            acceptanceCriteria: [],
          },
          {
            key: "second",
            title: "Deliver",
            description: "Finish delivery",
            acceptanceCriteria: [],
          },
        ],
        ...(waitForFirst
          ? {
              resolutions: [
                {
                  sourceActivityIds: [],
                  summary: "Delivery requires investigation evidence",
                  affectedTaskIds: ["second"],
                  waitForTaskIds: ["first"],
                },
              ],
            }
          : {}),
      },
    }),
  );
  await finishAssessment(env);
  const tasks = (await env.store.getProject(env.projectId))!.tasks;
  const first = tasks.find((task) => task.title === "Investigate")!;
  const second = tasks.find((task) => task.title === "Deliver")!;
  await selectTasks(env, waitForFirst ? [first.id] : [first.id, second.id]);
  return { ...env, first, second };
}

function assessmentCount(env: Awaited<ReturnType<typeof setup>>) {
  return env.planner.started.filter((request) => request.milestone).length;
}

describe("Milestone workflow", () => {
  it("retries a disconnected assessment with the same attempt and model", async () => {
    const env = await setup();
    const first = (await env.store.findMilestone(env.milestoneId))!.milestone.currentExecution!;

    await env.workflow.failMilestoneTurn(env.milestoneId, first.attemptId, {
      turnId: first.turnId!,
      message: "stream disconnected before completion: Transport error: network error: error decoding response body",
    });

    const waiting = (await env.store.findMilestone(env.milestoneId))!.milestone.currentExecution!;
    expect(waiting).toMatchObject({
      attemptId: first.attemptId,
      threadId: first.threadId,
      status: "retry_scheduled",
      modelRouting: {
        model: first.modelRouting.model,
        route: first.modelRouting.route,
        retryCount: 1,
        lastError: { kind: "transport_error" },
      },
    });

    await env.workflow.retryScheduledExecutions(new Date(waiting.modelRouting.nextRetryAt!));
    expect((await env.store.findMilestone(env.milestoneId))!.milestone.currentExecution).toMatchObject({
      attemptId: first.attemptId,
      threadId: first.threadId,
      status: "running",
      modelRouting: { model: first.modelRouting.model, route: first.modelRouting.route },
    });
    expect(assessmentCount(env)).toBe(2);
  });

  it("keeps ordinary review and rework inside the task until the milestone needs final acceptance", async () => {
    const env = await planTwoTasks();
    const initial = assessmentCount(env);
    const outcomes: TaskReport["outcome"][] = [
      "completed",
      "changes_requested",
      "completed",
      "approved",
      "work_required",
      "completed",
      "approved",
      "completed",
    ];
    for (const outcome of outcomes) {
      await reportTask(
        env,
        env.first.id,
        outcome,
        outcome === "changes_requested"
          ? { findings: ["Fix missing evidence"] }
          : {},
      );
      expect(assessmentCount(env)).toBe(initial);
    }
    expect((await env.store.findTask(env.first.id))!.task.status).toBe("done");
    for (const outcome of ["completed", "approved"] as const) {
      await reportTask(env, env.second.id, outcome);
      expect(assessmentCount(env)).toBe(initial);
    }
    await reportTask(env, env.second.id, "completed");
    expect(assessmentCount(env)).toBe(initial + 1);
    await env.workflow.submitMilestoneReport(
      await reportFor(env, {
        outcome: "completed",
        evidence: ["Both reviewed deliveries satisfy the goal"],
      }),
    );
    await finishAssessment(env);
    expect(
      (await env.store.findMilestone(env.milestoneId))!.milestone.status,
    ).toBe("done");
  });

  it.each(["done", "cancelled"] as const)(
    "reassesses an explicitly awaited task only when it is %s",
    async (status) => {
      const env = await planTwoTasks(true);
      const initial = assessmentCount(env);
      await reportTask(env, env.first.id, "completed");
      expect(assessmentCount(env)).toBe(initial);
      await reportTask(env, env.first.id, "approved");
      expect(assessmentCount(env)).toBe(initial);
      if (status === "done") {
        await reportTask(env, env.first.id, "completed");
      } else {
        await env.workflow.cancelTask(env.first.id, {
          reason: "Investigation cannot continue",
          decisionBasis: "agent_decision",
          cancelledBy: "codex",
        });
      }
      expect(assessmentCount(env)).toBe(initial + 1);
      expect((await env.store.findTask(env.second.id))!.task.status).toBe(
        "backlog",
      );
      const context = await env.workflow.milestoneContext(env.milestoneId);
      expect(context.projection.restrictedTaskIds).toContain(env.second.id);
    },
  );

  it("ignores completed tasks from superseded prerequisite waits", async () => {
    const env = await planTwoTasks(true);
    await env.workflow.controlProject(env.projectId, "replan");
    const context = await env.workflow.milestoneContext(env.milestoneId);
    await env.workflow.submitMilestoneReport(
      await reportFor(env, {
        plan: {
          resolutions: [
            {
              sourceActivityIds: context.projection.unresolvedActivities.map(
                (activity) => activity.id,
              ),
              summary: "Delivery can proceed independently",
            },
          ],
        },
      }),
    );
    await finishAssessment(env);
    await selectTasks(env, [env.second.id]);
    const initial = assessmentCount(env);
    for (const outcome of ["completed", "approved", "completed"] as const)
      await reportTask(env, env.first.id, outcome);
    expect(assessmentCount(env)).toBe(initial);
  });

  it("does not reassess ordinary blockers or retries, but retains explicit discoveries", async () => {
    const env = await planTwoTasks();
    const initial = assessmentCount(env);
    await reportTask(env, env.first.id, "blocked");
    expect(assessmentCount(env)).toBe(initial);
    await env.workflow.retryTask(env.first.id);
    expect(assessmentCount(env)).toBe(initial);
    const task = (await env.store.findTask(env.first.id))!.task;
    await env.workflow.reportDiscovery({
      taskId: task.id,
      attemptId: task.currentExecution!.attemptId,
      requestId: "missing-consumer",
      summary: "Another consumer needs investigation",
      evidence: ["Found another interface consumer"],
    });
    expect(assessmentCount(env)).toBe(initial + 1);
  });

  it("waits for all ordinary tasks to end before assessing cancellations", async () => {
    const env = await planTwoTasks();
    const initial = assessmentCount(env);
    for (const [index, task] of [env.first, env.second].entries()) {
      await env.workflow.cancelTask(task.id, {
        reason: "Delivery no longer needed",
        decisionBasis: "user_confirmed",
        cancelledBy: "codex",
      });
      expect(assessmentCount(env)).toBe(initial + (index === 1 ? 1 : 0));
    }
  });

  it("keeps an awaited result received during assessment pending for another evaluation", async () => {
    const env = await planTwoTasks(true);
    await env.workflow.controlProject(env.projectId, "replan");
    const report = await reportFor(env);
    const initial = assessmentCount(env);
    for (const outcome of ["completed", "approved", "completed"] as const)
      await reportTask(env, env.first.id, outcome);
    expect(assessmentCount(env)).toBe(initial);
    expect(
      (await env.store.findMilestone(env.milestoneId))!.milestone.planning
        .revision,
    ).toBe(report.planningRevision + 1);
    await env.workflow.submitMilestoneReport(report);
    await finishAssessment(env);
    expect(assessmentCount(env)).toBe(initial + 1);
  });

  it.each(["needs_input", "scheduled_wait"] as const)(
    "keeps %s in the task without waking the milestone",
    async (outcome) => {
      const env = await planTwoTasks(true);
      const initial = assessmentCount(env);
      await reportTask(
        env,
        env.first.id,
        outcome === "needs_input" ? "needs_input" : "blocked",
        outcome === "needs_input"
          ? { question: "Which account should I use?" }
          : {
              resumeAt: "2099-01-01T00:00:00Z",
              resumePrompt: "Check verification results",
            },
      );
      expect(assessmentCount(env)).toBe(initial);
    },
  );

  it("reassesses a planned cancellation when its prerequisite wait remains unresolved", async () => {
    const env = await planTwoTasks(true);
    await env.workflow.controlProject(env.projectId, "replan");
    const task = (await env.store.findTask(env.first.id))!.task;
    const initial = assessmentCount(env);
    await env.workflow.submitMilestoneReport(
      await reportFor(env, {
        plan: {
          cancellations: [
            {
              taskId: task.id,
              expectedUpdatedAt: task.updatedAt,
              reason: "This investigation cannot produce the required evidence",
              decisionBasis: "agent_decision",
            },
          ],
        },
      }),
    );
    await finishAssessment(env);
    expect(assessmentCount(env)).toBe(initial + 1);
    const context = await env.workflow.milestoneContext(env.milestoneId);
    expect(context.projection.restrictedTaskIds).toContain(env.second.id);
    expect((await env.store.findTask(task.id))!.task.status).toBe("cancelled");
  });

  it("does not reassess a prerequisite cancellation already resolved by the owner's plan", async () => {
    const env = await planTwoTasks(true);
    await env.workflow.controlProject(env.projectId, "replan");
    const context = await env.workflow.milestoneContext(env.milestoneId);
    const task = (await env.store.findTask(env.first.id))!.task;
    const initial = assessmentCount(env);
    await env.workflow.submitMilestoneReport(
      await reportFor(env, {
        plan: {
          cancellations: [
            {
              taskId: task.id,
              expectedUpdatedAt: task.updatedAt,
              reason: "Existing evidence is sufficient",
              decisionBasis: "agent_decision",
            },
          ],
          resolutions: [
            {
              sourceActivityIds: context.projection.unresolvedActivities.map(
                ({ id }) => id,
              ),
              summary: "Investigation no longer needed; delivery can continue",
            },
          ],
        },
      }),
    );
    await finishAssessment(env);
    expect((await env.store.findTask(task.id))!.task.status).toBe("cancelled");
    expect(assessmentCount(env)).toBe(initial);
    expect(
      (await env.workflow.milestoneContext(env.milestoneId)).projection
        .restrictedTaskIds,
    ).toEqual([]);
  });

  it("accepts evidence-backed completion with planned cancellations without another assessment", async () => {
    const env = await planTwoTasks();
    await env.workflow.controlProject(env.projectId, "replan");
    const tasks = (await env.store.getProject(env.projectId))!.tasks;
    const initial = assessmentCount(env);
    await env.workflow.submitMilestoneReport(
      await reportFor(env, {
        outcome: "completed",
        evidence: ["Existing delivery verified against acceptance criteria"],
        plan: {
          cancellations: tasks.map((task) => ({
            taskId: task.id,
            expectedUpdatedAt: task.updatedAt,
            reason: "Existing delivery makes this task obsolete",
            decisionBasis: "agent_decision" as const,
          })),
        },
      }),
    );
    await finishAssessment(env);
    expect(assessmentCount(env)).toBe(initial);
    expect(
      (await env.store.findMilestone(env.milestoneId))!.milestone.status,
    ).toBe("done");
  });

  it("starts from only a goal and applies new tasks once without changing product facts", async () => {
    const env = await setup();
    expect(env.planner.started[0]?.milestone?.id).toBe(env.milestoneId);
    const facts = (await env.store.getProject(env.projectId))!.project
      .productFacts;
    const report = await reportFor(env, {
      plan: {
        tasks: [
          {
            key: "readers",
            title: "Find readers",
            description: "Inspect calls",
            acceptanceCriteria: [],
          },
        ],
      },
    });
    await env.workflow.submitMilestoneReport(report);
    await env.workflow.submitMilestoneReport(report);
    await finishAssessment(env);
    const snapshot = (await env.store.getProject(env.projectId))!;
    expect(snapshot.tasks).toHaveLength(1);
    expect(snapshot.tasks[0]?.milestoneId).toBe(env.milestoneId);
    expect(snapshot.project.productFacts).toEqual(facts);
    expect(env.planner.started.at(-1)?.milestone).toBeUndefined();
  });

  it("does not consume a discovery received during an assessment and reuses its thread", async () => {
    const env = await setup();
    await env.workflow.submitMilestoneReport(
      await reportFor(env, {
        plan: {
          tasks: [
            {
              key: "a",
              title: "Inspect",
              description: "Inspect",
              acceptanceCriteria: [],
            },
          ],
        },
      }),
    );
    await finishAssessment(env);
    const snapshot = (await env.store.getProject(env.projectId))!;
    const selection = snapshot.project.currentExecution!;
    await env.workflow.submitProjectReport({
      projectId: env.projectId,
      attemptId: selection.attemptId,
      reportOpportunityId: selection.reportOpportunityId,
      outcome: "selected",
      summary: "Start",
      taskIds: [snapshot.tasks[0]!.id],
    });
    await env.workflow.completeProjectTurn(
      env.projectId,
      selection.attemptId,
      selection.turnId!,
    );
    const task = (await env.store.findTask(snapshot.tasks[0]!.id))!.task;
    const discovery = {
      taskId: task.id,
      attemptId: task.currentExecution!.attemptId,
      requestId: "consumer",
      summary: "Another reader",
      evidence: ["reader.ts"],
    };
    const first = await env.workflow.reportDiscovery(discovery);
    const during = await reportFor(env, {
      plan: {
        resolutions: [
          {
            sourceActivityIds: [first.id],
            summary: "Investigate in current task",
          },
        ],
      },
    });
    await env.workflow.reportDiscovery({
      ...discovery,
      requestId: "consumer-2",
      summary: "Third reader",
    });
    await env.workflow.submitMilestoneReport(during);
    await finishAssessment(env);
    const current = (await env.store.findMilestone(env.milestoneId))!.milestone;
    expect(current.currentExecution?.status).toBe("running");
    expect(current.currentExecution?.planningRevision).toBe(
      current.planning.revision,
    );
    expect(
      new Set(
        env.planner.started
          .filter((item) => item.milestone)
          .map((item) => item.threadId),
      ).size,
    ).toBe(1);
    const context = await env.workflow.milestoneContext(env.milestoneId);
    expect(
      context.projection.unresolvedActivities.map(
        (activity) => activity.summary,
      ),
    ).toEqual(["Third reader"]);
  });

  it("rejects completion while an unresolved question or task remains", async () => {
    const env = await setup();
    await env.workflow.submitMilestoneReport(
      await reportFor(env, {
        outcome: "needs_input",
        plan: {
          resolutions: [
            {
              sourceActivityIds: [],
              question: "Keep old exports?",
              summary: "Decide capability",
            },
          ],
        },
      }),
    );
    await finishAssessment(env);
    await env.workflow.observePlanningTurn(
      (await env.store.findMilestone(env.milestoneId))!.milestone.threadId!,
      "user_turn",
    );
    await expect(
      env.workflow.submitMilestoneReport(
        await reportFor(env, { outcome: "completed", evidence: ["verified"] }),
      ),
    ).rejects.toThrow("completion");
  });
  it("releases an interrupted integration lease so its prerequisite can finish, then resumes the original attempt", async () => {
    const env = await setup();
    await env.workflow.submitMilestoneReport(
      await reportFor(env, {
        plan: {
          tasks: [
            {
              key: "delete",
              title: "Delete old reader",
              description: "Remove old source",
              acceptanceCriteria: [],
            },
            {
              key: "migrate",
              title: "Migrate consumer",
              description: "Move reads",
              acceptanceCriteria: [],
            },
          ],
        },
      }),
    );
    await finishAssessment(env);
    const initial = (await env.store.getProject(env.projectId))!.tasks;
    const deletion = initial.find((task) => task.title.startsWith("Delete"))!;
    const migration = initial.find((task) => task.title.startsWith("Migrate"))!;
    await selectTasks(env, [deletion.id, migration.id]);
    await reportTask(env, deletion.id, "completed");
    await reportTask(env, deletion.id, "approved");
    const integrating = (await env.store.findTask(deletion.id))!.task;
    expect(taskHoldsIntegrationLease(integrating)).toBe(true);
    await env.workflow.reportDiscovery({
      taskId: deletion.id,
      attemptId: integrating.currentExecution!.attemptId,
      requestId: "remaining-consumer",
      summary: "Consumer still reads the source",
      evidence: ["Consumer reads old source"],
    });
    const discovery = (await env.workflow.milestoneContext(env.milestoneId))
      .projection.unresolvedActivities[0]!;
    // 明确的新发现触发负责人，只暂停删除任务并等待迁移交付。
    const report = await reportFor(env, {
      outcome: "needs_input",
      plan: {
        resolutions: [
          {
            sourceActivityIds: [discovery.id],
            waitForTaskIds: [migration.id],
            summary: "Consumer still reads the source",
            question: "Keep compatibility?",
            affectedTaskIds: [deletion.id],
          },
        ],
      },
    });
    await env.workflow.submitMilestoneReport(report);
    await finishAssessment(env);
    expect(
      env.tasks.interrupted.some((request) => request.task.id === deletion.id),
    ).toBe(true);
    const execution = integrating.currentExecution!;
    await env.workflow.resumeTaskAfterInterruption({
      projectId: env.projectId,
      taskId: deletion.id,
      action: "integrate",
      attemptId: execution.attemptId,
      threadId: execution.threadId!,
      turnId: execution.turnId!,
      executionStatus: execution.status,
    });
    expect(
      taskHoldsIntegrationLease((await env.store.findTask(deletion.id))!.task),
    ).toBe(false);
    await expect(env.workflow.retryTask(deletion.id)).rejects.toThrow(
      "milestone decision or prerequisite",
    );
    await reportTask(env, migration.id, "completed");
    await reportTask(env, migration.id, "approved");
    await reportTask(env, migration.id, "completed");
    const context = await env.workflow.milestoneContext(env.milestoneId);
    const question = context.projection.unresolvedActivities.find(
      (activity) => activity.type === "resolution",
    )!;
    await env.workflow.submitMilestoneReport(
      await reportFor(env, {
        plan: {
          resolutions: [
            {
              sourceActivityIds: [question.id],
              summary: "Consumer migration verified; delete can continue",
            },
          ],
        },
      }),
    );
    const resumed = (await env.store.findTask(deletion.id))!.task;
    expect(resumed.currentExecution?.attemptId).toBe(execution.attemptId);
    expect(resumed.currentExecution?.status).toBe("running");
    expect(taskHoldsIntegrationLease(resumed)).toBe(true);
  });

  it("rejects a dependency cycle instead of leaving both tasks waiting forever", async () => {
    const env = await setup();
    const report = await reportFor(env, {
      plan: {
        tasks: [
          { key: "a", title: "A", description: "A", acceptanceCriteria: [] },
          { key: "b", title: "B", description: "B", acceptanceCriteria: [] },
        ],
        resolutions: [
          {
            sourceActivityIds: [],
            summary: "A waits B",
            affectedTaskIds: ["a"],
            waitForTaskIds: ["b"],
          },
          {
            sourceActivityIds: [],
            summary: "B waits A",
            affectedTaskIds: ["b"],
            waitForTaskIds: ["a"],
          },
        ],
      },
    });
    await expect(env.workflow.submitMilestoneReport(report)).rejects.toThrow(
      "cycle",
    );
  });
  it("keeps historical conversation replies outside the execution lifecycle after completion", async () => {
    const env = await setup();
    await env.workflow.submitMilestoneReport(
      await reportFor(env, {
        outcome: "completed",
        evidence: ["Already verified"],
      }),
    );
    await finishAssessment(env);
    const completed = (await env.store.findMilestone(env.milestoneId))!
      .milestone;
    await env.workflow.observePlanningTurn(
      completed.threadId!,
      "historical_question",
    );
    expect(
      (await env.store.findMilestone(env.milestoneId))!.milestone
        .currentExecution?.attemptId,
    ).toBe(completed.currentExecution?.attemptId);
    await env.workflow.addProjectWork(
      env.projectId,
      [
        {
          title: "Independent",
          description: "Independent",
          acceptanceCriteria: [],
        },
      ],
      "New work",
    );
    expect(
      (await env.store.getProject(env.projectId))!.project.currentExecution
        ?.status,
    ).toBe("running");
  });

  it("recovers an accepted plan after task persistence fails without duplicating work", async () => {
    const env = await setup();
    const save = vi
      .spyOn(env.store, "saveTask")
      .mockRejectedValueOnce(new Error("Disk interrupted"));
    const report = await reportFor(env, {
      plan: {
        tasks: [
          { key: "a", title: "A", description: "A", acceptanceCriteria: [] },
        ],
      },
    });
    await expect(env.workflow.submitMilestoneReport(report)).rejects.toThrow(
      "Disk interrupted",
    );
    save.mockRestore();
    await env.workflow.recoverAcceptedMilestonePlans();
    await env.workflow.recoverAcceptedMilestonePlans();
    await env.workflow.submitMilestoneReport(report);
    expect((await env.store.getProject(env.projectId))!.tasks).toHaveLength(1);
    expect((await env.store.getProject(env.projectId))!.tasks[0]?.order).toBe(
      1,
    );
  });

  it("preserves a task's own user question when a milestone restriction is resolved", async () => {
    const env = await setup();
    await env.workflow.submitMilestoneReport(
      await reportFor(env, {
        plan: {
          tasks: [
            { key: "a", title: "A", description: "A", acceptanceCriteria: [] },
          ],
        },
      }),
    );
    await finishAssessment(env);
    const task = (await env.store.getProject(env.projectId))!.tasks[0]!;
    await selectTasks(env, [task.id]);
    const execution = (await env.store.findTask(task.id))!.task
      .currentExecution!;
    await env.workflow.submitReport({
      taskId: task.id,
      attemptId: execution.attemptId,
      reportOpportunityId: execution.reportOpportunityId,
      outcome: "needs_input",
      summary: "Task detail",
      question: "Which account?",
    });
    await env.workflow.completeTurn(
      task.id,
      execution.attemptId,
      execution.turnId!,
    );
    await env.workflow.observePlanningTurn(
      (await env.store.findMilestone(env.milestoneId))!.milestone.threadId!,
      "scope_question",
    );
    await env.workflow.submitMilestoneReport(
      await reportFor(env, {
        outcome: "needs_input",
        plan: {
          resolutions: [
            {
              sourceActivityIds: [],
              summary: "Scope decision",
              question: "Keep scope?",
              affectedTaskIds: [task.id],
            },
          ],
        },
      }),
    );
    await finishAssessment(env);
    const context = await env.workflow.milestoneContext(env.milestoneId);
    const question = context.projection.unresolvedActivities.find(
      (activity) => activity.type === "resolution",
    )!;
    await env.workflow.observePlanningTurn(
      context.milestone.threadId!,
      "scope_answer",
    );
    await env.workflow.submitMilestoneReport(
      await reportFor(env, {
        plan: {
          resolutions: [
            { sourceActivityIds: [question.id], summary: "Keep scope" },
          ],
        },
      }),
    );
    expect(
      (await env.store.findTask(task.id))!.task.currentExecution?.status,
    ).toBe("waiting_for_input");
  });

  it("settles an accepted assessment after its turn is interrupted without sending another assessment", async () => {
    const env = await setup();
    const report = await reportFor(env, {
      plan: {
        tasks: [
          {
            key: "delivery",
            title: "Deliver",
            description: "Finish delivery",
            acceptanceCriteria: [],
          },
        ],
      },
    });
    await env.workflow.submitMilestoneReport(report);
    const execution = (await env.store.findMilestone(env.milestoneId))!
      .milestone.currentExecution!;
    await env.workflow.recoverMilestoneExecution(
      env.milestoneId,
      execution.attemptId,
      execution.turnId,
      "recover",
    );
    const milestone = (await env.store.findMilestone(env.milestoneId))!
      .milestone;
    expect(milestone.currentExecution).toMatchObject({
      status: "completed",
      result: report,
    });
    expect(assessmentCount(env)).toBe(1);
    expect(milestone.planning.evaluatedRevision).toBe(
      milestone.planning.revision,
    );
  });

  it("keeps a missing-report reminder pending while its project is paused", async () => {
    const env = await setup();
    await env.workflow.controlProject(env.projectId, "pause");
    await finishAssessment(env);
    expect(env.planner.reminders).toHaveLength(0);
    expect(
      (await env.store.findMilestone(env.milestoneId))!.milestone
        .currentExecution?.status,
    ).toBe("awaiting_report");
    await env.workflow.controlProject(env.projectId, "resume");
    expect(env.planner.reminders).toHaveLength(1);
  });
  it("queues a project retry while a milestone turn owns the planning slot", async () => {
    const env = await setup();
    await env.workflow.submitMilestoneReport(
      await reportFor(env, {
        plan: {
          tasks: [
            { key: "a", title: "A", description: "A", acceptanceCriteria: [] },
          ],
        },
      }),
    );
    await finishAssessment(env);
    const selection = (await env.store.getProject(env.projectId))!.project
      .currentExecution!;
    await env.workflow.failProjectTurn(env.projectId, selection.attemptId, {
      turnId: selection.turnId!,
      message: "Transient planning error",
    });
    const milestone = (await env.store.findMilestone(env.milestoneId))!
      .milestone;
    await env.workflow.observePlanningTurn(
      milestone.threadId!,
      "user_planning_turn",
    );
    const started = env.planner.started.length;
    await env.workflow.retryProject(env.projectId);
    expect(env.planner.started).toHaveLength(started);
    expect(
      (await env.store.getProject(env.projectId))!.project.currentExecution
        ?.status,
    ).toBe("pending");
    await env.workflow.submitMilestoneReport(await reportFor(env));
    await finishAssessment(env);
    expect(env.planner.started).toHaveLength(started + 1);
    expect(
      (await env.store.getProject(env.projectId))!.project.currentExecution
        ?.status,
    ).toBe("running");
  });

  it("binds a direct user turn through the App Server notification boundary", async () => {
    const env = await setup();
    await env.workflow.submitMilestoneReport(
      await reportFor(env, {
        outcome: "needs_input",
        plan: {
          resolutions: [
            {
              sourceActivityIds: [],
              summary: "Decide",
              question: "Keep capability?",
            },
          ],
        },
      }),
    );
    await finishAssessment(env);
    const before = (await env.store.findMilestone(env.milestoneId))!.milestone;
    const recovery = new RecoveryManager(env.store, env.workflow, {
      onNotification: () => () => {},
      readTurnStatus: async () => null,
      readTurnSnapshot: async () => ({
        threadStatus: "notLoaded",
        activeTurnIds: [],
        turn: null,
      }),
    });
    await recovery.handleNotification({
      method: "turn/started",
      params: { threadId: before.threadId, turn: { id: "user_answer" } },
    });
    const after = (await env.store.findMilestone(env.milestoneId))!.milestone;
    expect(after.currentExecution?.turnId).toBe("user_answer");
    expect(after.currentExecution?.reportOpportunityId).not.toBe(
      before.currentExecution?.reportOpportunityId,
    );
  });
});
