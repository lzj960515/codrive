import { projectMilestoneActivities } from "../../domain/milestone-activity.js";
import { createMilestoneView, readMilestoneActivities } from "./milestone-view.js";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";

import type {
  ProjectModelSettingsInput,
  RuntimeSettingsInput,
} from "../../application/system-settings-service.js";
import type { SystemUpdateService } from "../../application/system-update-service.js";
import type { WorkflowEngine } from "../../application/workflow-engine.js";
import type { ExecutionActivityBridge } from "../../application/execution-activity-bridge.js";
import {
  InvalidTaskReportError,
  ServiceNotReadyError,
  SystemUpdateConflictError,
  WorkflowConflictError,
} from "../../domain/errors.js";
import { hasProductFacts } from "../../domain/product-facts.js";
import { isProjectArchived } from "../../domain/project.js";
import type { CodriveCommand, Project, Task } from "../../domain/types.js";
import type { SystemStatusEventSource } from "../../domain/system-update.js";
import type { ProjectStore } from "../../infrastructure/project-store.js";
import { renderBoardPage } from "./board.js";
import { commandSchema } from "./command-schemas.js";
import { createBoardView } from "./board-view.js";
import { createProjectDetailView } from "./project-detail-view.js";
import { createTaskDetailView } from "./task-detail-view.js";
import { projectTaskActivities } from "../../domain/task-activity.js";
import { BoardRealtimeGateway } from "./board-realtime.js";

export interface HttpServerDependencies {
  store: ProjectStore;
  workflow: WorkflowEngine;
  activityBridge?: Pick<
    ExecutionActivityBridge,
    "read" | "subscribe" | "isCurrent" | "recordHook"
  >;
  settingsService: {
    read(): Promise<unknown>;
    update(input: RuntimeSettingsInput): Promise<unknown>;
    readProject(projectId: string): Promise<unknown>;
    updateProject(projectId: string, input: ProjectModelSettingsInput): Promise<unknown>;
  };
  systemUpdateService?: Pick<
    SystemUpdateService,
    "read" | "refresh" | "start" | "installResources"
  >;
  systemUpdateEvents?:
    | SystemStatusEventSource
    | readonly SystemStatusEventSource[];
  currentVersion?: string;
  accessToken: string;
  isReady?: () => boolean;
  onError?: (message: string) => void;
}

const hookActivitySchema = z.object({
  schemaVersion: z.literal(1),
  session_id: z.string().min(1).max(200),
  turn_id: z.string().min(1).max(200),
  hook_event_name: z.enum([
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "Stop",
  ]),
  tool_name: z.string().min(1).max(200).optional(),
  occurred_at: z.iso.datetime(),
}).strict();


