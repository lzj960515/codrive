import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ProjectStore } from "../../src/infrastructure/project-store.js";

const createdAt = "2026-08-27T00:00:00.000Z";
const workActivityId = "activity_development";

describe("state schema v4 upgrade", () => {
  it("migrates a v3 event stream and open execution with exact work ownership", async () => {
    const directory = await persistedV3State();
    const store = new ProjectStore(directory);

    await store.initialize();

    await expect(readJson(join(directory, "state-schema.json"))).resolves.toEqual({
      schemaVersion: 4,
      createdAt,
      migratedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
    await expect(readFile(join(directory, "backups", "state-v3", "state-schema.json"), "utf8")).resolves.toMatch(
      /"schemaVersion":\s*3/,
    );

    const snapshot = await store.getProject("project_v3");
    expect(snapshot?.tasks[0]).toMatchObject({
      status: "reviewing",
      requestedAction: "review",
      workActivityId: "activity_rework",
      currentExecution: {
        attemptId: "attempt_review",
        reportOpportunityId: "report_review",
        action: "review",
        status: "waiting_for_resume",
        workActivityId: "activity_rework",
        threadId: "thread_review",
        turnId: "turn_review",
        modelRouting: {
          model: "gpt-5.6-sol",
          route: "primary",
          retryCount: 2,
        },
        scheduledResume: {
          reason: "Wait for CI",
          resumeAt: "2026-08-29T00:00:00.000Z",
          resumePrompt: "Read CI and continue review.",
        },
      },
    });

    const activities = await store.listTaskActivities("project_v3", "task_v3");
    expect(activities).toEqual([
      expect.objectContaining({
        id: workActivityId,
        type: "work_completed",
        action: "work",
        workActivityId,
        attemptId: "attempt_develop",
        reportOpportunityId: "report_develop",
        occurredAt: "2026-08-27T01:00:00.000Z",
      }),
      expect.objectContaining({
        id: "activity_review",
        type: "review_changes_requested",
        action: "review",
        workActivityId,
      }),
      expect.objectContaining({
        id: "activity_rework",
        type: "work_completed",
        action: "work",
        workActivityId: "activity_rework",
      }),
    ]);

    const events = await readFile(join(directory, "projects", "project_v3", "events.ndjson"), "utf8");
    expect(events).not.toMatch(/"(?:develop|rework|developing|development_completed|rework_completed)"/);
    expect(events).not.toContain('"status":"changes_requested"');
    expect(events).toContain('"status":"working"');
    expect(events).toContain('"action":"work"');
    const historicalReview = events
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find(({ eventId }) => eventId === "event_historical_review");
    expect(historicalReview).toMatchObject({
      state: {
        task: {
          requestedAction: "review",
          workActivityId,
          currentExecution: {
            action: "review",
            workActivityId,
          },
        },
      },
    });
  });

  it("keeps v3 authoritative when an open review cannot be bound", async () => {
    const directory = await persistedV3State({ includeActivities: false });
    const markerPath = join(directory, "state-schema.json");
    const taskPath = join(
      directory,
      "projects",
      "project_v3",
      "tasks",
      "task_v3.json",
    );
    const beforeMarker = await readFile(markerPath, "utf8");
    const beforeTask = await readFile(taskPath, "utf8");

    await expect(new ProjectStore(directory).initialize()).rejects.toThrow(/cannot bind.*review.*work activity/i);

    await expect(readFile(markerPath, "utf8")).resolves.toBe(beforeMarker);
    await expect(readFile(taskPath, "utf8")).resolves.toBe(beforeTask);
  });

  it("keeps the v3 marker authoritative when migrated task state is not valid v4", async () => {
    const directory = await persistedV3State();
    const markerPath = join(directory, "state-schema.json");
    const taskPath = join(
      directory,
      "projects",
      "project_v3",
      "tasks",
      "task_v3.json",
    );
    const task = await readJson(taskPath) as Record<string, unknown>;
    task.status = "obsolete";
    await writeFile(taskPath, `${JSON.stringify(task, null, 2)}\n`, "utf8");

    await expect(new ProjectStore(directory).initialize()).rejects.toThrow(
      /unsupported.*status/i,
    );

    await expect(readJson(markerPath)).resolves.toMatchObject({ schemaVersion: 3 });
  });

  it("rejects legacy lifecycle values when the marker already claims v4", async () => {
    const directory = await persistedV3State();
    await writeFile(
      join(directory, "state-schema.json"),
      `${JSON.stringify({ schemaVersion: 4, createdAt }, null, 2)}\n`,
      "utf8",
    );

    await expect(new ProjectStore(directory).initialize()).rejects.toThrow(/schema v4/i);
  });

  it.each([
    ["before status", (event: Record<string, unknown>) => {
      event.before = { status: "developing" };
    }],
    ["event data action", (event: Record<string, unknown>) => {
      event.data = { action: "develop" };
    }],
  ] as const)("rejects a legacy %s when persisted state already claims v4", async (_label, mutate) => {
    const directory = await persistedV3State();
    await new ProjectStore(directory).initialize();
    const eventsPath = join(directory, "projects", "project_v3", "events.ndjson");
    const events = (await readFile(eventsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    mutate(events[0]!);
    await writeFile(
      eventsPath,
      `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
      "utf8",
    );

    await expect(new ProjectStore(directory).initialize()).rejects.toThrow(/unsupported.*lifecycle/i);
  });

  it("preserves historical project lifecycle snapshots while enforcing current v4 state", async () => {
    const directory = await persistedV3State();
    await new ProjectStore(directory).initialize();
    const projectDirectory = join(directory, "projects", "project_v3");
    const eventsPath = join(projectDirectory, "events.ndjson");
    const events = (await readFile(eventsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const currentProject = await readJson(
      join(projectDirectory, "project.json"),
    ) as Record<string, unknown>;
    const historicalProject = {
      ...currentProject,
      status: "evaluating",
      requestedAction: "evaluate_product",
    };
    events[0]!.before = { status: "active", requestedAction: null };
    events[0]!.after = {
      status: "evaluating",
      requestedAction: "evaluate_product",
      action: "evaluate_product",
      executionStatus: "pending",
    };
    events[0]!.state = { project: historicalProject };
    events.at(-1)!.state = { project: currentProject };
    await writeFile(
      eventsPath,
      `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
      "utf8",
    );

    const reopened = new ProjectStore(directory);
    await expect(reopened.initialize()).resolves.toBeUndefined();
    await expect(reopened.getProject("project_v3")).resolves.toMatchObject({
      project: { status: "active", requestedAction: null },
    });
  });

  it("rejects an unbound review execution when persisted state already claims v4", async () => {
    const directory = await persistedV3State();
    await new ProjectStore(directory).initialize();
    const taskPath = join(
      directory,
      "projects",
      "project_v3",
      "tasks",
      "task_v3.json",
    );
    const task = await readJson(taskPath) as Record<string, unknown>;
    delete task.workActivityId;
    const execution = task.currentExecution as Record<string, unknown>;
    delete execution.workActivityId;
    await writeFile(taskPath, `${JSON.stringify(task, null, 2)}\n`, "utf8");

    await expect(new ProjectStore(directory).initialize()).rejects.toThrow(/work activity/i);
  });
});

async function persistedV3State(options: { includeActivities?: boolean } = {}): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "codrive-state-v3-"));
  const projectDirectory = join(directory, "projects", "project_v3");
  const tasksDirectory = join(projectDirectory, "tasks");
  await mkdir(tasksDirectory, { recursive: true });
  await writeFile(
    join(directory, "state-schema.json"),
    `${JSON.stringify({ schemaVersion: 3, createdAt }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(join(projectDirectory, "PROJECT.md"), "# V3 product\n", "utf8");
  await writeFile(
    join(projectDirectory, "project.json"),
    `${JSON.stringify(
      {
        id: "project_v3",
        name: "V3 product",
        repositoryPath: "/tmp/v3-product",
        defaultBranch: "main",
        status: "active",
        scheduling: "running",
        requestedAction: null,
        planning: {
          revision: 1,
          evaluatedRevision: 1,
          changedAt: createdAt,
          changeReason: "project_registered",
        },
        productFacts: {
          revision: 1,
          digest: `sha256:${"a".repeat(64)}`,
          changedAt: createdAt,
        },
        createdAt,
        updatedAt: createdAt,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(
    join(tasksDirectory, "task_v3.json"),
    `${JSON.stringify(
      {
        id: "task_v3",
        projectId: "project_v3",
        title: "Continue review",
        description: "Preserve the open execution.",
        acceptanceCriteria: [],
        order: 1,
        status: "reviewing",
        requestedAction: "review",
        currentExecution: {
          attemptId: "attempt_review",
          reportOpportunityId: "report_review",
          action: "review",
          status: "waiting_for_resume",
          startedAt: "2026-08-27T03:00:00.000Z",
          threadId: "thread_review",
          turnId: "turn_review",
          modelRouting: {
            model: "gpt-5.6-sol",
            route: "primary",
            retryCount: 2,
          },
          scheduledResume: {
            reason: "Wait for CI",
            resumeAt: "2026-08-29T00:00:00.000Z",
            resumePrompt: "Read CI and continue review.",
          },
        },
        createdAt,
        updatedAt: "2026-08-27T03:00:00.000Z",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const events = options.includeActivities === false ? [] : legacyEvents();
  await writeFile(
    join(projectDirectory, "events.ndjson"),
    events.length > 0 ? `${events.map((event) => JSON.stringify(event)).join("\n")}\n` : "",
    "utf8",
  );
  return directory;
}

function legacyEvents(): Array<Record<string, unknown>> {
  const activity = (id: string, type: string, action: string, outcome: string, occurredAt: string) => ({
    schemaVersion: 1,
    eventId: `event_${id}`,
    type: "task.activity_recorded",
    projectId: "project_v3",
    taskId: "task_v3",
    occurredAt,
    before: { status: "developing", requestedAction: "develop" },
    after: { status: "changes_requested", requestedAction: "rework" },
    data: {
      activity: {
        id,
        projectId: "project_v3",
        taskId: "task_v3",
        type,
        action,
        outcome,
        attemptId: `attempt_${action}`,
        reportOpportunityId: `report_${action}`,
        summary: `Legacy ${action} result`,
        occurredAt,
        ...(action === "develop"
          ? {
              evidence: {
                workspacePath: "/tmp/v3-product/.worktrees/task_v3",
                baseCommit: "base",
                candidateCommit: "candidate",
              },
            }
          : {}),
        ...(outcome === "changes_requested" ? { evidence: { findings: ["Fix the supported path"] } } : {}),
      },
    },
    state: {
      task: {
        id: "task_v3",
        projectId: "project_v3",
        title: "Historical snapshot",
        description: "Recovery snapshot",
        acceptanceCriteria: [],
        order: 1,
        status: action === "rework" ? "changes_requested" : "developing",
        requestedAction: action,
        createdAt,
        updatedAt: occurredAt,
      },
    },
  });

  return [
    {
      schemaVersion: 1,
      eventId: "event_historical_review",
      type: "task.execution_started",
      projectId: "project_v3",
      taskId: "task_v3",
      occurredAt: "2026-08-27T01:30:00.000Z",
      state: {
        task: {
          id: "task_v3",
          projectId: "project_v3",
          title: "Historical review",
          description: "The work activity is backfilled later in the stream.",
          acceptanceCriteria: [],
          order: 1,
          status: "reviewing",
          requestedAction: "review",
          currentExecution: {
            attemptId: "attempt_historical_review",
            reportOpportunityId: "report_historical_review",
            action: "review",
            status: "pending",
            startedAt: "2026-08-27T01:30:00.000Z",
            modelRouting: {
              model: "gpt-5.6-sol",
              route: "primary",
              retryCount: 0,
            },
          },
          createdAt,
          updatedAt: "2026-08-27T01:30:00.000Z",
        },
      },
    },
    activity(workActivityId, "development_completed", "develop", "completed", "2026-08-27T01:00:00.000Z"),
    activity("activity_review", "review_changes_requested", "review", "changes_requested", "2026-08-27T02:00:00.000Z"),
    activity("activity_rework", "rework_completed", "rework", "completed", "2026-08-27T02:30:00.000Z"),
  ];
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}
