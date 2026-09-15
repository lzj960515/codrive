import { randomUUID } from "node:crypto";
import { access, copyFile, cp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CodriveEvent, Project, ProjectExecution, ProjectReport, Task } from "../domain/types.js";
import { assertCurrentEvent, assertCurrentProject, assertCurrentTask } from "./state-validation.js";

type LegacyProject = Omit<Project, "currentExecution"> & {
  currentExecution?: Omit<ProjectExecution, "reportOpportunityId" | "result"> & {
    result?: Omit<ProjectReport, "reportOpportunityId">;
  };
};
type LegacyEvent = Omit<CodriveEvent, "state"> & { state?: { project?: LegacyProject; task?: Task } };

/** 旧临时规划没有磁盘会话；保留事实与问题，让新版在原项目中重新规划。 */
export async function upgradeStateV4ToV5(stateDirectory: string, migratedAt: string, createdAt: string): Promise<void> {
  const projectsDirectory = join(stateDirectory, "projects");
  await mkdir(projectsDirectory, { recursive: true });
  await backupState(stateDirectory, projectsDirectory);
  const temporary = join(stateDirectory, `.state-v5-${randomUUID()}.tmp`);
  const migratedProjects = join(temporary, "projects");
  await cp(projectsDirectory, migratedProjects, { recursive: true });
  try {
    for (const entry of await readdir(migratedProjects, { withFileTypes: true })) {
      if (entry.isDirectory()) await migrateProject(join(migratedProjects, entry.name), migratedAt);
    }
    await replaceState(stateDirectory, migratedProjects, { schemaVersion: 5, createdAt, migratedAt });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function migrateProject(directory: string, migratedAt: string): Promise<void> {
  const projectPath = join(directory, "project.json");
  const original = JSON.parse(await readFile(projectPath, "utf8")) as LegacyProject;
  const project = migrateProjectSnapshot(original, migratedAt);
  assertCurrentProject(project);
  await mkdir(join(directory, "milestones"), { recursive: true });
  for (const entry of await readdir(join(directory, "tasks"))) {
    if (!entry.endsWith(".json")) continue;
    const task = JSON.parse(await readFile(join(directory, "tasks", entry), "utf8")) as Task;
    assertCurrentTask(task);
    if (task.projectId !== project.id) throw new Error(`Task ${task.id} belongs to a different project`);
  }
  const eventsPath = join(directory, "events.ndjson");
  const events = await readEvents(eventsPath);
  const migratedEvents = events.map((originalEvent): CodriveEvent => {
    let event: CodriveEvent;
    const state = originalEvent.state;
    if (state?.project) {
      const { project: previousProject, ...remainingState } = state;
      const currentProjectState = ["active", "idle", "cancelled"].includes(previousProject.status);
      event = {
        ...originalEvent,
        data: {
          ...originalEvent.data,
          ...(currentProjectState
            ? (previousProject.currentExecution ? { previousExecution: previousProject.currentExecution } : {})
            : { previousPlanningSnapshot: previousProject }),
        },
        state: currentProjectState
          ? { ...remainingState, project: migrateProjectSnapshot(previousProject, previousProject.updatedAt) }
          : remainingState,
      };
    } else {
      event = originalEvent as CodriveEvent;
    }
    assertCurrentEvent(event);
    return event;
  });
  const transition: CodriveEvent = {
    schemaVersion: 1, eventId: randomUUID(), type: "project.planning_migrated", source: "system",
    projectId: project.id, occurredAt: migratedAt,
    data: {
      previousExecution: original.currentExecution ?? null,
      reason: "Persistent project planning replaces ephemeral selection",
    },
    state: { project },
  };
  assertCurrentEvent(transition);
  migratedEvents.push(transition);
  await writeJson(projectPath, project);
  await writeFile(eventsPath, migratedEvents.map((event) => JSON.stringify(event)).join("\n") + "\n", "utf8");
}

function migrateProjectSnapshot(original: LegacyProject, changedAt: string): Project {
  const { currentExecution, ...project } = original;
  const result = currentExecution?.result;
  const unfinished = currentExecution && currentExecution.status !== "completed";
  const planning = { ...project.planning };
  if (unfinished) {
    planning.revision += 1;
    delete planning.evaluatedRevision;
    planning.changedAt = changedAt;
    planning.changeReason = "manual_replan";
  }
  return {
    ...project,
    requestedAction: null,
    planning,
    ...(result?.outcome === "needs_input" ? {
      planningQuestion: [result.summary, result.question].filter(Boolean).join("\n\n"),
    } : {}),
    updatedAt: changedAt,
  };
}

async function readEvents(path: string): Promise<LegacyEvent[]> {
  try {
    return (await readFile(path, "utf8")).split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
  } catch (error) {
    if (missing(error)) return [];
    throw error;
  }
}

async function backupState(stateDirectory: string, projectsDirectory: string): Promise<void> {
  const destination = join(stateDirectory, "backups", "state-v4");
  try {
    await access(destination);
    await access(join(destination, "projects"));
    await access(join(destination, "state-schema.json"));
    return;
  } catch (error) {
    if (!missing(error)) throw error;
  }
  const temporary = `${destination}.${randomUUID()}.tmp`;
  await mkdir(temporary, { recursive: true });
  await cp(projectsDirectory, join(temporary, "projects"), { recursive: true });
  await copyFile(join(stateDirectory, "state-schema.json"), join(temporary, "state-schema.json"));
  await rename(temporary, destination);
}

async function replaceState(stateDirectory: string, migratedProjects: string, marker: { schemaVersion: number; createdAt: string; migratedAt: string }): Promise<void> {
  const projectsDirectory = join(stateDirectory, "projects");
  const displaced = join(stateDirectory, `.state-v4-projects-${randomUUID()}.old`);
  const markerPath = join(stateDirectory, "state-schema.json");
  const temporaryMarker = `${markerPath}.${randomUUID()}.tmp`;
  await writeJson(temporaryMarker, marker);
  await rename(projectsDirectory, displaced);
  try {
    await rename(migratedProjects, projectsDirectory);
    await rename(temporaryMarker, markerPath);
  } catch (error) {
    await rm(projectsDirectory, { recursive: true, force: true });
    await rename(displaced, projectsDirectory);
    await rm(temporaryMarker, { force: true });
    throw error;
  }
  await rm(displaced, { recursive: true, force: true });
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