export function createHttpServer(
  dependencies: HttpServerDependencies,
): FastifyInstance {
  const server = Fastify({ logger: false });
  const realtime = new BoardRealtimeGateway({
    httpServer: server.server,
    accessToken: dependencies.accessToken,
    store: dependencies.store,
    ...(dependencies.activityBridge
      ? { activitySource: dependencies.activityBridge }
      : {}),
    ...(dependencies.systemUpdateEvents
      ? {
          systemEvents: Array.isArray(dependencies.systemUpdateEvents)
            ? dependencies.systemUpdateEvents
            : [dependencies.systemUpdateEvents],
        }
      : {}),
  });

  server.addHook("preClose", async () => realtime.close());

  server.addHook("onRequest", async (request, reply) => {
    const path = new URL(request.url, "http://localhost").pathname;
    if (path === "/api/health" || isPagePath(path)) return;
    const queryToken = new URL(request.url, "http://localhost").searchParams.get("token");
    if (
      request.headers["x-codrive-token"] !== dependencies.accessToken &&
      queryToken !== dependencies.accessToken
    ) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
  });

  server.setErrorHandler((error, request, reply) => {
    const statusCode =
      error instanceof z.ZodError
        ? 400
        : error instanceof WorkflowConflictError
          ? 409
          : error instanceof SystemUpdateConflictError
            ? 409
          : error instanceof InvalidTaskReportError
            ? 422
            : error instanceof ServiceNotReadyError
              ? 503
              : 500;
    const message = error instanceof Error ? error.message : String(error);
    const path = new URL(request.url, "http://localhost").pathname;
    dependencies.onError?.(`${request.method} ${path} ${statusCode}: ${message}`);
    void reply.code(statusCode).send({ error: message });
  });

  server.get("/api/health", async () => ({
    status: dependencies.isReady?.() === false ? "starting" : "ok",
    ...(dependencies.currentVersion ? { version: dependencies.currentVersion } : {}),
  }));
  server.post("/api/hooks/activity", async (request, reply) => {
    if (!dependencies.activityBridge) {
      return reply.code(503).send({ accepted: false });
    }
    const input = hookActivitySchema.parse(request.body);
    const accepted = await dependencies.activityBridge.recordHook({
      schemaVersion: input.schemaVersion,
      sessionId: input.session_id,
      turnId: input.turn_id,
      event: input.hook_event_name,
      ...(input.tool_name ? { toolName: input.tool_name } : {}),
      occurredAt: input.occurred_at,
    });
    return reply.code(202).send({ accepted });
  });
  server.get("/", async (_request, reply) =>
    reply.type("text/html; charset=utf-8").send(renderBoardPage(dependencies.accessToken)),
  );
  server.get("/settings", async (_request, reply) =>
    reply.type("text/html; charset=utf-8").send(renderBoardPage(dependencies.accessToken)),
  );
  server.get<{ Params: { projectId: string } }>(
    "/projects/:projectId",
    async (_request, reply) =>
      reply.type("text/html; charset=utf-8").send(
        renderBoardPage(dependencies.accessToken),
      ),
  );

  server.get("/api/board", async () => {
    const snapshots = await dependencies.store.listProjects();
    return createBoardView(
      snapshots.filter(({ project }) => !isProjectArchived(project)),
      snapshots,
      await readMilestoneActivities(dependencies.store, snapshots),
    );
  });
  server.get("/api/board/archived", async () => {
    const snapshots = await dependencies.store.listProjects();
    const projects = createBoardView(
      snapshots.filter(({ project }) =>
        isProjectArchived(project),
      ),
      snapshots,
      await readMilestoneActivities(dependencies.store, snapshots),
    );
    return { count: projects.length, projects };
  });
  server.get<{ Params: { projectId: string } }>(
    "/api/board/projects/:projectId",
    async (request, reply) => {
      const snapshot = await dependencies.store.getProject(request.params.projectId);
      if (!snapshot) return reply.code(404).send({ error: "Project not found" });
      return createBoardView(
        [snapshot],
        await dependencies.store.listProjects(),
        await readMilestoneActivities(dependencies.store, [snapshot]),
      )[0]!;
    },
  );
  server.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId",
    async (request, reply) => {
      const snapshot = await dependencies.store.getProject(request.params.projectId);
      if (!snapshot) return reply.code(404).send({ error: "Project not found" });
      return createProjectDetailView(
        snapshot,
        await dependencies.store.readProductDocument(snapshot.project.id),
        await dependencies.store.listProjects(),
        await readMilestoneActivities(dependencies.store, [snapshot]),
      );
    },
  );
  server.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/settings",
    async (request, reply) => {
      if (!(await dependencies.store.getProject(request.params.projectId))) {
        return reply.code(404).send({ error: "Project not found" });
      }
      return dependencies.settingsService.readProject(request.params.projectId);
    },
  );

  server.get("/api/system", async () => {
    if (!dependencies.systemUpdateService) {
      throw new Error("System updates are unavailable");
    }
    return dependencies.systemUpdateService.read();
  });
  server.get("/api/system/settings", async () => dependencies.settingsService.read());

  server.get<{ Params: { taskId: string } }>(
    "/api/contexts/tasks/:taskId",
    async (request, reply) => {
      const found = await dependencies.store.findTask(request.params.taskId);
      if (!found) return reply.code(404).send({ error: "Task not found" });
      return taskContext(dependencies.store, found.project, found.task);
    },
  );

  server.get<{ Params: { taskId: string } }>(
    "/api/tasks/:taskId",
    async (request, reply) => {
      const found = await dependencies.store.findTask(request.params.taskId);
      if (!found) return reply.code(404).send({ error: "Task not found" });
      return createTaskDetailView(
        dependencies.store,
        found.project,
        found.task,
        await dependencies.store.listProjects(),
      );
    },
  );

  server.get<{ Params: { projectId: string } }>(
    "/api/contexts/projects/:projectId",
    async (request, reply) => {
      let snapshot = await dependencies.store.getProject(request.params.projectId);
      if (!snapshot) return reply.code(404).send({ error: "Project not found" });
      await dependencies.workflow.synchronizeProjectContext(request.params.projectId);
      snapshot = (await dependencies.store.getProject(request.params.projectId))!;
      return {
        projectId: snapshot.project.id,
        attemptId: snapshot.project.currentExecution?.attemptId ?? null,
        reportOpportunityId: snapshot.project.currentExecution?.reportOpportunityId ?? null,
        planningThreadId: snapshot.project.planningThreadId ?? null,
        milestones: snapshot.milestones,
        requestedAction: snapshot.project.requestedAction,
        projectDirectory: dependencies.store.projectDirectory(snapshot.project.id),
        projectDocument: dependencies.store.productDocumentPath(snapshot.project.id),
        repositoryPath: snapshot.project.repositoryPath,
        productFacts: await productFactsContext(
          dependencies.store,
          snapshot.project,
        ),
        cancellation: snapshot.project.cancellation ?? null,
        archivedAt: snapshot.project.archivedAt ?? null,
        planning: snapshot.project.planning,
        taskDocuments: snapshot.tasks.map((task) =>
          dependencies.store.taskPath(snapshot.project.id, task.id),
        ),
        availableTaskSlots: await dependencies.workflow.availableTaskSlots(
          snapshot.project.id,
        ),
        planningRevision: snapshot.project.currentExecution?.planningRevision ?? null,
      };
    },
  );

  server.get<{ Params: { milestoneId: string } }>(
    "/api/milestones/:milestoneId",
    async (request, reply) => {
      const found = await dependencies.store.findMilestone(request.params.milestoneId);
      if (!found) return reply.code(404).send({ error: "Milestone not found" });
      const snapshot = (await dependencies.store.getProject(found.project.id))!;
      const activities = await dependencies.store.listMilestoneActivities(found.project.id, found.milestone.id);
      return {
        milestone: createMilestoneView(found.milestone, activities, snapshot.tasks.filter(task => task.milestoneId === found.milestone.id).length),
        activities,
      };
    },
  );
  server.get<{ Params: { milestoneId: string } }>(
    "/api/contexts/milestones/:milestoneId",
    async (request, reply) => {
      if (!(await dependencies.store.findMilestone(request.params.milestoneId))) return reply.code(404).send({ error: "Milestone not found" });
      const context = await dependencies.workflow.milestoneContext(request.params.milestoneId);
      const execution = context.milestone.currentExecution;
      return {
        ...context,
        milestoneId: context.milestone.id,
        projectId: context.project.id,
        attemptId: execution?.attemptId ?? null,
        reportOpportunityId: execution?.reportOpportunityId ?? null,
        requestedAction: "assess_milestone",
        definitionVersion: context.milestone.definitionVersion,
        planningRevision: execution?.planningRevision ?? context.milestone.planning.revision,
        repositoryPath: context.project.repositoryPath,
        projectDocument: dependencies.store.productDocumentPath(context.project.id),
        productFacts: await productFactsContext(dependencies.store, context.project),
      };
    },
  );

  server.get<{ Querystring: { cwd?: string } }>(
    "/api/contexts/resolve",
    async (request, reply) => {
      if (!request.query.cwd) {
        return reply.code(400).send({ error: "cwd is required" });
      }
      const matches = await dependencies.store.findProjectsByPath(request.query.cwd);
      if (matches.length === 0) {
        return reply.code(404).send({ error: "No Codrive project matches cwd" });
      }
      if (matches.length > 1) {
        return reply.code(409).send({
          error: "Multiple Codrive projects match cwd",
          projectIds: matches.map(({ project }) => project.id),
        });
      }
      return {
        projectId: matches[0]!.project.id,
        status: matches[0]!.project.status,
        scheduling: matches[0]!.project.scheduling,
      };
    },
  );

  server.post("/api/commands", async (request, reply) => {
    if (dependencies.isReady?.() === false) {
      throw new ServiceNotReadyError(
        "Codrive is still recovering persisted executions",
      );
    }
    const command = commandSchema.parse(request.body);
    if (command.type === "system.install_resources") {
      if (!dependencies.systemUpdateService) {
        throw new Error("System updates are unavailable");
      }
      return dependencies.systemUpdateService.installResources();
    }
    if (command.type === "system.check_for_updates") {
      if (!dependencies.systemUpdateService) {
        throw new Error("System updates are unavailable");
      }
      return dependencies.systemUpdateService.refresh();
    }
    if (command.type === "system.start_upgrade") {
      if (!dependencies.systemUpdateService) {
        throw new Error("System updates are unavailable");
      }
      const update = await dependencies.systemUpdateService.start(
        command.payload.targetVersion,
      );
      return reply.code(202).send(update);
    }
    if (command.type === "system.update_settings") {
      const { semanticAtlasAutomaticMaintenance, ...runtimeSettings } = command.payload;
      return dependencies.settingsService.update({
        ...runtimeSettings,
        ...(semanticAtlasAutomaticMaintenance === undefined
          ? {}
          : { semanticAtlasAutomaticMaintenance }),
      });
    }
    if (command.type === "project.update_settings") {
      return dependencies.settingsService.updateProject(
        command.payload.projectId,
        { modelConfig: command.payload.modelConfig },
      );
    }
    return dependencies.workflow.execute(
      command as CodriveCommand,
      request.headers["x-codrive-source"] === "skill" ? "skill" : "http",
    );
  });

  return server;
}

