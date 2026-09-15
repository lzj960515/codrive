import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ProjectStore } from "../../src/infrastructure/project-store.js";
import { ensureCurrentState } from "../../src/infrastructure/state-schema.js";

const createdAt = "2026-09-01T00:00:00.000Z";

describe("state schema v5 upgrade", () => {
  it("retires ephemeral selection without changing paused task execution or losing recovery history", async () => {
    const { directory, project, task } = await persistedV4State();
    await ensureCurrentState(directory);
    const marker = await readFile(join(directory, "state-schema.json"), "utf8");
    expect(JSON.parse(marker).schemaVersion).toBe(5);
    const store = new ProjectStore(directory);
    await store.initialize();
    let snapshot = (await store.getProject(project.id))!;
    expect(snapshot.project.scheduling).toBe("paused");
    expect(snapshot.project.currentExecution).toBeUndefined();
    expect(snapshot.project.requestedAction).toBeNull();
    expect(snapshot.project.planning.revision).toBe(2);
    expect(snapshot.project.planning.evaluatedRevision).toBeUndefined();
    expect(snapshot.tasks).toEqual([task]);
    expect(snapshot.milestones).toEqual([]);
    const history = await store.listProjectEvents(project.id);
    expect(history.at(-1)).toMatchObject({
      type: "project.planning_migrated",
      data: { previousExecution: project.currentExecution },
    });
    await rm(join(directory, "projects", project.id, "project.json"));
    await new ProjectStore(directory).initialize();
    snapshot = (await store.getProject(project.id))!;
    expect(snapshot.project.currentExecution).toBeUndefined();
    expect(snapshot.project.scheduling).toBe("paused");
    await ensureCurrentState(directory);
    expect(await readFile(join(directory, "state-schema.json"), "utf8")).toBe(marker);
    expect(await store.listProjectEvents(project.id)).toEqual(history);
    expect(JSON.parse(await readFile(join(directory, "backups/state-v4/projects", project.id, "project.json"), "utf8"))).toEqual(project);
  });

  it("preserves a pending user question as planning context instead of treating it as approval", async () => {
    const { directory, project } = await persistedV4State();
    project.currentExecution.status = "waiting_for_input";
    Object.assign(project.currentExecution, { result: {
      projectId: project.id, attemptId: "selection_old", outcome: "needs_input",
      summary: "The old capability has a consumer.", question: "Keep that capability?",
    } });
    await writeFile(join(directory, "projects", project.id, "project.json"), JSON.stringify(project));
    await ensureCurrentState(directory);
    const snapshot = (await new ProjectStore(directory).getProject(project.id))!;
    expect(snapshot.project.planningQuestion).toBe("The old capability has a consumer.\n\nKeep that capability?");
    expect(snapshot.project.scheduling).toBe("paused");
  });

  it("retains obsolete historical project snapshots as evidence rather than recovery state", async () => {
    const { directory, project } = await persistedV4State();
    const eventsPath = join(directory, "projects", project.id, "events.ndjson");
    const event = JSON.parse(await readFile(eventsPath, "utf8"));
    event.state.project.status = "evaluating";
    event.state.project.requestedAction = "evaluate_product";
    await writeFile(eventsPath, JSON.stringify(event) + "\n");
    await ensureCurrentState(directory);
    const store = new ProjectStore(directory);
    await store.initialize();
    const history = await store.listProjectEvents(project.id);
    expect(history[0]?.state?.project).toBeUndefined();
    expect(history[0]?.data?.previousPlanningSnapshot).toMatchObject({ status: "evaluating" });
    expect((await store.getProject(project.id))?.project.status).toBe("active");
  });

  it("rejects invalid legacy task data before replacing the old state", async () => {
    const { directory, project, task } = await persistedV4State();
    const marker = await readFile(join(directory, "state-schema.json"), "utf8");
    const taskPath = join(directory, "projects", project.id, "tasks", `${task.id}.json`);
    const invalid = JSON.stringify({ ...task, status: "invented" });
    await writeFile(taskPath, invalid);
    await expect(ensureCurrentState(directory)).rejects.toThrow(/status/i);
    expect(await readFile(join(directory, "state-schema.json"), "utf8")).toBe(marker);
    expect(await readFile(taskPath, "utf8")).toBe(invalid);
  });
});

async function persistedV4State() {
  const directory = await mkdtemp(join(tmpdir(), "codrive-v5-"));
  const project = {
    id: "project_old", name: "Existing", repositoryPath: "/workspace/project", defaultBranch: "main",
    status: "active", scheduling: "paused", requestedAction: "select_tasks",
    productFacts: { revision: 1, digest: "unused", changedAt: createdAt },
    planning: { revision: 1, evaluatedRevision: 1, changedAt: createdAt, changeReason: "project_registered" },
    currentExecution: { attemptId: "selection_old", action: "select_tasks", status: "running", threadId: "ephemeral_old", turnId: "turn_old", startedAt: createdAt, modelRouting: { model: "gpt-5.6-sol", route: "primary", retryCount: 0 } },
    createdAt, updatedAt: createdAt,
  };
  const task = {
    id: "task_old", projectId: project.id, title: "Existing task", description: "Keep the execution", acceptanceCriteria: [], order: 1,
    status: "working", requestedAction: "work", currentExecution: {
      attemptId: "work_old", reportOpportunityId: "report_old", action: "work", status: "waiting_for_resume",
      threadId: "persistent_work", turnId: "turn_work", startedAt: createdAt,
      modelRouting: { model: "gpt-5.6-sol", route: "primary", retryCount: 0 },
      scheduledResume: { resumeAt: "2026-09-20T00:00:00.000Z", reason: "Wait for delivery", resumePrompt: "Check delivery" },
    }, createdAt, updatedAt: createdAt,
  };
  const path = join(directory, "projects", project.id);
  await mkdir(join(path, "tasks"), { recursive: true });
  await writeFile(join(directory, "state-schema.json"), JSON.stringify({ schemaVersion: 4, createdAt }));
  await writeFile(join(path, "project.json"), JSON.stringify(project));
  await writeFile(join(path, "tasks", `${task.id}.json`), JSON.stringify(task));
  await writeFile(join(path, "PROJECT.md"), "# Existing product\n");
  await writeFile(join(path, "events.ndjson"), JSON.stringify({ schemaVersion: 1, eventId: "old_event", type: "project.select_tasks_started", projectId: project.id, occurredAt: createdAt, state: { project } }) + "\n");
  return { directory, project, task };
}
