import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";

import type { SystemSettingsService } from "../../application/system-settings-service.js";
import type { SystemUpdateService } from "../../application/system-update-service.js";
import type { WorkflowEngine } from "../../application/workflow-engine.js";
import type { ExecutionActivityBridge } from "../../application/execution-activity-bridge.js";
import {
  InvalidTaskReportError,
  ServiceNotReadyError,
  SystemUpdateConflictError,
  WorkflowConflictError,
} from "../../domain/errors.js";
import type { CodriveCommand, Project, Task } from "../../domain/types.js";
import type { SystemStatusEventSource } from "../../domain/system-update.js";
import type { ProjectStore } from "../../infrastructure/project-store.js";
import type { ManagedResourceInstaller } from "../../infrastructure/managed-resource-installer.js";
import type { SkillInstaller } from "../../infrastructure/skill-installer.js";
import { renderBoardPage } from "./board.js";
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
  skillInstaller: SkillInstaller;
  resourceInstaller?: ManagedResourceInstaller;
  settingsService: Pick<
    SystemSettingsService,
    "read" | "update" | "readProject" | "updateProject"
  >;
  systemUpdateService?: Pick<
    SystemUpdateService,
    "read" | "refresh" | "start" | "installResources" | "installSkills"
  >;
  systemUpdateEvents?:
    | SystemStatusEventSource
    | readonly SystemStatusEventSource[];
  currentVersion?: string;
  accessToken: string;
  isReady?: () => boolean;
  onError?: (message: string) => void;
}

const taskInputSchema = z.object({
  title: z.string().min(1),
  description: z.string(),
  acceptanceCriteria: z.array(z.string()),
  order: z.number().int().positive().optional(),
});

const projectInputSchema = z.object({
  name: z.string().min(1),
  repositoryPath: z.string().min(1),
  defaultBranch: z.string().min(1).default("main"),
  productDocument: z.string().min(1),
  tasks: z.array(taskInputSchema).min(1),
});

const taskReportSchema = z.object({
  taskId: z.string().min(1),
  attemptId: z.string().min(1),
  reportOpportunityId: z.string().min(1).optional(),
  outcome: z.enum([
    "completed",
    "approved",
    "changes_requested",
    "needs_review",
    "needs_input",
    "blocked",
  ]),
  summary: z.string().min(1),
  workspacePath: z.string().optional(),
  baseCommit: z.string().optional(),
  candidateCommit: z.string().optional(),
  reviewedMainCommit: z.string().optional(),
  mergedCommit: z.string().optional(),
  tests: z.string().optional(),
  findings: z.array(z.string()).optional(),
  question: z.string().optional(),
  resumeAt: z.string().optional(),
  resumePrompt: z.string().optional(),
});

const projectReportSchema = z.object({
  projectId: z.string().min(1),
  attemptId: z.string().min(1),
  outcome: z.enum([
    "selected",
    "wait_for_active_tasks",
    "needs_input",
    "blocked",
  ]),
  summary: z.string().min(1),
  taskIds: z.array(z.string().min(1)).optional(),
  question: z.string().optional(),
});

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

const cancellationDecisionSchema = {
  decisionBasis: z.enum(["user_confirmed", "agent_decision"]),
  reason: z.string().trim().min(1).max(2_000),
};

const commandSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("system.install_resources"),
    payload: z.object({}),
  }),
  z.object({
    type: z.literal("system.install_skills"),
    payload: z.object({}),
  }),
  z.object({
    type: z.literal("system.check_for_updates"),
    payload: z.object({}),
  }),
  z.object({
    type: z.literal("system.start_upgrade"),
    payload: z.object({
      targetVersion: z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/),
    }),
  }),
  z.object({
    type: z.literal("system.update_settings"),
    payload: z.object({
      maxConcurrentTasks: z.number().int().positive(),
      models: z.object({
        primary: z.string().min(1),
        fallback: z.string().min(1),
      }),
    }),
  }),
  z.object({
    type: z.literal("project.update_settings"),
    payload: z.object({
      projectId: z.string().min(1),
      modelConfig: z
        .object({
          primary: z.string().min(1),
          fallback: z.string().min(1),
        })
        .nullable(),
    }),
  }),
  z.object({ type: z.literal("project.register"), payload: projectInputSchema }),
  z.object({
    type: z.literal("project.add_work"),
    payload: z.object({
      projectId: z.string().min(1),
      tasks: z.array(taskInputSchema).min(1),
      productDocument: z.string().optional(),
    }),
  }),
  z.object({
    type: z.literal("project.control"),
    payload: z.discriminatedUnion("action", [
      z.object({
        projectId: z.string().min(1),
        action: z.enum(["pause", "resume", "retry", "replan"]),
      }),
      z.object({
        projectId: z.string().min(1),
        action: z.literal("cancel"),
        ...cancellationDecisionSchema,
      }),
    ]),
  }),
  z.object({
    type: z.literal("project.record_decision"),
    payload: z.object({
      projectId: z.string().min(1),
      decision: z.string().min(1),
      productDocument: z.string().optional(),
    }),
  }),
  z.object({
    type: z.literal("task.control"),
    payload: z.discriminatedUnion("action", [
      z.object({ taskId: z.string().min(1), action: z.literal("retry") }),
      z.object({ taskId: z.string().min(1), action: z.literal("continue") }),
      z.object({
        taskId: z.string().min(1),
        action: z.literal("reschedule"),
        resumeAt: z.string().min(1),
      }),
      z.object({
        taskId: z.string().min(1),
        action: z.literal("cancel"),
        ...cancellationDecisionSchema,
      }),
    ]),
  }),
  z.object({ type: z.literal("task.report"), payload: taskReportSchema }),
  z.object({ type: z.literal("project.report"), payload: projectReportSchema }),
]);

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

  server.get("/api/board", async () =>
    createBoardView(await dependencies.store.listProjects()),
  );
  server.get<{ Params: { projectId: string } }>(
    "/api/board/projects/:projectId",
    async (request, reply) => {
      const snapshot = await dependencies.store.getProject(request.params.projectId);
      if (!snapshot) return reply.code(404).send({ error: "Project not found" });
      return createBoardView([snapshot])[0]!;
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

  server.get("/api/system", async () =>
    dependencies.systemUpdateService
      ? dependencies.systemUpdateService.read()
      : dependencies.resourceInstaller
        ? projectResourceStatus(await dependencies.resourceInstaller.getStatus())
        : { skills: await dependencies.skillInstaller.getStatus() },
  );
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
      );
    },
  );

  server.get<{ Params: { projectId: string } }>(
    "/api/contexts/projects/:projectId",
    async (request, reply) => {
      const snapshot = await dependencies.store.getProject(request.params.projectId);
      if (!snapshot) return reply.code(404).send({ error: "Project not found" });
      return {
        projectId: snapshot.project.id,
        attemptId: snapshot.project.currentExecution?.attemptId ?? null,
        requestedAction: snapshot.project.requestedAction,
        projectDirectory: dependencies.store.projectDirectory(snapshot.project.id),
        projectDocument: dependencies.store.productDocumentPath(snapshot.project.id),
        repositoryPath: snapshot.project.repositoryPath,
        contextNotes: snapshot.project.contextNotes ?? [],
        cancellation: snapshot.project.cancellation ?? null,
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
    if (
      command.type === "system.install_resources" ||
      command.type === "system.install_skills"
    ) {
      if (dependencies.systemUpdateService) {
        return dependencies.systemUpdateService.installResources();
      }
      if (dependencies.resourceInstaller) {
        await dependencies.resourceInstaller.install();
        return projectResourceStatus(
          await dependencies.resourceInstaller.getStatus(),
        );
      }
      await dependencies.skillInstaller.install();
      return { skills: await dependencies.skillInstaller.getStatus() };
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
      return dependencies.settingsService.update(command.payload);
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

function projectResourceStatus(
  resources: Awaited<ReturnType<ManagedResourceInstaller["getStatus"]>>,
) {
  return {
    resources,
    skills: resources.skills,
    hook: resources.hook,
  };
}

function isPagePath(path: string): boolean {
  return path === "/" || path === "/settings" || /^\/projects\/[^/]+$/.test(path);
}

async function taskContext(
  store: ProjectStore,
  project: Project,
  task: Task,
) {
  const activities = await store.listTaskActivities(project.id, task.id);
  const activity = projectTaskActivities(activities);
  const { delivery } = activity;
  return {
    taskId: task.id,
    projectId: project.id,
    attemptId: task.currentExecution?.attemptId ?? null,
    reportOpportunityId: task.currentExecution?.reportOpportunityId ?? null,
    status: task.status,
    requestedAction: task.requestedAction,
    cancellation: task.cancellation ?? null,
    projectCancellation: project.cancellation ?? null,
    projectDirectory: store.projectDirectory(project.id),
    projectDocument: store.productDocumentPath(project.id),
    taskDocument: store.taskPath(project.id, task.id),
    repositoryPath: project.repositoryPath,
    projectContextNotes: project.contextNotes ?? [],
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
