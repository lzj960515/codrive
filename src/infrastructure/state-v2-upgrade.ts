import { randomUUID } from "node:crypto";
import {
  access,
  appendFile,
  copyFile,
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import { createProductFacts } from "../domain/product-facts.js";
import type {
  CodriveEvent,
  Project,
  ProjectExecution,
  ProjectPlanningState,
  Task,
  TaskExecution,
} from "../domain/types.js";

interface ProjectUpgrade {
  project: Project;
  tasks: TaskUpgrade[];
  legacyContextNoteCount: number;
  eventIds: Set<string>;
}

interface TaskUpgrade {
  path: string;
  task: Task;
  changed: boolean;
}

export async function upgradeStateV2ToV3(
  stateDirectory: string,
  upgradedAt: string,
): Promise<void> {
  const projectsDirectory = join(stateDirectory, "projects");
  await mkdir(projectsDirectory, { recursive: true });
  const projectEntries = await readProjectEntries(projectsDirectory);
  const upgrades = await Promise.all(
    projectEntries.map((entry) =>
      prepareProjectUpgrade(projectsDirectory, entry, upgradedAt),
    ),
  );

  await backupStateV2(stateDirectory, projectsDirectory);
  for (const upgrade of upgrades) {
    await applyProjectUpgrade(projectsDirectory, upgrade, upgradedAt);
  }
}

async function prepareProjectUpgrade(
  projectsDirectory: string,
  projectId: string,
  upgradedAt: string,
): Promise<ProjectUpgrade> {
  const projectDirectory = join(projectsDirectory, projectId);
  const rawProject = await readJson<Record<string, unknown>>(
    join(projectDirectory, "project.json"),
  );
  const productDocument = await readFile(
    join(projectDirectory, "PROJECT.md"),
    "utf8",
  );
  const { project, legacyContextNoteCount } = upgradeProject(
    rawProject,
    productDocument,
    upgradedAt,
  );
  const tasksDirectory = join(projectDirectory, "tasks");
  const taskFiles = (await readdir(tasksDirectory))
    .filter((file) => file.endsWith(".json"))
    .sort();
  const tasks = await Promise.all(
    taskFiles.map(async (file): Promise<TaskUpgrade> => {
      const path = join(tasksDirectory, file);
      const rawTask = await readJson<Record<string, unknown>>(path);
      return { path, ...upgradeTask(rawTask) };
    }),
  );
  const events = await readEvents(join(projectDirectory, "events.ndjson"));
  return {
    project,
    tasks,
    legacyContextNoteCount,
    eventIds: new Set(events.map(({ eventId }) => eventId)),
  };
}

function upgradeProject(
  raw: Record<string, unknown>,
  productDocument: string,
  upgradedAt: string,
): { project: Project; legacyContextNoteCount: number } {
  const record = { ...raw };
  const contextNotes = Array.isArray(record.contextNotes)
    ? record.contextNotes.filter((note) => typeof note === "string")
    : [];
  const changedAt =
    typeof record.updatedAt === "string" &&
    Number.isFinite(Date.parse(record.updatedAt))
      ? record.updatedAt
      : upgradedAt;

  if (!record.productFacts) {
    record.productFacts = createProductFacts(productDocument, changedAt);
  }
  const planning = { ...((record.planning ?? {}) as Record<string, unknown>) };
  if (planning.changeReason === "project_decision_recorded") {
    planning.changeReason = "product_document_updated";
  }
  delete planning.lastDecision;
  record.planning = planning as unknown as ProjectPlanningState;

  if (record.currentExecution) {
    record.currentExecution = upgradeProjectExecution(
      record.currentExecution as ProjectExecution & {
        report?: ProjectExecution["result"];
      },
    );
  }
  delete record.latestReport;
  delete record.contextNotes;
  delete record.evaluation;
  return {
    project: record as unknown as Project,
    legacyContextNoteCount: contextNotes.length,
  };
}

function upgradeProjectExecution(
  execution: ProjectExecution & { report?: ProjectExecution["result"] },
): ProjectExecution {
  const record = { ...execution };
  if (!record.result && record.report) record.result = record.report;
  delete record.report;
  return record;
}

function upgradeTask(raw: Record<string, unknown>): {
  task: Task;
  changed: boolean;
} {
  const record = { ...raw };
  const execution = record.currentExecution as
    | (Omit<TaskExecution, "reportOpportunityId"> & {
        reportOpportunityId?: string;
      })
    | undefined;
  let changed = false;
  if (execution && !execution.reportOpportunityId) {
    record.currentExecution = {
      ...execution,
      reportOpportunityId: `report_opportunity_${randomUUID()}`,
    } satisfies TaskExecution;
    changed = true;
  }
  return { task: record as unknown as Task, changed };
}

async function applyProjectUpgrade(
  projectsDirectory: string,
  upgrade: ProjectUpgrade,
  upgradedAt: string,
): Promise<void> {
  const projectDirectory = join(projectsDirectory, upgrade.project.id);
  await atomicWriteJson(join(projectDirectory, "project.json"), upgrade.project);
  for (const task of upgrade.tasks) {
    if (task.changed) await atomicWriteJson(task.path, task.task);
  }

  const events: CodriveEvent[] = [];
  const projectEventId = `migration_v3_state_${upgrade.project.id}`;
  if (!upgrade.eventIds.has(projectEventId)) {
    events.push({
      schemaVersion: 1,
      eventId: projectEventId,
      type: "state.migrated",
      source: "system",
      projectId: upgrade.project.id,
      occurredAt: upgradedAt,
      data: {
        fromSchemaVersion: 2,
        toSchemaVersion: 3,
        legacyContextNoteCount: upgrade.legacyContextNoteCount,
      },
      state: { project: upgrade.project },
    });
  }
  for (const { task } of upgrade.tasks) {
    const eventId = `migration_v3_state_${task.id}`;
    if (task.currentExecution && !upgrade.eventIds.has(eventId)) {
      events.push({
        schemaVersion: 1,
        eventId,
        type: "state.migrated",
        source: "system",
        projectId: upgrade.project.id,
        taskId: task.id,
        occurredAt: upgradedAt,
        data: { fromSchemaVersion: 2, toSchemaVersion: 3 },
        state: { task },
      });
    }
  }
  if (events.length > 0) {
    await appendFile(
      join(projectDirectory, "events.ndjson"),
      `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
      "utf8",
    );
  }
}

async function backupStateV2(
  stateDirectory: string,
  projectsDirectory: string,
): Promise<void> {
  const backupDirectory = join(stateDirectory, "backups", "state-v2");
  if (await exists(backupDirectory)) {
    await Promise.all([
      access(join(backupDirectory, "projects")),
      access(join(backupDirectory, "state-schema.json")),
    ]);
    return;
  }

  const temporaryDirectory = `${backupDirectory}.${randomUUID()}.tmp`;
  await mkdir(temporaryDirectory, { recursive: true });
  await cp(projectsDirectory, join(temporaryDirectory, "projects"), {
    recursive: true,
  });
  await copyFile(
    join(stateDirectory, "state-schema.json"),
    join(temporaryDirectory, "state-schema.json"),
  );
  await mkdir(join(stateDirectory, "backups"), { recursive: true });
  await rename(temporaryDirectory, backupDirectory);
}

async function readProjectEntries(projectsDirectory: string): Promise<string[]> {
  try {
    return (await readdir(projectsDirectory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map(({ name }) => name)
      .sort();
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw error;
  }
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

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
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

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
