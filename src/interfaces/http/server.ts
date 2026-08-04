import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";

import type { WorkflowEngine } from "../../application/workflow-engine.js";
import {
  InvalidTaskReportError,
  WorkflowConflictError,
} from "../../domain/errors.js";
import type { CodriveCommand, Project, Task } from "../../domain/types.js";
import type { ProjectStore } from "../../infrastructure/project-store.js";
import type { SkillInstaller } from "../../infrastructure/skill-installer.js";
import { renderBoardPage } from "./board.js";
import { createBoardView } from "./board-view.js";

export interface HttpServerDependencies {
  store: ProjectStore;
  workflow: WorkflowEngine;
  skillInstaller: SkillInstaller;
  accessToken: string;
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
});

const projectReportSchema = z.object({
  projectId: z.string().min(1),
  attemptId: z.string().min(1),
  outcome: z.enum([
    "selected",
    "wait_for_active_tasks",
    "completed",
    "tasks_required",
    "needs_input",
    "blocked",
  ]),
  summary: z.string().min(1),
  taskIds: z.array(z.string().min(1)).optional(),
  tasks: z.array(taskInputSchema).optional(),
  productDocument: z.string().optional(),
  question: z.string().optional(),
});

const commandSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("system.install_skills"),
    payload: z.object({}),
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
    payload: z.object({
      projectId: z.string().min(1),
      action: z.enum(["pause", "resume", "cancel"]),
    }),
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
    payload: z.object({
      taskId: z.string().min(1),
      action: z.enum(["retry", "cancel"]),
    }),
  }),
  z.object({ type: z.literal("task.report"), payload: taskReportSchema }),
  z.object({ type: z.literal("project.report"), payload: projectReportSchema }),
]);

export function createHttpServer(
  dependencies: HttpServerDependencies,
): FastifyInstance {
  const server = Fastify({ logger: false });

  server.addHook("onRequest", async (request, reply) => {
    if (request.url === "/api/health" || request.url === "/") return;
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
          : error instanceof InvalidTaskReportError
            ? 422
            : 500;
    const message = error instanceof Error ? error.message : String(error);
    const path = new URL(request.url, "http://localhost").pathname;
    dependencies.onError?.(`${request.method} ${path} ${statusCode}: ${message}`);
    void reply.code(statusCode).send({ error: message });
  });

  server.get("/api/health", async () => ({ status: "ok" }));
  server.get("/", async (_request, reply) =>
    reply.type("text/html; charset=utf-8").send(renderBoardPage(dependencies.accessToken)),
  );

  server.get("/api/board", async () =>
    createBoardView(await dependencies.store.listProjects()),
  );

  server.get("/api/system", async () => ({
    skills: await dependencies.skillInstaller.getStatus(),
  }));

  server.get<{ Params: { taskId: string } }>(
    "/api/contexts/tasks/:taskId",
    async (request, reply) => {
      const found = await dependencies.store.findTask(request.params.taskId);
      if (!found) return reply.code(404).send({ error: "Task not found" });
      return taskContext(dependencies.store, found.project, found.task);
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
        taskDocuments: snapshot.tasks.map((task) =>
          dependencies.store.taskPath(snapshot.project.id, task.id),
        ),
        availableTaskSlots: await dependencies.workflow.availableTaskSlots(),
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

  server.post("/api/commands", async (request) => {
    const command = commandSchema.parse(request.body);
    if (command.type === "system.install_skills") {
      await dependencies.skillInstaller.install();
      return { skills: await dependencies.skillInstaller.getStatus() };
    }
    return dependencies.workflow.execute(command as CodriveCommand);
  });

  server.get("/api/events", async (request, reply) => {
    reply.hijack();
    const response = reply.raw;
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    response.write(`data: ${JSON.stringify({ type: "connected" })}\n\n`);
    const unsubscribe = dependencies.store.subscribe((event) => {
      response.write(`data: ${JSON.stringify(event)}\n\n`);
    });
    request.raw.once("close", unsubscribe);
  });

  return server;
}

function taskContext(
  store: ProjectStore,
  project: Project,
  task: Task,
) {
  return {
    taskId: task.id,
    projectId: project.id,
    attemptId: task.currentExecution?.attemptId ?? null,
    status: task.status,
    requestedAction: task.requestedAction,
    projectDirectory: store.projectDirectory(project.id),
    projectDocument: store.productDocumentPath(project.id),
    taskDocument: store.taskPath(project.id, task.id),
    repositoryPath: project.repositoryPath,
    projectContextNotes: project.contextNotes ?? [],
    workspacePath: task.workspacePath ?? null,
  };
}
