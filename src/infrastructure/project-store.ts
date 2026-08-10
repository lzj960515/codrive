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

import type {
  CodriveEvent,
  CreateProjectInput,
  Project,
  ProjectSnapshot,
  Task,
  CreateTaskInput,
} from "../domain/types.js";
import { createPlanningState } from "../domain/planning.js";

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
      createdAt: now,
      updatedAt: now,
    };
    const generatedTaskIds = input.tasks.map(() => `task_${randomUUID()}`);
    const tasks = input.tasks.map<Task>((task, index) => ({
      id: generatedTaskIds[index]!,
      projectId,
      title: task.title,
      description: task.description,
      acceptanceCriteria: task.acceptanceCriteria,
      order: task.order ?? index + 1,
      status: "backlog",
      requestedAction: null,
      reviewAttempts: [],
      createdAt: now,
      updatedAt: now,
    }));

    await mkdir(this.tasksDirectory(projectId), { recursive: true });
    await Promise.all([
      this.atomicWriteJson(this.projectPath(projectId), project),
      writeFile(this.productDocumentPath(projectId), input.productDocument, "utf8"),
      ...tasks.map((task) =>
        this.atomicWriteJson(this.taskPath(projectId, task.id), task),
      ),
    ]);
    await this.appendEvent({
      eventId: randomUUID(),
      type: "project.created",
      projectId,
      occurredAt: now,
    });
    await this.appendEvent({
      eventId: randomUUID(),
      type: "project.activated",
      projectId,
      occurredAt: now,
    });
    for (const task of tasks) {
      await this.appendEvent({
        eventId: randomUUID(),
        type: "task.created",
        projectId,
        taskId: task.id,
        occurredAt: now,
      });
    }

    return { project, tasks };
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
      const project = await this.readJson<Project>(this.projectPath(projectId));
      const taskFiles = await readdir(this.tasksDirectory(projectId));
      const tasks = await Promise.all(
        taskFiles
          .filter((file) => file.endsWith(".json"))
          .map((file) => this.readJson<Task>(join(this.tasksDirectory(projectId), file))),
      );
      tasks.sort((left, right) => left.order - right.order);
      return { project, tasks };
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
    return (await this.listProjects()).filter((snapshot) =>
      [
        snapshot.project.repositoryPath,
        ...snapshot.tasks.flatMap(({ workspacePath }) =>
          workspacePath ? [workspacePath] : [],
        ),
      ].some((root) => pathContains(root, candidate)),
    );
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
      order: input.order ?? firstOrder + index,
      status: "backlog",
      requestedAction: null,
      reviewAttempts: [],
      createdAt: now,
      updatedAt: now,
    }));
    for (const task of tasks) {
      await this.saveTask(projectId, task);
      await this.appendEvent({
        eventId: randomUUID(),
        type: "task.created",
        projectId,
        taskId: task.id,
        occurredAt: now,
      });
    }
    return tasks;
  }

  async saveProductDocument(projectId: string, document: string): Promise<void> {
    await writeFile(this.productDocumentPath(projectId), document, "utf8");
  }

  async saveProject(project: Project): Promise<void> {
    await this.atomicWriteJson(this.projectPath(project.id), project);
  }

  async saveTask(projectId: string, task: Task): Promise<void> {
    await this.atomicWriteJson(this.taskPath(projectId, task.id), task);
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
    await appendFile(
      this.eventsPath(event.projectId),
      `${JSON.stringify(storedEvent)}\n`,
      "utf8",
    );
    for (const listener of this.eventListeners) {
      listener(event);
    }
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

  private async initializeStore(): Promise<void> {
    await mkdir(this.projectsDirectory, { recursive: true });
    const entries = await readdir(this.projectsDirectory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        await this.rebuildSnapshots(entry.name);
      }
    }
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
    for (const line of contents.split("\n")) {
      if (!line.trim()) continue;
      const event = JSON.parse(line) as CodriveEvent;
      if (event.state?.project) project = event.state.project;
      if (event.state?.task) tasks.set(event.state.task.id, event.state.task);
    }

    if (project && !(await this.hasNewerSnapshot(this.projectPath(projectId), project))) {
      await this.atomicWriteJson(this.projectPath(projectId), project);
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
    eventSnapshot: Project | Task,
  ): Promise<boolean> {
    try {
      const snapshot = await this.readJson<Project | Task>(path);
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
