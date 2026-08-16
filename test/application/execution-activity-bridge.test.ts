import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type {
  CodexActivityEvent,
  CodexTurnActivity,
} from "../../src/application/codex-gateway.js";
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
      label: "正在编辑文件",
      occurredAt: "2026-08-16T01:00:00.000Z",
      source: "hook",
    });
    expect(JSON.stringify(activity)).not.toContain("session-family");
    expect(JSON.stringify(activity)).not.toContain("apply_patch");
    expect(listener).toHaveBeenCalledWith({
      taskId: fixture.task.id,
      activity,
    });
  });

  it("ignores stale identities, replaces the latest signal, and clears a completed turn", async () => {
    const fixture = await createFixture();

    fixture.publishCodex({
      type: "activity",
      threadId: "thread-old",
      turnId: "turn-current",
      category: "reading",
      occurredAt: "2026-08-16T01:01:00.000Z",
    });
    await settle();
    await expect(fixture.bridge.read(fixture.task.id)).resolves.toBeNull();

    fixture.publishCodex({
      type: "activity",
      threadId: "thread-current",
      turnId: "turn-current",
      category: "searching",
      occurredAt: "2026-08-16T01:02:00.000Z",
    });
    fixture.publishCodex({
      type: "activity",
      threadId: "thread-current",
      turnId: "turn-current",
      category: "running_tests",
      occurredAt: "2026-08-16T01:03:00.000Z",
    });
    await vi.waitFor(async () => {
      await expect(fixture.bridge.read(fixture.task.id)).resolves.toMatchObject({
        category: "running_tests",
        label: "正在运行测试",
      });
    });

    fixture.publishCodex({
      type: "turn_ended",
      threadId: "thread-current",
      turnId: "turn-current",
      occurredAt: "2026-08-16T01:04:00.000Z",
    });
    await vi.waitFor(async () => {
      await expect(fixture.bridge.read(fixture.task.id)).resolves.toBeNull();
    });
  });

  it("keeps the newest signal when Hook and App Server events arrive out of order", async () => {
    const fixture = await createFixture();
    const listener = vi.fn();
    fixture.bridge.subscribe(listener);

    fixture.publishCodex({
      type: "activity",
      threadId: "thread-current",
      turnId: "turn-current",
      category: "running_tests",
      occurredAt: "2026-08-16T01:03:00.000Z",
    });
    await vi.waitFor(async () => {
      await expect(fixture.bridge.read(fixture.task.id)).resolves.toMatchObject({
        category: "running_tests",
      });
    });
    await fixture.bridge.recordHook({
      schemaVersion: 1,
      sessionId: "session-family",
      turnId: "turn-current",
      event: "PreToolUse",
      toolName: "apply_patch",
      occurredAt: "2026-08-16T01:02:00.000Z",
    });

    await expect(fixture.bridge.read(fixture.task.id)).resolves.toMatchObject({
      category: "running_tests",
      occurredAt: "2026-08-16T01:03:00.000Z",
      source: "app_server",
    });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("derives a safe initial activity from the exact current turn", async () => {
    const fixture = await createFixture({
      readTurnActivity: async () => ({
        status: "inProgress",
        activity: {
          category: "calling_tool",
          occurredAt: "2026-08-16T01:05:00.000Z",
        },
      }),
    });

    await expect(fixture.bridge.read(fixture.task.id)).resolves.toMatchObject({
      taskId: fixture.task.id,
      attemptId: "attempt-current",
      category: "calling_tool",
      label: "正在调用工具",
      source: "app_server",
    });
    expect(fixture.readTurnActivity).toHaveBeenCalledWith(
      "thread-current",
      "turn-current",
    );
  });

  it("clears cached activity when the persisted execution identity changes", async () => {
    const fixture = await createFixture();
    await fixture.bridge.recordHook({
      schemaVersion: 1,
      sessionId: "session-family",
      turnId: "turn-current",
      event: "Stop",
      occurredAt: "2026-08-16T01:06:00.000Z",
    });
    await fixture.store.saveTask(fixture.projectId, {
      ...fixture.task,
      currentExecution: {
        ...fixture.task.currentExecution!,
        attemptId: "attempt-next",
        turnId: "turn-next",
      },
    });

    await fixture.bridge.synchronize(fixture.task.id);

    await expect(fixture.bridge.read(fixture.task.id)).resolves.toBeNull();
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
  readTurnActivity?: () => Promise<CodexTurnActivity | null>;
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
      action: "develop",
      threadId: "thread-current",
      turnId: "turn-current",
      status: "running",
      startedAt: "2026-08-16T00:59:00.000Z",
      modelRouting: testModelRouting(),
    },
  };
  await store.saveTask(snapshot.project.id, task);
  let activityListener: ((event: CodexActivityEvent) => void) | undefined;
  const readTurnActivity = vi.fn(
    options.readTurnActivity ?? (async () => null),
  );
  const bridge = new ExecutionActivityBridge({
    store,
    now: options.now,
    codex: {
      readTurnActivity,
      onActivity(listener) {
        activityListener = listener;
        return () => {
          activityListener = undefined;
        };
      },
    },
  });
  return {
    bridge,
    projectId: snapshot.project.id,
    task,
    store,
    readTurnActivity,
    publishCodex(event: CodexActivityEvent) {
      activityListener?.(event);
    },
  };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