function isPagePath(path: string): boolean {
  return path === "/" || path === "/settings" || /^\/projects\/[^/]+$/.test(path);
}

async function taskContext(
  store: ProjectStore,
  project: Project,
  task: Task,
) {
  const milestoneOwner = task.milestoneId ? await store.findMilestone(task.milestoneId) : null;
  const milestoneActivities = milestoneOwner ? await store.listMilestoneActivities(project.id, milestoneOwner.milestone.id) : [];
  const activities = await store.listTaskActivities(project.id, task.id);
  const activity = projectTaskActivities(
    activities,
    task.currentExecution?.workActivityId ?? task.workActivityId,
  );
  const { delivery } = activity;
  return {
    taskId: task.id,
    milestone: milestoneOwner?.milestone ?? null,
    milestoneActivities,
    milestoneProjection: projectMilestoneActivities(milestoneActivities),
    projectId: project.id,
    attemptId: task.currentExecution?.attemptId ?? null,
    reportOpportunityId: task.currentExecution?.reportOpportunityId ?? null,
    status: task.status,
    requestedAction: task.requestedAction,
    cancellation: task.cancellation ?? null,
    projectCancellation: project.cancellation ?? null,
    projectArchivedAt: project.archivedAt ?? null,
    projectDirectory: store.projectDirectory(project.id),
    projectDocument: store.productDocumentPath(project.id),
    taskDocument: store.taskPath(project.id, task.id),
    repositoryPath: project.repositoryPath,
    productFacts: await productFactsContext(store, project),
    workspacePath: delivery.workspacePath ?? null,
    delivery: {
      baseCommit: delivery.baseCommit ?? null,
      candidateCommit: delivery.candidateCommit ?? null,
      reviewedMainCommit: delivery.reviewedMainCommit ?? null,
      mergedCommit: delivery.mergedCommit ?? null,
    },
    activities,
  };
}

async function productFactsContext(store: ProjectStore, project: Project) {
  const document = await store.readProductDocumentSnapshot(project.id);
  return {
    status:
      hasProductFacts(document.document) &&
      document.digest === project.productFacts.digest
        ? "current"
        : "modified",
    revision: project.productFacts.revision,
    acceptedDigest: project.productFacts.digest,
    documentDigest: document.digest,
  };
}
