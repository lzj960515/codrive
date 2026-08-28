import { randomUUID } from "node:crypto";
import { access, copyFile, cp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { CodriveEvent, Project, Task } from "../domain/types.js";
import {
  assertCurrentEvent,
  assertCurrentProject,
  assertCurrentTask,
} from "./state-v4-validation.js";

type JsonRecord = Record<string, unknown>;

interface ProjectMigration {
  projectId: string;
  taskCount: number;
  eventCount: number;
  activityCount: number;
}

export async function upgradeStateV3ToV4(stateDirectory: string, upgradedAt: string, createdAt: string): Promise<void> {
  const projectsDirectory = join(stateDirectory, "projects");
  await mkdir(projectsDirectory, { recursive: true });
  await backupStateV3(stateDirectory, projectsDirectory);

  const migrationRoot = join(stateDirectory, `.state-v4-${randomUUID()}.tmp`);
  const migratedProjects = join(migrationRoot, "projects");
  await cp(projectsDirectory, migratedProjects, { recursive: true });

  try {
    const projectIds = await directoryNames(migratedProjects);
    const results: ProjectMigration[] = [];
    for (const projectId of projectIds) {
      results.push(await migrateProject(migratedProjects, projectId));
    }
    validateMigration(results, projectIds.length);
    await replaceProjectsAndMarker(stateDirectory, projectsDirectory, migratedProjects, {
      schemaVersion: 4,
      createdAt,
      migratedAt: upgradedAt,
    });
  } finally {
    await rm(migrationRoot, { recursive: true, force: true });
  }
}

async function migrateProject(projectsDirectory: string, projectId: string): Promise<ProjectMigration> {
  const projectDirectory = join(projectsDirectory, projectId);
  const eventsPath = join(projectDirectory, "events.ndjson");
  const rawEvents = await readEvents(eventsPath);
  const workByTask = new Map<string, string>();
  let activityCount = 0;
  const events = new Array<JsonRecord>(rawEvents.length);
  for (const index of chronologicalEventIndexes(rawEvents)) {
    const migrated = migrateEvent(rawEvents[index]!, workByTask);
    if (isTaskActivityEvent(migrated)) activityCount += 1;
    events[index] = migrated;
  }

  const tasksDirectory = join(projectDirectory, "tasks");
  const taskFiles = (await readdir(tasksDirectory)).filter((file) => file.endsWith(".json")).sort();
  const tasks: JsonRecord[] = [];
  for (const file of taskFiles) {
    const path = join(tasksDirectory, file);
    const raw = await readJson<JsonRecord>(path);
    const migrated = migrateTask(raw, workByTask.get(requireString(raw.id, "task id")));
    tasks.push(migrated);
    await atomicWriteJson(path, migrated);
  }

  const projectPath = join(projectDirectory, "project.json");
  const rawProject = await readJson<JsonRecord>(projectPath);
  const project = migrateLifecycleRecord(rawProject);
  validateProjectMigration(rawProject, project);
  assertCurrentProject(project as unknown as Project);
  await atomicWriteJson(projectPath, project);
  await writeEvents(eventsPath, events);
  validateEvents(rawEvents, events);
  validateNoLegacyRuntimeValues({ project, events, tasks });

  return {
    projectId,
    taskCount: taskFiles.length,
    eventCount: events.length,
    activityCount,
  };
}

function migrateEvent(raw: JsonRecord, workByTask: Map<string, string>): JsonRecord {
  const taskId = typeof raw.taskId === "string" ? raw.taskId : undefined;
  const event = migrateLifecycleRecord(raw);
  if (event.type === "task.changes_requested") {
    event.type = "task.work_requested";
  }

  if (isTaskActivityEvent(raw)) {
    const data = { ...(raw.data as JsonRecord) };
    const migratedActivity = migrateActivity(data.activity as JsonRecord, taskId ? workByTask.get(taskId) : undefined);
    data.activity = migratedActivity;
    event.data = migrateLifecycleRecord(data);
    if (taskId && migratedActivity.type === "work_completed") {
      workByTask.set(taskId, requireString(migratedActivity.id, "activity id"));
    }
  }

  const currentWorkActivityId = taskId ? workByTask.get(taskId) : undefined;
  if (event.state && isRecord(event.state)) {
    const state = { ...event.state };
    if (state.task && isRecord(state.task)) {
      state.task = migrateTask(state.task, currentWorkActivityId);
    }
    if (state.project && isRecord(state.project)) {
      state.project = migrateLifecycleRecord(state.project);
    }
    event.state = state;
  }
  assertCurrentEvent(event as unknown as CodriveEvent);
  return event;
}

function migrateActivity(raw: JsonRecord, currentWorkActivityId?: string): JsonRecord {
  const activity = migrateLifecycleRecord(raw);
  const action = migrateAction(raw.action);
  if (action) activity.action = action;
  const type = migrateActivityType(raw.type, raw.outcome);
  if (type) activity.type = type;

  if (type === "work_completed") {
    activity.workActivityId = requireString(activity.id, "activity id");
  } else if (["review", "integrate"].includes(String(action))) {
    if (!currentWorkActivityId && isReportActivity(activity)) {
      throw new Error(`Cannot bind ${String(action)} activity ${String(activity.id)} to a work activity`);
    }
    if (currentWorkActivityId) activity.workActivityId = currentWorkActivityId;
  }
  validateActivityMigration(raw, activity);
  return activity;
}

function migrateTask(raw: JsonRecord, currentWorkActivityId?: string): JsonRecord {
  const task = migrateLifecycleRecord(raw);
  if (currentWorkActivityId) task.workActivityId = currentWorkActivityId;

  if (task.currentExecution && isRecord(task.currentExecution)) {
    const execution = { ...task.currentExecution };
    const action = migrateAction(execution.action);
    if (action) execution.action = action;
    if (["review", "integrate"].includes(String(action))) {
      if (!currentWorkActivityId) {
        throw new Error(`Cannot bind open ${String(action)} execution for task ${String(task.id)} to a work activity`);
      }
      execution.workActivityId = currentWorkActivityId;
    } else {
      delete execution.workActivityId;
    }
    task.currentExecution = execution;
  }

  if (["review", "integrate"].includes(String(task.requestedAction)) && !currentWorkActivityId) {
    throw new Error(
      `Cannot bind requested ${String(task.requestedAction)} for task ${String(task.id)} to a work activity`,
    );
  }
  validateTaskMigration(raw, task);
  assertCurrentTask(task as unknown as Task);
  return task;
}

function migrateLifecycleRecord(raw: JsonRecord): JsonRecord {
  return Object.fromEntries(
    Object.entries(raw).map(([key, value]) => {
      if (key === "action" || key === "requestedAction") {
        return [key, migrateAction(value) ?? value];
      }
      if (key === "status") return [key, migrateStatus(value)];
      if (Array.isArray(value)) {
        return [key, value.map((entry) => (isRecord(entry) ? migrateLifecycleRecord(entry) : entry))];
      }
      return [key, isRecord(value) ? migrateLifecycleRecord(value) : value];
    }),
  );
}

function migrateAction(value: unknown): string | undefined {
  if (value === "develop" || value === "rework") return "work";
  return typeof value === "string" ? value : undefined;
}

function migrateStatus(value: unknown): unknown {
  return value === "developing" || value === "changes_requested" ? "working" : value;
}

function migrateActivityType(type: unknown, outcome: unknown): string | undefined {
  if (type === "development_completed" || type === "rework_completed") {
    return "work_completed";
  }
  if (type === "review_requested" && outcome === "needs_review") {
    return "work_completed";
  }
  return typeof type === "string" ? type : undefined;
}

function validateTaskMigration(raw: JsonRecord, migrated: JsonRecord): void {
  const before = isRecord(raw.currentExecution) ? raw.currentExecution : undefined;
  const after = isRecord(migrated.currentExecution) ? migrated.currentExecution : undefined;
  if (Boolean(before) !== Boolean(after)) {
    throw new Error("State v4 migration changed task execution ownership");
  }
  if (
    before &&
    after &&
    !sameJson(
      withoutKeys(before, ["action", "workActivityId"]),
      withoutKeys(after, ["action", "workActivityId"]),
    )
  ) {
    throw new Error("State v4 migration changed task execution evidence");
  }
  if (
    !sameJson(
      withoutKeys(raw, [
        "status",
        "requestedAction",
        "workActivityId",
        "currentExecution",
      ]),
      withoutKeys(migrated, [
        "status",
        "requestedAction",
        "workActivityId",
        "currentExecution",
      ]),
    )
  ) {
    throw new Error("State v4 migration changed task evidence");
  }
}

function validateProjectMigration(raw: JsonRecord, migrated: JsonRecord): void {
  if (!sameJson(raw, migrated)) {
    throw new Error("State v4 migration changed project evidence");
  }
}

function validateActivityMigration(raw: JsonRecord, migrated: JsonRecord): void {
  if (
    !sameJson(
      withoutKeys(raw, ["type", "action", "workActivityId"]),
      withoutKeys(migrated, ["type", "action", "workActivityId"]),
    )
  ) {
    throw new Error("State v4 migration changed task activity evidence");
  }
}

function validateEvents(raw: JsonRecord[], migrated: JsonRecord[]): void {
  if (raw.length !== migrated.length) {
    throw new Error("State v4 migration changed the event count");
  }
  for (let index = 0; index < raw.length; index += 1) {
    for (const field of ["eventId", "occurredAt"] as const) {
      if (raw[index]?.[field] !== migrated[index]?.[field]) {
        throw new Error(`State v4 migration changed event ${field}`);
      }
    }
    const beforeActivity = activityFromEvent(raw[index]!);
    const afterActivity = activityFromEvent(migrated[index]!);
    if (Boolean(beforeActivity) !== Boolean(afterActivity)) {
      throw new Error("State v4 migration changed the activity count");
    }
    if (beforeActivity && afterActivity) {
      for (const field of ["id", "occurredAt"] as const) {
        if (beforeActivity[field] !== afterActivity[field]) {
          throw new Error(`State v4 migration changed activity ${field}`);
        }
      }
    }
  }
}

function validateMigration(results: ProjectMigration[], projectCount: number): void {
  if (results.length !== projectCount) {
    throw new Error("State v4 migration changed the project count");
  }
  for (const result of results) {
    if (
      !Number.isInteger(result.taskCount) ||
      !Number.isInteger(result.eventCount) ||
      !Number.isInteger(result.activityCount)
    ) {
      throw new Error(`State v4 migration did not validate ${result.projectId}`);
    }
  }
}

function withoutKeys(record: JsonRecord, keys: readonly string[]): JsonRecord {
  return Object.fromEntries(
    Object.entries(record).filter(([key]) => !keys.includes(key)),
  );
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateNoLegacyRuntimeValues(input: {
  project: JsonRecord;
  events: JsonRecord[];
  tasks: JsonRecord[];
}): void {
  const serialized = JSON.stringify(input);
  if (
    /"(?:action|requestedAction)":"(?:develop|rework)"/.test(serialized) ||
    /"status":"(?:developing|changes_requested)"/.test(serialized) ||
    /"type":"(?:development_completed|rework_completed|review_requested)"/.test(serialized)
  ) {
    throw new Error("State v4 migration retained a legacy lifecycle value");
  }
}

async function replaceProjectsAndMarker(
  stateDirectory: string,
  projectsDirectory: string,
  migratedProjects: string,
  marker: JsonRecord,
): Promise<void> {
  const displacedProjects = join(stateDirectory, `.state-v3-projects-${randomUUID()}.old`);
  const markerPath = join(stateDirectory, "state-schema.json");
  const markerTemporaryPath = `${markerPath}.${randomUUID()}.tmp`;
  await writeFile(markerTemporaryPath, `${JSON.stringify(marker, null, 2)}\n`, "utf8");
  await rename(projectsDirectory, displacedProjects);
  try {
    await rename(migratedProjects, projectsDirectory);
    await rename(markerTemporaryPath, markerPath);
  } catch (error) {
    await rm(projectsDirectory, { recursive: true, force: true });
    await rename(displacedProjects, projectsDirectory);
    await rm(markerTemporaryPath, { force: true });
    throw error;
  }
  await rm(displacedProjects, { recursive: true, force: true });
}

async function backupStateV3(stateDirectory: string, projectsDirectory: string): Promise<void> {
  const backupDirectory = join(stateDirectory, "backups", "state-v3");
  if (await exists(backupDirectory)) {
    await Promise.all([access(join(backupDirectory, "projects")), access(join(backupDirectory, "state-schema.json"))]);
    return;
  }
  const temporary = `${backupDirectory}.${randomUUID()}.tmp`;
  await mkdir(temporary, { recursive: true });
  await cp(projectsDirectory, join(temporary, "projects"), { recursive: true });
  await copyFile(join(stateDirectory, "state-schema.json"), join(temporary, "state-schema.json"));
  await mkdir(join(stateDirectory, "backups"), { recursive: true });
  await rename(temporary, backupDirectory);
}

async function directoryNames(path: string): Promise<string[]> {
  return (await readdir(path, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map(({ name }) => name)
    .sort();
}

function chronologicalEventIndexes(events: JsonRecord[]): number[] {
  return events
    .map((event, index) => ({
      index,
      occurredAt: requireTimestamp(event.occurredAt, "event occurredAt"),
    }))
    .sort((left, right) => left.occurredAt - right.occurredAt || left.index - right.index)
    .map(({ index }) => index);
}

async function readEvents(path: string): Promise<JsonRecord[]> {
  const contents = await readFile(path, "utf8");
  return contents
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as JsonRecord);
}

async function writeEvents(path: string, events: JsonRecord[]): Promise<void> {
  const contents = events.length ? `${events.map((event) => JSON.stringify(event)).join("\n")}\n` : "";
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, contents, "utf8");
  await rename(temporary, path);
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

function activityFromEvent(event: JsonRecord): JsonRecord | undefined {
  return isTaskActivityEvent(event) ? ((event.data as JsonRecord).activity as JsonRecord) : undefined;
}

function isTaskActivityEvent(event: JsonRecord): boolean {
  return event.type === "task.activity_recorded" && isRecord(event.data) && isRecord(event.data.activity);
}

function isReportActivity(activity: JsonRecord): boolean {
  return typeof activity.outcome === "string";
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`Invalid ${label}`);
  return value;
}

function requireTimestamp(value: unknown, label: string): number {
  const timestamp = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(timestamp)) throw new Error(`Invalid ${label}`);
  return timestamp;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
