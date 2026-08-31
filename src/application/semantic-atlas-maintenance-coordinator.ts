import type { SemanticAtlasClient } from "../domain/semantic-atlas.js";
import type {
  CodriveEvent,
  ProjectSnapshot,
  Task,
  TaskActivity,
} from "../domain/types.js";
import type { ConfigStore } from "../infrastructure/config-store.js";
import type { ProjectStore } from "../infrastructure/project-store.js";
import type {
  SemanticAtlasMaintenanceRequest,
  SemanticAtlasMaintenanceState,
  SemanticAtlasMaintenanceStore,
} from "../infrastructure/semantic-atlas-maintenance-store.js";

export interface SemanticAtlasMaintenanceTaskScheduler {
  ensureSemanticAtlasMaintenanceTask(projectId: string): Promise<Task>;
}

export interface SemanticAtlasMaintenanceCoordinatorOptions {
  onError?: (error: unknown) => void;
}

type MaintenanceProjectStore = Pick<
  ProjectStore,
  "subscribe" | "listProjects" | "listTaskActivities" | "getProject"
>;

export class SemanticAtlasMaintenanceCoordinator {
  private readonly onError: (error: unknown) => void;
  private eventQueue: Promise<void> = Promise.resolve();
  private unsubscribe: (() => void) | null = null;

  public constructor(
    private readonly configStore: Pick<ConfigStore, "read">,
    private readonly projects: MaintenanceProjectStore,
    private readonly stateStore: Pick<
      SemanticAtlasMaintenanceStore,
      "read" | "save"
    >,
    private readonly semanticAtlas: SemanticAtlasClient,
    private readonly tasks: SemanticAtlasMaintenanceTaskScheduler,
    options: SemanticAtlasMaintenanceCoordinatorOptions = {},
  ) {
    this.onError = options.onError ?? (() => undefined);
  }

  public async start(): Promise<void> {
    if (this.unsubscribe) return;
    this.unsubscribe = this.projects.subscribe((event) => {
      const completedTask = completedIntegrationTaskFrom(event);
      if (!completedTask) return;
      void this.enqueue(() => this.handleCompletedIntegration(completedTask)).catch(
        this.onError,
      );
    });
    await this.enqueue(() => this.recoverPersistedIntegrations());
  }

