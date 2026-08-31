import type { SemanticAtlasClient } from "../domain/semantic-atlas.js";
import type { ProjectSnapshot, Task } from "../domain/types.js";
import type { ConfigStore } from "../infrastructure/config-store.js";
import type { ProjectStore } from "../infrastructure/project-store.js";
import type {
  SemanticAtlasMaintenanceRequest,
  SemanticAtlasMaintenanceState,
  SemanticAtlasMaintenanceStore,
} from "../infrastructure/semantic-atlas-maintenance-store.js";

export interface SemanticAtlasMaintenanceTaskScheduler {
  ensureSemanticAtlasMaintenanceTasks(
    projectId: string,
    businessDomainIds: readonly string[],
  ): Promise<readonly Task[]>;
}

export interface SemanticAtlasMaintenanceCoordinatorOptions {
  intervalMs?: number;
  onError?: (error: unknown) => void;
}

export class SemanticAtlasMaintenanceCoordinator {
  private readonly intervalMs: number;
  private readonly onError: (error: unknown) => void;
  private reconcileQueue: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;

  public constructor(
    private readonly configStore: Pick<ConfigStore, "read">,
    private readonly projects: Pick<ProjectStore, "listProjects" | "listTaskActivities">,
    private readonly stateStore: Pick<SemanticAtlasMaintenanceStore, "read" | "save">,
    private readonly semanticAtlas: SemanticAtlasClient,
    private readonly tasks: SemanticAtlasMaintenanceTaskScheduler,
    options: SemanticAtlasMaintenanceCoordinatorOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? 30_000;
    this.onError = options.onError ?? (() => undefined);
  }

  public async start(): Promise<void> {
    await this.reconcile();
    this.timer = setInterval(() => {
      void this.reconcile().catch(this.onError);
    }, this.intervalMs);
    this.timer.unref();
  }

  public stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  public settingsChanged(): Promise<void> {
    return this.reconcile().catch((error: unknown) => {
      this.onError(error);
    });
  }

  public reconcile(): Promise<void> {
    const next = this.reconcileQueue.then(() => this.reconcileCurrentState());
    this.reconcileQueue = next.catch(() => undefined);
    return next;
  }

  private async reconcileCurrentState(): Promise<void> {
    const config = await this.configStore.read();
    const automaticMaintenance = config.semanticAtlas?.automaticMaintenance ?? false;
    if (!automaticMaintenance || !(await this.semanticAtlas.readInstallation()).installed) {
      return;
    }

    const snapshots = await this.projects.listProjects();
    const state = await this.stateStore.read();
    await this.discoverRequests(state, snapshots, config.semanticAtlas?.enabledAt);
    await this.processRequests(state, snapshots);
    await this.stateStore.save(state);
  }

  private async discoverRequests(
    state: SemanticAtlasMaintenanceState,
    snapshots: readonly ProjectSnapshot[],
    enabledAt?: string,
  ): Promise<void> {
    const known = new Set([
      ...state.handledIntegrationActivityIds,
      ...state.requests.map(({ id }) => id),
    ]);
    for (const { project, tasks } of snapshots) {
      if (project.status === "cancelled") continue;
      for (const task of tasks) {
        if (task.status !== "done" || task.origin?.kind === "semantic_atlas_maintenance") {
          continue;
        }
        const activities = await this.projects.listTaskActivities(project.id, task.id);
        const integration = latestIntegrationActivity(activities);
        if (
          !integration ||
          known.has(integration.id) ||
          (enabledAt && integration.occurredAt < enabledAt)
        ) {
          continue;
        }
        state.requests.push({
          id: integration.id,
          projectId: project.id,
          sourceTaskId: task.id,
          createdAt: integration.occurredAt,
          waitingForTaskIds: [],
        });
        known.add(integration.id);
      }
    }
  }

  private async processRequests(
    state: SemanticAtlasMaintenanceState,
    snapshots: readonly ProjectSnapshot[],
  ): Promise<void> {
    const snapshotsByProject = new Map(
      snapshots.map((snapshot) => [snapshot.project.id, snapshot]),
    );
    const remaining: SemanticAtlasMaintenanceRequest[] = [];
    for (const request of state.requests) {
      const snapshot = snapshotsByProject.get(request.projectId);
      if (!snapshot || snapshot.project.status === "cancelled") {
        state.handledIntegrationActivityIds.push(request.id);
        continue;
      }
      if (hasOpenWaitingTask(request, snapshot)) {
        remaining.push(request);
        continue;
      }

      try {
        const businessDomains = await this.semanticAtlas.listActionableBusinessDomains(
          snapshot.project.repositoryPath,
        );
        if (businessDomains.length === 0) {
          state.handledIntegrationActivityIds.push(request.id);
          continue;
        }
        const maintenanceTasks = await this.tasks.ensureSemanticAtlasMaintenanceTasks(
          request.projectId,
          businessDomains,
        );
        remaining.push({
          ...request,
          waitingForTaskIds: maintenanceTasks.map(({ id }) => id),
        });
      } catch (error) {
        this.onError(error);
        remaining.push(request);
      }
    }
    state.requests = remaining;
  }
}

function latestIntegrationActivity(
  activities: Awaited<ReturnType<ProjectStore["listTaskActivities"]>>,
) {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    if (activities[index]?.type === "integration_completed") return activities[index];
  }
  return undefined;
}

function hasOpenWaitingTask(
  request: SemanticAtlasMaintenanceRequest,
  snapshot: ProjectSnapshot,
): boolean {
  const tasksById = new Map(snapshot.tasks.map((task) => [task.id, task]));
  return request.waitingForTaskIds.some((taskId) => {
    const task = tasksById.get(taskId);
    return task && !["done", "cancelled"].includes(task.status);
  });
}
