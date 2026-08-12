import { randomUUID } from "node:crypto";
import {
  access,
  appendFile,
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import {
  createTaskLifecycleActivity,
  createTaskReportActivity,
  taskReportFromActivity,
} from "../domain/task-activity.js";
import type {
  CodriveEvent,
  Project,
  ProjectExecution,
  ProjectPlanningState,
  ProjectReport,
  Task,
  TaskActivity,
  TaskExecution,
  TaskReport,
} from "../domain/types.js";

const currentStateSchemaVersion = 2;

interface StateSchema {
  schemaVersion: number;
  migratedAt: string;
}

interface MigrationResult {
  migrated: boolean;
  reportCount: number;
  activityCount: number;
}

export async function migrateStateDirectory(
  stateDirectory: string,
): Promise<MigrationResult> {
  const schemaPath = join(stateDirectory, "state-schema.json");
  const schema = await readJsonIfExists<StateSchema>(schemaPath);
  if (schema?.schemaVersion === currentStateSchemaVersion) {
    return { migrated: false, reportCount: 0, activityCount: 0 };
  }
  if (schema && schema.schemaVersion > currentStateSchemaVersion) {
    throw new Error(`Unsupported Codrive state version ${schema.schemaVersion}`);
  }

  const projectsDirectory = join(stateDirectory, "projects");
  await mkdir(projectsDirectory, { recursive: true });
  const projectEntries = (await readdir(projectsDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory());
  const now = new Date().toISOString();
  if (projectEntries.length === 0) {
    await atomicWriteJson(schemaPath, {
      schemaVersion: currentStateSchemaVersion,
      migratedAt: now,
    });
    return { migrated: true, reportCount: 0, activityCount: 0 };
  }

  await backupState(stateDirectory, projectsDirectory);
  let reportCount = 0;
  let activityCount = 0;
  for (const entry of projectEntries) {
    const result = await migrateProject(projectsDirectory, entry.name, now);
    reportCount += result.reportCount;
    activityCount += result.activityCount;
  }
  if (reportCount !== activityCount) {
    throw new Error(
      `Codrive state migration recovered ${activityCount} of ${reportCount} task reports`,
    );
  }
  await atomicWriteJson(schemaPath, {
    schemaVersion: currentStateSchemaVersion,
    migratedAt: now,
  });
  return { migrated: true, reportCount, activityCount };
}

async function migrateProject(
  projectsDirectory: string,
  projectId: string,
  now: string,
): Promise<{ reportCount: number; activityCount: number }> {
  const directory = join(projectsDirectory, projectId);
  const eventsPath = join(directory, "events.ndjson");
  const events = await readEvents(eventsPath);
  const eventIds = new Set(events.map(({ eventId }) => eventId));
  const activities = events.flatMap(readActivity);
  const activityIds = new Set(activities.map(({ id }) => id));
  const reportActivities = new Map(
    activities
      .filter(({ outcome }) => Boolean(outcome))
      .map((activity) => [reportKey(taskReportFromActivity(activity)), activity]),
  );
  const appended: CodriveEvent[] = [];
  let reportCount = 0;
  const reportActivityIds: string[] = [];

  for (const event of events) {
    if (event.type === "task.reported") {
      const legacyTask = event.state?.task as LegacyTask | undefined;
      const report = legacyTask?.latestReport;
      const execution = legacyTask?.currentExecution;
      if (!report || !execution?.action) continue;
      reportCount += 1;
      const activity = createTaskReportActivity({
        activityId: `activity_${event.eventId}`,
        projectId,
        action: execution.action,
        report,
        ...(execution.threadId ? { threadId: execution.threadId } : {}),
        occurredAt: event.occurredAt,
      });
      reportActivityIds.push(activity.id);
      reportActivities.set(reportKey(report), activity);
      appendActivityEvent(event, activity, appended, eventIds, activityIds);
      continue;
    }
    if (event.type === "task.cancelled" && event.taskId) {
      const activity = createTaskLifecycleActivity({
        activityId: `activity_${event.eventId}`,
        projectId,
        taskId: event.taskId,
        type: "cancelled",
        summary: event.reason ?? "任务已取消。",
        occurredAt: event.occurredAt,
        ...(event.attemptId ? { attemptId: event.attemptId } : {}),
        ...(event.before?.action ? { action: event.before.action as TaskExecution["action"] } : {}),
        ...(event.threadId ? { threadId: event.threadId } : {}),
        evidence: {
          reason: event.reason ?? "任务已取消。",
          ...(isCancellationBasis(event.data?.decisionBasis)
            ? { decisionBasis: event.data.decisionBasis }
            : {}),
        },
      });
      appendActivityEvent(event, activity, appended, eventIds, activityIds);
      continue;
    }
    if (event.type === "turn.failed" && event.taskId && event.after?.status === "blocked") {
      const activity = createTaskLifecycleActivity({
        activityId: `activity_${event.eventId}`,
        projectId,
        taskId: event.taskId,
        type: "execution_failed",
        summary: event.reason ?? "任务执行失败。",
        occurredAt: event.occurredAt,
        ...(event.attemptId ? { attemptId: event.attemptId } : {}),
        ...(event.after.action ? { action: event.after.action as TaskExecution["action"] } : {}),
        ...(event.threadId ? { threadId: event.threadId } : {}),
        evidence: { reason: event.reason ?? "任务执行失败。" },
      });
      appendActivityEvent(event, activity, appended, eventIds, activityIds);
    }
  }

  const taskDirectory = join(directory, "tasks");
  const taskFiles = (await readdir(taskDirectory)).filter((file) => file.endsWith(".json"));
  const migratedTasks: Task[] = [];
  for (const file of taskFiles) {
    const raw = await readJson<Record<string, unknown>>(join(taskDirectory, file));
    const task = migrateTask(raw, reportActivities);
    migratedTasks.push(task);
    await atomicWriteJson(join(taskDirectory, file), task);
  }

  const rawProject = await readJson<Record<string, unknown>>(join(directory, "project.json"));
  const project = migrateProjectRecord(rawProject);
  await atomicWriteJson(join(directory, "project.json"), project);

  for (const task of migratedTasks) {
    const eventId = `migration_state_${task.id}`;
    if (!eventIds.has(eventId)) {
      appended.push({
        schemaVersion: 1,
        eventId,
        type: "state.migrated",
        source: "system",
        projectId,
        taskId: task.id,
        occurredAt: now,
        state: { task },
      });
    }
  }
  const projectEventId = `migration_state_${project.id}`;
  if (!eventIds.has(projectEventId)) {
    appended.push({
      schemaVersion: 1,
      eventId: projectEventId,
      type: "state.migrated",
      source: "system",
      projectId,
      occurredAt: now,
      state: { project },
    });
  }
  if (appended.length > 0) {
    await appendFile(
      eventsPath,
      appended.map((event) => JSON.stringify(event)).join("\n") + "\n",
      "utf8",
    );
  }

  return {
    reportCount,
    activityCount: reportActivityIds.filter((activityId) =>
      activityIds.has(activityId),
    ).length,
  };
}

function migrateProjectRecord(raw: Record<string, unknown>): Project {
  const legacy = raw as unknown as LegacyProject;
  const record = { ...raw };
  const planning = { ...(legacy.planning ?? {}) } as LegacyPlanning;
  const execution = legacy.currentExecution
    ? migrateProjectExecution(legacy.currentExecution, legacy.latestReport)
    : undefined;
  const evaluatedRevision =
    planning.evaluatedRevision ??
    (planning.lastDecision?.revision === planning.revision
      ? planning.revision
      : execution?.action === "select_tasks" &&
          execution.planningRevision === planning.revision &&
          Boolean(execution.result)
        ? planning.revision
        : undefined);
  delete planning.lastDecision;
  const migratedPlanning: ProjectPlanningState = {
    revision: planning.revision,
    changedAt: planning.changedAt,
    changeReason: planning.changeReason,
    ...(evaluatedRevision === undefined ? {} : { evaluatedRevision }),
    ...(planning.concurrencyLimit === undefined
      ? {}
      : { concurrencyLimit: planning.concurrencyLimit }),
  };

  delete record.latestReport;
  record.planning = migratedPlanning;
  if (execution) record.currentExecution = execution;
  return record as unknown as Project;
}

function migrateProjectExecution(
  execution: LegacyProjectExecution,
  latestReport?: ProjectReport,
): ProjectExecution {
  const record = { ...execution } as Record<string, unknown>;
  const result = execution.result ?? execution.report ??
    (latestReport?.attemptId === execution.attemptId ? latestReport : undefined);
  delete record.report;
  if (result) record.result = result;
  return record as unknown as ProjectExecution;
}

function migrateTask(
  raw: Record<string, unknown>,
  reportActivities: Map<string, TaskActivity>,
): Task {
  const legacy = raw as unknown as LegacyTask;
  const record = { ...raw };
  delete record.latestReport;
  delete record.reviewAttempts;
  delete record.developmentThreadId;
  delete record.workspacePath;
  delete record.baseCommit;
  delete record.candidateCommit;
  delete record.reviewedMainCommit;
  delete record.mergedCommit;

  const execution = legacy.currentExecution;
  if (execution?.status === "completed") {
    delete record.currentExecution;
  } else if (execution) {
    const migrated = { ...execution } as Record<string, unknown>;
    const report = execution.report;
    delete migrated.report;
    if (report) {
      const activity = reportActivities.get(reportKey(report));
      if (activity) migrated.submittedActivityId = activity.id;
    }
    record.currentExecution = migrated;
  }
  return record as unknown as Task;
}

function appendActivityEvent(
  source: CodriveEvent,
  activity: TaskActivity,
  appended: CodriveEvent[],
  eventIds: Set<string>,
  activityIds: Set<string>,
): void {
  if (activityIds.has(activity.id)) return;
  const eventId = `migration_${source.eventId}`;
  if (eventIds.has(eventId)) return;
  activityIds.add(activity.id);
  eventIds.add(eventId);
  appended.push({
    schemaVersion: 1,
    eventId,
    type: "task.activity_recorded",
    source: "system",
    projectId: activity.projectId,
    taskId: activity.taskId,
    ...(activity.attemptId ? { attemptId: activity.attemptId } : {}),
    ...(activity.threadId ? { threadId: activity.threadId } : {}),
    occurredAt: activity.occurredAt,
    data: { activity },
  });
}

function readActivity(event: CodriveEvent): TaskActivity[] {
  const value = event.data?.activity;
  return value && typeof value === "object" && "id" in value
    ? [value as TaskActivity]
    : [];
}

function reportKey(report: TaskReport): string {
  return `${report.taskId}:${report.attemptId}:${JSON.stringify(report)}`;
}

async function backupState(stateDirectory: string, projectsDirectory: string) {
  const backupDirectory = join(stateDirectory, "backups", "state-v1");
  if (await exists(backupDirectory)) return;
  await mkdir(join(stateDirectory, "backups"), { recursive: true });
  await cp(projectsDirectory, join(backupDirectory, "projects"), {
    recursive: true,
  });
}

async function readEvents(path: string): Promise<CodriveEvent[]> {
  try {
    return (await readFile(path, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as CodriveEvent);
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw error;
  }
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function readJsonIfExists<T>(path: string): Promise<T | undefined> {
  try {
    return await readJson<T>(path);
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, path);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function isCancellationBasis(value: unknown): value is "user_confirmed" | "agent_decision" {
  return value === "user_confirmed" || value === "agent_decision";
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

type LegacyProjectExecution = ProjectExecution & { report?: ProjectReport };
type LegacyPlanning = ProjectPlanningState & {
  lastDecision?: { revision: number };
};
type LegacyProject = Project & {
  latestReport?: ProjectReport;
  planning: LegacyPlanning;
  currentExecution?: LegacyProjectExecution;
};
type LegacyTaskExecution = TaskExecution & { report?: TaskReport };
type LegacyTask = Task & {
  latestReport?: TaskReport;
  currentExecution?: LegacyTaskExecution;
};
