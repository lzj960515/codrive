import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { ExecutionActivityBridge } from "../../src/application/execution-activity-bridge.js";
import type { Task } from "../../src/domain/types.js";
import { ProjectStore } from "../../src/infrastructure/project-store.js";
import { testModelRouting } from "../support/recording-executors.js";

describe("ExecutionActivityBridge", () => {
  it("resolves Hook signals by turn and stores only the exact safe execution activity", async () => {
    const fixture = await createFixture();
    const listener = vi.fn();
    fixture.bridge.subscribe(listener);

    await expect(
      fixture.bridge.recordHook({
        schemaVersion: 1,
        sessionId: "session-family",
        turnId: "turn-current",
        event: "PreToolUse",
        toolName: "apply_patch",
        occurredAt: "2026-08-16T01:00:00.000Z",
      }),
    ).resolves.toBe(true);

    const activity = await fixture.bridge.read(fixture.task.id);
    expect(activity).toEqual({
      projectId: fixture.projectId,
      taskId: fixture.task.id,
      action: "develop",
      attemptId: "attempt-current",
      threadId: "thread-current",
      turnId: "turn-current",
      category: "editing",
      label: "正在调用 apply_patch",
      occurredAt: "2026-08-16T01:00:00.000Z",
      source: "hook",
    });
    expect(JSON.stringify(activity)).not.toContain("session-family");
    expect(listener).toHaveBeenCalledWith({
      taskId: fixture.task.id,
      activity,
    });
  });

  it("waits for a Hook instead of inferring live activity from App Server items", async () => {
    const fixture = await createFixture();

    await expect(fixture.bridge.read(fixture.task.id)).resolves.toBeNull();
  });

  it("does not renew the Hook silence window when task detail reads no activity", async () => {
    let now = new Date("2026-08-16T01:00:00.000Z");
    const fixture = await createFixture({
      now: () => now,
    });
    await fixture.bridge.initialize(now);

    now = new Date("2026-08-16T01:09:00.000Z");
    await fixture.bridge.read(fixture.task.id);

    expect(
      fixture.bridge.claimSilentExecutions(
        new Date("2026-08-16T01:10:00.000Z"),
        10 * 60_000,
      ),
    ).toMatchObject([{ lastSeenAt: "2026-08-16T01:00:00.000Z" }]);
  });

  it("clears the current activity when the turn stops", async () => {
    const fixture = await createFixture();
    const listener = vi.fn();
    fixture.bridge.subscribe(listener);
    await fixture.bridge.recordHook({
      schemaVersion: 1,
      sessionId: "session-family",
      turnId: "turn-current",
      event: "PreToolUse",
      toolName: "Bash",
      occurredAt: "2026-08-16T01:05:00.000Z",
    });
    await expect(fixture.bridge.recordHook({
      schemaVersion: 1,
      sessionId: "session-family",
      turnId: "turn-current",
      event: "Stop",
      occurredAt: "2026-08-16T01:06:00.000Z",
    })).resolves.toBe(true);

    await expect(fixture.bridge.read(fixture.task.id)).resolves.toBeNull();
    expect(listener).toHaveBeenLastCalledWith({
      taskId: fixture.task.id,
      activity: null,
    });
  });

  it("starts an in-memory silence window and claims an exact execution only once", async () => {
    const fixture = await createFixture();
    const startedAt = new Date("2026-08-16T01:00:00.000Z");
    await fixture.bridge.initialize(startedAt);

    expect(
      fixture.bridge.claimSilentExecutions(
        new Date("2026-08-16T01:09:59.999Z"),
        10 * 60_000,
      ),
    ).toEqual([]);

    const claims = fixture.bridge.claimSilentExecutions(
      new Date("2026-08-16T01:10:00.000Z"),
      10 * 60_000,
    );
    expect(claims).toEqual([
      {
        projectId: fixture.projectId,
        taskId: fixture.task.id,
        action: "develop",
        attemptId: "attempt-current",
        executionStatus: "running",
        threadId: "thread-current",
        turnId: "turn-current",
        lastSeenAt: "2026-08-16T01:00:00.000Z",
      },
    ]);
    expect(
      fixture.bridge.claimSilentExecutions(
        new Date("2026-08-16T01:10:00.000Z"),
        10 * 60_000,
      ),
    ).toEqual([]);
    expect(fixture.bridge.isSilenceClaimCurrent(claims[0]!)).toBe(true);
  });

  it("moves lastSeen for valid signals and resets the silence window after an active observation", async () => {
    let now = new Date("2026-08-16T01:00:00.000Z");
    const fixture = await createFixture({ now: () => now });
    await fixture.bridge.initialize(now);

    now = new Date("2026-08-16T01:09:00.000Z");
    await fixture.bridge.recordHook({
      schemaVersion: 1,
      sessionId: "session-family",
      turnId: "turn-current",
      event: "PostToolUse",
      toolName: "exec_command",
      occurredAt: "2026-08-16T01:08:30.000Z",
    });
    expect(
      fixture.bridge.claimSilentExecutions(
        new Date("2026-08-16T01:18:59.999Z"),
        10 * 60_000,
      ),
    ).toEqual([]);

    const [claim] = fixture.bridge.claimSilentExecutions(
      new Date("2026-08-16T01:19:00.000Z"),
      10 * 60_000,
    );
    expect(claim?.lastSeenAt).toBe("2026-08-16T01:09:00.000Z");

    fixture.bridge.finishSilenceCheck(claim!, {
      observedAt: new Date("2026-08-16T01:19:00.000Z"),
    });
    expect(
      fixture.bridge.claimSilentExecutions(
        new Date("2026-08-16T01:28:59.999Z"),
        10 * 60_000,
      ),
    ).toEqual([]);
    expect(
      fixture.bridge.claimSilentExecutions(
        new Date("2026-08-16T01:29:00.000Z"),
        10 * 60_000,
      ),
    ).toHaveLength(1);
  });

  it("invalidates a claimed silence window when the execution identity changes", async () => {
    const fixture = await createFixture();
    await fixture.bridge.initialize(new Date("2026-08-16T01:00:00.000Z"));
    const [claim] = fixture.bridge.claimSilentExecutions(
      new Date("2026-08-16T01:10:00.000Z"),
      10 * 60_000,
    );

    await fixture.store.saveTask(fixture.projectId, {
      ...fixture.task,
      currentExecution: {
        ...fixture.task.currentExecution!,
        attemptId: "attempt-next",
        turnId: "turn-next",
      },
    });
    await fixture.bridge.synchronize(fixture.task.id);

    expect(fixture.bridge.isSilenceClaimCurrent(claim!)).toBe(false);
  });

  it.each([
    "retry_scheduled",
    "waiting_for_input",
    "waiting_for_resume",
    "failed",
    "interrupted",
    "completed",
  ] as const)("does not observe %s executions as silent running work", async (status) => {
    const fixture = await createFixture();
    await fixture.store.saveTask(fixture.projectId, {
      ...fixture.task,
      currentExecution: {
        ...fixture.task.currentExecution!,
        status,
      },
    });

    await fixture.bridge.initialize(new Date("2026-08-16T01:00:00.000Z"));

    expect(
      fixture.bridge.claimSilentExecutions(
        new Date("2026-08-16T02:00:00.000Z"),
        10 * 60_000,
      ),
    ).toEqual([]);
    expect(JSON.stringify((await fixture.store.findTask(fixture.task.id))!.task))
      .not.toContain("lastSeen");
  });
});

async function createFixture(options: {
  now?: () => Date;
} = {}) {
  const stateDirectory = await mkdtemp(join(tmpdir(), "codrive-activity-"));
  const store = new ProjectStore(stateDirectory);
  const snapshot = await store.createProject({
    name: "Activity",
    repositoryPath: "/workspace/activity",
    defaultBranch: "main",
    productDocument: "# Activity\n",
    tasks: [{ title: "Observe", description: "Observe", acceptanceCriteria: [] }],
  });
  const task: Task = {
    ...snapshot.tasks[0]!,
    status: "developing",
    requestedAction: "develop",
    currentExecution: {
      attemptId: "attempt-current",
      reportOpportunityId: "report_opportunity_current",
      action: "develop",
      threadId: "thread-current",
      turnId: "turn-current",
      status: "running",
      startedAt: "2026-08-16T00:59:00.000Z",
      modelRouting: testModelRouting(),
    },
  };
  await store.saveTask(snapshot.project.id, task);
  const bridge = new ExecutionActivityBridge({
    store,
    now: options.now,
  });
  return {
    bridge,
    projectId: snapshot.project.id,
    task,
    store,
  };
}
