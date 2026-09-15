import { randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import type { Milestone, MilestoneActivity } from "../domain/milestone.js";
import type {
  CodriveEvent,
  CreateProjectInput,
  Project,
  ProjectSnapshot,
  Task,
  TaskActivity,
  CreateTaskInput,
} from "../domain/types.js";
import { projectTaskActivities } from "../domain/task-activity.js";
import { createPlanningState } from "../domain/planning.js";
import {
  createProductFacts,
  productDocumentDigest,
} from "../domain/product-facts.js";
import { initializeStateDirectory } from "./state-schema.js";
import {
  assertCurrentMilestone,
  isMilestoneActivity,
  assertCurrentEvent,
  assertCurrentProject,
  assertCurrentTask,
  isTaskActivity,
} from "./state-validation.js";

export class ProjectStore {
  readonly projectsDirectory: string;
  private readonly eventListeners = new Set<(event: CodriveEvent) => void>();
  private initialization: Promise<void> | null = null;

  constructor(readonly stateDirectory: string) {
    this.projectsDirectory = join(stateDirectory, "projects");
  }

  async initialize(): Promise<void> {
    this.initialization ??= this.initializeStore();
    await this.initialization;
  }

  async createProject(input: CreateProjectInput): Promise<ProjectSnapshot> {
    await this.initialize();

    const now = new Date().toISOString();
    const projectId = `project_${randomUUID()}`;
    const project: Project = {
      id: projectId,
      name: input.name,
      repositoryPath: input.repositoryPath,
      defaultBranch: input.defaultBranch,
      status: "active",
      scheduling: "running",
      requestedAction: null,
      planning: createPlanningState(now),
      productFacts: createProductFacts(input.productDocument, now),
      createdAt: now,
      updatedAt: now,
    };
    const milestones: Milestone[] = (input.milestones ?? []).map((definition) => ({
      id: `milestone_${randomUUID()}`,
      projectId,
      title: definition.title,
      description: definition.description,
      acceptanceCriteria: definition.acceptanceCriteria,
      definitionVersion: 1,
      status: "active",
      planning: createPlanningState(now),
      createdAt: now,
      updatedAt: now,
    }));
    const taskInputs: CreateTaskInput[] = [...input.tasks];
    for (const [index, definition] of (input.milestones ?? []).entries()) {
      for (const task of definition.tasks ?? []) {
        taskInputs.push({ ...task, milestoneId: milestones[index]!.id });
      }
    }
    const generatedTaskIds = taskInputs.map(() => `task_${randomUUID()}`);
    const tasks = taskInputs.map<Task>((task, index) => ({
      id: generatedTaskIds[index]!,
      projectId,
      title: task.title,
      description: task.description,
      acceptanceCriteria: task.acceptanceCriteria,
      ...(task.milestoneId ? { milestoneId: task.milestoneId } : {}),
      ...(task.origin ? { origin: task.origin } : {}),
      order: task.order ?? index + 1,
      status: "backlog",
      requestedAction: null,
      createdAt: now,
      updatedAt: now,
    }));

    await mkdir(this.tasksDirectory(projectId), { recursive: true });
    await mkdir(this.milestonesDirectory(projectId), { recursive: true });
    await Promise.all([
      this.atomicWriteJson(this.projectPath(projectId), project),
      writeFile(this.productDocumentPath(projectId), input.productDocument, "utf8"),
      ...milestones.map((milestone) => this.saveMilestone(projectId, milestone)),
      ...tasks.map((task) =>
        this.atomicWriteJson(this.taskPath(projectId, task.id), task),
      ),
    ]);
    await this.appendEvent({
      schemaVersion: 1,
      eventId: randomUUID(),
      type: "project.created",
      projectId,
      occurredAt: now,
    });
    await this.appendEvent({
      schemaVersion: 1,
      eventId: randomUUID(),
      type: "project.activated",
      projectId,
      occurredAt: now,
    });
    for (const task of tasks) {
      await this.appendEvent({
        schemaVersion: 1,
        eventId: randomUUID(),
        type: "task.created",
        projectId,
        taskId: task.id,
        occurredAt: now,
      });
    }

    for (const milestone of milestones) {
      await this.appendEvent({
        schemaVersion: 1,
        eventId: randomUUID(),
        type: "milestone.created",
        projectId,
        milestoneId: milestone.id,
        occurredAt: now,
      });
    }
    return { project, tasks, milestones };
  }

  async listProjects(): Promise<ProjectSnapshot[]> {
    await this.initialize();
    const entries = await readdir(this.projectsDirectory, { withFileTypes: true });
    const projects = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => this.getProject(entry.name)),
    );
    return projects.filter((project): project is ProjectSnapshot => Boolean(project));
  }

  async getProject(projectId: string): Promise<ProjectSnapshot | null> {
    try {
      const project = assertCurrentProject(
        await this.readJson<Project>(this.projectPath(projectId)),
      );
      const taskFiles = await readdir(this.tasksDirectory(projectId));
      const tasks = await Promise.all(
        taskFiles
          .filter((file) => file.endsWith(".json"))
          .map(async (file) =>
            assertCurrentTask(
              await this.readJson<Task>(join(this.tasksDirectory(projectId), file)),
            ),
          ),
      );
      tasks.sort((left, right) => left.order - right.order);
      const milestones = await this.listMilestones(projectId);
      return { project, tasks, milestones };
    } catch (error) {
      if (isMissingFile(error)) {
        return null;
      }
      throw error;
    }
  }

  async findTask(taskId: string): Promise<{ project: Project; task: Task } | null> {
    for (const snapshot of await this.listProjects()) {
      const task = snapshot.tasks.find(({ id }) => id === taskId);
      if (task) {
        return { project: snapshot.project, task };
      }
    }
    return null;
  }

  async findTaskByTurnId(
    turnId: string,
  ): Promise<{ project: Project; task: Task } | null> {
    for (const snapshot of await this.listProjects()) {
      const task = snapshot.tasks.find(
        ({ currentExecution }) => currentExecution?.turnId === turnId,
      );
      if (task) {
        return { project: snapshot.project, task };
      }
    }
    return null;
  }

  async findProjectByTurnId(turnId: string): Promise<Project | null> {
    for (const snapshot of await this.listProjects()) {
      if (snapshot.project.currentExecution?.turnId === turnId) {
        return snapshot.project;
      }
    }
    return null;
  }

  async findProjectByPath(path: string): Promise<ProjectSnapshot | null> {
    return (await this.findProjectsByPath(path))[0] ?? null;
  }

  async findProjectsByPath(path: string): Promise<ProjectSnapshot[]> {
    const candidate = resolve(path);
    const matches: ProjectSnapshot[] = [];
    for (const snapshot of await this.listProjects()) {
      const taskRoots = await Promise.all(
        snapshot.tasks.map(async ({ id }) =>
          projectTaskActivities(await this.listTaskActivities(snapshot.project.id, id))
            .delivery.workspacePath,
        ),
      );
      if (
        [snapshot.project.repositoryPath, ...taskRoots.filter(Boolean)].some((root) =>
          pathContains(root!, candidate),
        )
      ) {
        matches.push(snapshot);
      }
    }
    return matches;
  }

  async addTasks(projectId: string, inputs: CreateTaskInput[]): Promise<Task[]> {
    const snapshot = await this.getProject(projectId);
    if (!snapshot) {
      throw new Error(`Project ${projectId} was not found`);
    }
    const now = new Date().toISOString();
    const firstOrder = Math.max(0, ...snapshot.tasks.map(({ order }) => order)) + 1;
    const generatedTaskIds = inputs.map(() => `task_${randomUUID()}`);
    const tasks = inputs.map<Task>((input, index) => ({
      id: generatedTaskIds[index]!,
      projectId,
      title: input.title,
      description: input.description,
      acceptanceCriteria: input.acceptanceCriteria,
      ...(input.milestoneId ? { milestoneId: input.milestoneId } : {}),
      ...(input.origin ? { origin: input.origin } : {}),
      order: input.order ?? firstOrder + index,
      status: "backlog",
      requestedAction: null,
      createdAt: now,
      updatedAt: now,
    }));
    for (const task of tasks) {
      await this.saveTask(projectId, task);
      await this.appendEvent({
        schemaVersion: 1,
        eventId: randomUUID(),
        type: "task.created",
        projectId,
        taskId: task.id,
        occurredAt: now,
      });
    }
    return tasks;
  }

  async saveMilestone(projectId: string, milestone: Milestone): Promise<void> {
    if (milestone.projectId !== projectId) {
      throw new Error("Milestone belongs to a different project");
    }
    await this.atomicWriteJson(
      this.milestonePath(projectId, milestone.id),
      assertCurrentMilestone(milestone),
    );
  }

  async findMilestone(milestoneId: string): Promise<{ project: Project; milestone: Milestone } | null> {
    for (const snapshot of await this.listProjects()) {
      const milestone = snapshot.milestones.find(({ id }) => id === milestoneId);
      if (milestone) return { project: snapshot.project, milestone };
    }
    return null;
  }

  async findMilestoneByTurnId(turnId: string): Promise<{ project: Project; milestone: Milestone } | null> {
    for (const snapshot of await this.listProjects()) {
      const milestone = snapshot.milestones.find(
        ({ currentExecution }) => currentExecution?.turnId === turnId,
      );
      if (milestone) return { project: snapshot.project, milestone };
    }
    return null;
  }

  async findMilestoneByThreadId(threadId: string): Promise<{ project: Project; milestone: Milestone } | null> {
    for (const snapshot of await this.listProjects()) {
      const milestone = snapshot.milestones.find((candidate) => candidate.threadId === threadId);
      if (milestone) return { project: snapshot.project, milestone };
    }
    return null;
  }

  async listMilestoneActivities(projectId: string, milestoneId?: string): Promise<MilestoneActivity[]> {
    const events = await this.readEvents(projectId);
    return events.flatMap((event) => {
      const activity = event.data?.milestoneActivity;
      if (!isMilestoneActivity(activity)) return [];
      return !milestoneId || activity.milestoneId === milestoneId ? [activity] : [];
    });
  }

  private async listMilestones(projectId: string): Promise<Milestone[]> {
    const directory = this.milestonesDirectory(projectId);
    let files: string[];
    try {
      files = await readdir(directory);
    } catch (error) {
      if (isMissingFile(error)) return [];
      throw error;
    }
    const milestones: Milestone[] = [];
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const milestone = assertCurrentMilestone(
        await this.readJson<Milestone>(join(directory, file)),
      );
      if (milestone.projectId !== projectId) {
        throw new Error("Milestone belongs to a different project");
      }
      milestones.push(milestone);
    }
    return milestones;
  }

  async readProductDocument(projectId: string): Promise<string> {
    return readFile(this.productDocumentPath(projectId), "utf8");
  }

  async readProductDocumentSnapshot(
    projectId: string,
  ): Promise<{ document: string; digest: string }> {
    const document = await this.readProductDocument(projectId);
    return { document, digest: productDocumentDigest(document) };
  }

  async saveProject(project: Project): Promise<void> {
    await this.atomicWriteJson(
      this.projectPath(project.id),
      assertCurrentProject(project),
    );
  }

  async saveTask(projectId: string, task: Task): Promise<void> {
    await this.atomicWriteJson(
      this.taskPath(projectId, task.id),
      assertCurrentTask(task),
    );
  }

  async appendEvent(
    event: CodriveEvent,
    options: { captureState?: boolean } = {},
  ): Promise<void> {
    await mkdir(this.projectDirectory(event.projectId), { recursive: true });
    const storedEvent =
      options.captureState === false
        ? event
        : await this.withRecoveryState(event);
    assertCurrentEvent(storedEvent);
    await appendFile(
      this.eventsPath(event.projectId),
      `${JSON.stringify(storedEvent)}\n`,
      "utf8",
    );
    for (const listener of this.eventListeners) {
      listener(event);
    }
  }

  async listTaskActivities(
    projectId: string,
    taskId?: string,
  ): Promise<TaskActivity[]> {
    const events = await this.readEvents(projectId);
    return events
      .filter(
        (event) =>
          event.type === "task.activity_recorded" &&
          (!taskId || event.taskId === taskId),
      )
      .flatMap((event) => {
        const activity = event.data?.activity;
        return isTaskActivity(activity) ? [activity] : [];
      })
      .sort(
        (left, right) =>
          left.occurredAt.localeCompare(right.occurredAt) ||
          left.id.localeCompare(right.id),
      );
  }

  async listProjectEvents(projectId: string): Promise<CodriveEvent[]> {
    return this.readEvents(projectId);
  }

  subscribe(listener: (event: CodriveEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  projectDirectory(projectId: string): string {
    return join(this.projectsDirectory, projectId);
  }

  productDocumentPath(projectId: string): string {
    return join(this.projectDirectory(projectId), "PROJECT.md");
  }

  taskPath(projectId: string, taskId: string): string {
    return join(this.tasksDirectory(projectId), `${taskId}.json`);
  }

  milestonePath(projectId: string, milestoneId: string): string {
    return join(this.milestonesDirectory(projectId), `${milestoneId}.json`);
  }

  private milestonesDirectory(projectId: string): string {
    return join(this.projectDirectory(projectId), "milestones");
  }

  private projectPath(projectId: string): string {
    return join(this.projectDirectory(projectId), "project.json");
  }

  private eventsPath(projectId: string): string {
    return join(this.projectDirectory(projectId), "events.ndjson");
  }

  private tasksDirectory(projectId: string): string {
    return join(this.projectDirectory(projectId), "tasks");
  }

  private async atomicWriteJson(path: string, value: unknown): Promise<void> {
    await mkdir(join(path, ".."), { recursive: true });
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(temporaryPath, path);
  }

  private async readJson<T>(path: string): Promise<T> {
    return JSON.parse(await readFile(path, "utf8")) as T;
  }

  private async readEvents(projectId: string): Promise<CodriveEvent[]> {
    try {
      return (await readFile(this.eventsPath(projectId), "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => assertCurrentEvent(JSON.parse(line) as CodriveEvent));
    } catch (error) {
      if (isMissingFile(error)) return [];
      throw error;
    }
  }

  private async initializeStore(): Promise<void> {
    await initializeStateDirectory(this.stateDirectory);
    await mkdir(this.projectsDirectory, { recursive: true });
    const entries = await readdir(this.projectsDirectory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        await this.rebuildSnapshots(entry.name);
        await this.reconcileProductDocument(entry.name);
      }
    }
  }

  private async reconcileProductDocument(projectId: string): Promise<void> {
    const snapshot = await this.getProject(projectId);
    if (!snapshot) return;
    const document = await this.readProductDocumentSnapshot(projectId);
    if (document.digest === snapshot.project.productFacts.digest) return;

    const now = new Date().toISOString();
    const execution = snapshot.project.currentExecution;
    const activeSelection =
      execution?.action === "select_tasks" &&
      ["pending", "running", "retry_scheduled", "awaiting_report"].includes(
        execution.status,
      );
    if (!activeSelection) return;
    const project: Project = {
      ...snapshot.project,
      requestedAction: null,
      currentExecution: {
        ...execution,
        status: "interrupted",
        finishedAt: now,
      },
      updatedAt: now,
    };
    await this.saveProject(project);
    await this.appendEvent({
      schemaVersion: 1,
      eventId: randomUUID(),
      type: "project.product_document_modified",
      source: "system",
      projectId,
      occurredAt: now,
      data: {
        acceptedDocumentDigest: snapshot.project.productFacts.digest,
        documentDigest: document.digest,
      },
    });
  }

  private async rebuildSnapshots(projectId: string): Promise<void> {
    let contents: string;
    try {
      contents = await readFile(this.eventsPath(projectId), "utf8");
    } catch (error) {
      if (isMissingFile(error)) return;
      throw error;
    }

    let project: Project | undefined;
    const tasks = new Map<string, Task>();
    const milestones = new Map<string, Milestone>();
    for (const line of contents.split("\n")) {
      if (!line.trim()) continue;
      const event = JSON.parse(line) as CodriveEvent;
      assertCurrentEvent(event);
      if (event.state?.project) project = event.state.project;
      if (event.state?.milestone) {
        const milestone = assertCurrentMilestone(event.state.milestone);
        milestones.set(milestone.id, milestone);
      }
      if (event.state?.task) {
        const task = assertCurrentTask(event.state.task);
        tasks.set(task.id, task);
      }
    }

    if (project && !(await this.hasNewerSnapshot(this.projectPath(projectId), project))) {
      await this.atomicWriteJson(
        this.projectPath(projectId),
        assertCurrentProject(project),
      );
    }
    for (const milestone of milestones.values()) {
      const path = this.milestonePath(projectId, milestone.id);
      if (!(await this.hasNewerSnapshot(path, milestone))) {
        await this.atomicWriteJson(path, milestone);
      }
    }
    for (const task of tasks.values()) {
      const path = this.taskPath(projectId, task.id);
      if (!(await this.hasNewerSnapshot(path, task))) {
        await this.atomicWriteJson(path, task);
      }
    }
  }

  private async hasNewerSnapshot(
    path: string,
    eventSnapshot: Project | Task | Milestone,
  ): Promise<boolean> {
    try {
      const snapshot = await this.readJson<Project | Task | Milestone>(path);
      return snapshot.updatedAt >= eventSnapshot.updatedAt;
    } catch (error) {
      if (isMissingFile(error) || error instanceof SyntaxError) return false;
      throw error;
    }
  }

  private async withRecoveryState(event: CodriveEvent): Promise<CodriveEvent> {
    const state: NonNullable<CodriveEvent["state"]> = {};
    try {
      state.project = await this.readJson<Project>(this.projectPath(event.projectId));
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
    if (event.taskId) {
      try {
        state.task = await this.readJson<Task>(
          this.taskPath(event.projectId, event.taskId),
        );
      } catch (error) {
        if (!isMissingFile(error)) throw error;
      }
    }
    if (event.milestoneId) {
      try {
        state.milestone = await this.readJson<Milestone>(
          this.milestonePath(event.projectId, event.milestoneId),
        );
      } catch (error) {
        if (!isMissingFile(error)) throw error;
      }
    }
    return Object.keys(state).length > 0 ? { ...event, state } : event;
  }
}

function pathContains(root: string, candidate: string): boolean {
  const child = relative(resolve(root), candidate);
  return (
    child === "" ||
    (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child))
  );
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