  public async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    await this.eventQueue;
  }

  public settingsChanged(): Promise<void> {
    return this.enqueue(() => this.recoverPersistedIntegrations()).catch(
      (error: unknown) => {
        this.onError(error);
      },
    );
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.eventQueue.then(operation);
    this.eventQueue = next.catch(() => undefined);
    return next;
  }

  private async handleLiveIntegration(activity: TaskActivity): Promise<void> {
    const enabledAt = await this.enabledAt();
    if (enabledAt === null || activity.occurredAt < enabledAt) return;

    const state = await this.stateStore.read();
    if (!requestIsKnown(state, activity.id)) {
      state.requests.push(requestFrom(activity));
    }
    await this.processRequests(state, activity.projectId);
    await this.stateStore.save(state);
  }

  private async handleCompletedIntegration(
    completedTask: CompletedIntegrationTask,
  ): Promise<void> {
    const activities = await this.projects.listTaskActivities(
      completedTask.projectId,
      completedTask.taskId,
    );
    const integration = findLatestIntegration(activities);
    if (!integration) {
      throw new Error(
        `Completed integration task '${completedTask.taskId}' has no integration activity`,
      );
    }
    await this.handleLiveIntegration(integration);
  }

  private async recoverPersistedIntegrations(): Promise<void> {
    const enabledAt = await this.enabledAt();
    if (enabledAt === null) return;

    const state = await this.stateStore.read();
    const snapshots = await this.projects.listProjects();
    await this.discoverPersistedRequests(state, snapshots, enabledAt);
    await this.processRequests(state);
    await this.stateStore.save(state);
  }

  private async enabledAt(): Promise<string | null> {
    const config = await this.configStore.read();
    if (!(config.semanticAtlas?.automaticMaintenance ?? false)) return null;
    return config.semanticAtlas?.enabledAt ?? "";
  }

  private async discoverPersistedRequests(
    state: SemanticAtlasMaintenanceState,
    snapshots: readonly ProjectSnapshot[],
    enabledAt: string,
  ): Promise<void> {
    for (const { project, tasks } of snapshots) {
      const completedTaskIds = new Set(
        tasks.filter(({ status }) => status === "done").map(({ id }) => id),
      );
      const activities = await this.projects.listTaskActivities(project.id);
      for (const activity of activities) {
        if (
          activity.type !== "integration_completed" ||
          !completedTaskIds.has(activity.taskId) ||
          activity.occurredAt < enabledAt ||
          requestIsKnown(state, activity.id)
        ) {
          continue;
        }
        state.requests.push(requestFrom(activity));
      }
    }
  }

  private async processRequests(
    state: SemanticAtlasMaintenanceState,
    onlyProjectId?: string,
  ): Promise<void> {
    if (!(await this.semanticAtlas.readInstallation()).installed) return;

    const projectIds = [...new Set(
      state.requests
        .filter(({ projectId }) => !onlyProjectId || projectId === onlyProjectId)
        .map(({ projectId }) => projectId),
    )];
    for (const projectId of projectIds) {
      await this.processProjectRequests(state, projectId);
    }
  }

  private async processProjectRequests(
    state: SemanticAtlasMaintenanceState,
    projectId: string,
  ): Promise<void> {
    const requests = state.requests.filter(
      (request) => request.projectId === projectId,
    );
    if (requests.length === 0) return;

    const snapshot = await this.projects.getProject(projectId);
    if (!snapshot || snapshot.project.status === "cancelled") {
      completeRequests(state, requests);
      return;
    }
    if (hasOpenMaintenanceTask(snapshot)) {
      completeRequests(state, requests);
      return;
    }

    try {
      const required = await this.semanticAtlas.maintenanceRequired(
        snapshot.project.repositoryPath,
      );
      if (required) {
        await this.tasks.ensureSemanticAtlasMaintenanceTask(projectId);
      }
      completeRequests(state, requests);
    } catch (error) {
      this.onError(error);
    }
  }
}

interface CompletedIntegrationTask {
  readonly projectId: string;
  readonly taskId: string;
}

function completedIntegrationTaskFrom(
  event: CodriveEvent,
): CompletedIntegrationTask | undefined {
  if (
    event.type !== "task.completed" ||
    event.before?.action !== "integrate" ||
    !event.taskId
  ) {
    return undefined;
  }
  return { projectId: event.projectId, taskId: event.taskId };
}

function findLatestIntegration(
  activities: readonly TaskActivity[],
): TaskActivity | undefined {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (activity?.type === "integration_completed") return activity;
  }
  return undefined;
}

function requestFrom(activity: TaskActivity): SemanticAtlasMaintenanceRequest {
  return {
    id: activity.id,
    projectId: activity.projectId,
    sourceTaskId: activity.taskId,
    createdAt: activity.occurredAt,
  };
}

function requestIsKnown(
  state: SemanticAtlasMaintenanceState,
  activityId: string,
): boolean {
  return state.handledIntegrationActivityIds.includes(activityId) ||
    state.requests.some(({ id }) => id === activityId);
}

function hasOpenMaintenanceTask(snapshot: ProjectSnapshot): boolean {
  return snapshot.tasks.some((task) =>
    task.origin?.kind === "semantic_atlas_maintenance" &&
    !["done", "cancelled"].includes(task.status)
  );
}

function completeRequests(
  state: SemanticAtlasMaintenanceState,
  completed: readonly SemanticAtlasMaintenanceRequest[],
): void {
  const completedIds = new Set(completed.map(({ id }) => id));
  state.requests = state.requests.filter(({ id }) => !completedIds.has(id));
  for (const { id } of completed) {
    if (!state.handledIntegrationActivityIds.includes(id)) {
      state.handledIntegrationActivityIds.push(id);
    }
  }
}
