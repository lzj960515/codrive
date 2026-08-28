import type { Server as HttpServer } from "node:http";

import { Server, type Socket } from "socket.io";
import { z } from "zod";

import type { SystemStatusEventSource } from "../../domain/system-update.js";
import type { CodriveEvent } from "../../domain/types.js";
import { changesProjectProjection } from "../../domain/lifecycle-event.js";
import type {
  ExecutionActivitySignal,
  ExecutionActivityUpdate,
} from "../../domain/execution-activity.js";
import type { ExecutionActivityBridge } from "../../application/execution-activity-bridge.js";
import type { ProjectStore } from "../../infrastructure/project-store.js";

interface ServerToClientEvents {
  "projects:changed": (event: { projectId: string }) => void;
  "project:changed": (event: { projectId: string }) => void;
  "task:changed": (event: { projectId: string; taskId: string }) => void;
  "task:activity": (event: ExecutionActivityUpdate) => void;
  "system:changed": (event: Record<string, never>) => void;
}

interface ClientToServerEvents {
  "watch:project": WatchProjectRequest;
  "unwatch:project": WatchProjectRequest;
  "watch:task": WatchTaskRequest;
  "unwatch:task": WatchTaskRequest;
  "watch:system": EmptyWatchRequest;
  "unwatch:system": EmptyWatchRequest;
}

type WatchAcknowledgement = (result: WatchResult) => void;
type WatchProjectRequest = (
  request: unknown,
  acknowledge: WatchAcknowledgement,
) => void;
type WatchTaskRequest = (
  request: unknown,
  acknowledge: WatchAcknowledgement,
) => void;
type EmptyWatchRequest = (
  request: unknown,
  acknowledge: WatchAcknowledgement,
) => void;

interface SocketWatchState {
  projectId?: string;
  taskId?: string;
  watchesSystem?: boolean;
  requestQueue: Promise<void>;
}

interface WatchResult {
  ok: boolean;
  error?: string;
  activity?: ExecutionActivitySignal | null;
}

interface BoardRealtimeOptions {
  httpServer: HttpServer;
  accessToken: string;
  store: ProjectStore;
  activitySource?: Pick<
    ExecutionActivityBridge,
    "read" | "subscribe" | "isCurrent"
  >;
  systemEvents?: readonly SystemStatusEventSource[];
}

type BoardSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  SocketWatchState
>;

const projectRequestSchema = z.object({ projectId: z.string().min(1) }).strict();
const taskRequestSchema = z.object({ taskId: z.string().min(1) }).strict();
const emptyRequestSchema = z.object({}).strict();
const projectListEventTypes = new Set(["project.archived", "project.unarchived"]);

export class BoardRealtimeGateway {
  private readonly io: Server<
    ClientToServerEvents,
    ServerToClientEvents,
    Record<string, never>,
    SocketWatchState
  >;
  private readonly unsubscribeStore: () => void;
  private readonly unsubscribeSystem: (() => void)[];
  private readonly unsubscribeActivity: () => void;
  private closed = false;

  constructor(private readonly options: BoardRealtimeOptions) {
    this.io = new Server(options.httpServer, {
      serveClient: true,
    });
    this.io.use((socket, next) => {
      const token = z.string().safeParse(socket.handshake.auth.token);
      next(token.success && token.data === options.accessToken ? undefined : new Error("Unauthorized"));
    });
    this.io.on("connection", (socket) => this.acceptConnection(socket));
    this.unsubscribeStore = options.store.subscribe((event) =>
      this.publishProjectChange(event),
    );
    this.unsubscribeSystem = (options.systemEvents ?? []).map((source) =>
      source.subscribe(() => {
        this.io.to(systemRoom).emit("system:changed", {});
      }),
    );
    this.unsubscribeActivity = options.activitySource
      ? options.activitySource.subscribe((update) => {
          void this.publishActivity(update);
        })
      : () => undefined;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribeStore();
    this.unsubscribeActivity();
    for (const unsubscribe of this.unsubscribeSystem) unsubscribe();
    await new Promise<void>((resolve) => this.io.close(() => resolve()));
  }

  private acceptConnection(socket: BoardSocket): void {
    socket.data.requestQueue = Promise.resolve();
    socket.on("watch:project", (request, acknowledge) => {
      this.enqueue(socket, acknowledge, async () => {
        const { projectId } = projectRequestSchema.parse(request);
        if (!(await this.options.store.getProject(projectId))) {
          throw new Error("Project not found");
        }
        await this.replaceProjectWatch(socket, projectId);
      });
    });
    socket.on("unwatch:project", (request, acknowledge) => {
      this.enqueue(socket, acknowledge, async () => {
        const { projectId } = projectRequestSchema.parse(request);
        if (socket.data.projectId === projectId) await this.leaveProject(socket);
      });
    });
    socket.on("watch:task", (request, acknowledge) => {
      this.enqueue(socket, acknowledge, async () => {
        const { taskId } = taskRequestSchema.parse(request);
        const found = await this.options.store.findTask(taskId);
        if (!found) throw new Error("Task not found");
        if (found.project.id !== socket.data.projectId) {
          throw new Error("Task is outside the watched project");
        }
        return this.replaceTaskWatch(socket, taskId);
      });
    });
    socket.on("unwatch:task", (request, acknowledge) => {
      this.enqueue(socket, acknowledge, async () => {
        const { taskId } = taskRequestSchema.parse(request);
        if (socket.data.taskId === taskId) await this.leaveTask(socket);
      });
    });
    socket.on("watch:system", (request, acknowledge) => {
      this.enqueue(socket, acknowledge, async () => {
        emptyRequestSchema.parse(request);
        if (!socket.data.watchesSystem) {
          await socket.join(systemRoom);
          socket.data.watchesSystem = true;
        }
      });
    });
    socket.on("unwatch:system", (request, acknowledge) => {
      this.enqueue(socket, acknowledge, async () => {
        emptyRequestSchema.parse(request);
        if (socket.data.watchesSystem) {
          await socket.leave(systemRoom);
          socket.data.watchesSystem = false;
        }
      });
    });
  }

  private enqueue(
    socket: BoardSocket,
    acknowledge: WatchAcknowledgement,
    operation: () => Promise<Omit<WatchResult, "ok"> | void>,
  ): void {
    const respond = typeof acknowledge === "function" ? acknowledge : () => undefined;
    const request = socket.data.requestQueue.then(async () => {
      try {
        const result = await operation();
        respond({ ok: true, ...result });
      } catch (error) {
        respond({
          ok: false,
          error: error instanceof z.ZodError
            ? "Invalid realtime request"
            : error instanceof Error
              ? error.message
              : "Realtime request failed",
        });
      }
    });
    socket.data.requestQueue = request.catch(() => undefined);
  }

  private async replaceProjectWatch(
    socket: BoardSocket,
    projectId: string,
  ): Promise<void> {
    if (socket.data.projectId === projectId) return;
    await this.leaveProject(socket);
    await socket.join(projectRoom(projectId));
    socket.data.projectId = projectId;
  }

  private async replaceTaskWatch(
    socket: BoardSocket,
    taskId: string,
  ): Promise<{ activity: ExecutionActivitySignal | null } | void> {
    if (socket.data.taskId !== taskId) {
      await this.leaveTask(socket);
      await socket.join(taskRoom(taskId));
      socket.data.taskId = taskId;
    }
    if (!this.options.activitySource) return;
    return { activity: await this.options.activitySource.read(taskId) };
  }

  private async leaveProject(socket: BoardSocket): Promise<void> {
    await this.leaveTask(socket);
    if (!socket.data.projectId) return;
    await socket.leave(projectRoom(socket.data.projectId));
    delete socket.data.projectId;
  }

  private async leaveTask(socket: BoardSocket): Promise<void> {
    if (!socket.data.taskId) return;
    await socket.leave(taskRoom(socket.data.taskId));
    delete socket.data.taskId;
  }

  private publishProjectChange(event: CodriveEvent): void {
    if (!changesProjectProjection(event.type)) return;
    if (projectListEventTypes.has(event.type)) {
      this.io.emit("projects:changed", { projectId: event.projectId });
    }
    this.io.to(projectRoom(event.projectId)).emit("project:changed", {
      projectId: event.projectId,
    });
    if (event.taskId) {
      this.io.to(taskRoom(event.taskId)).emit("task:changed", {
        projectId: event.projectId,
        taskId: event.taskId,
      });
    }
  }

  private async publishActivity(update: ExecutionActivityUpdate): Promise<void> {
    const source = this.options.activitySource;
    if (!source) return;
    const current = await source.read(update.taskId);
    if (update.activity) {
      if (current !== update.activity || !(await source.isCurrent(update.activity))) {
        return;
      }
    } else if (current !== null) {
      return;
    }
    this.io.to(taskRoom(update.taskId)).emit("task:activity", update);
  }
}

const systemRoom = "system";

function projectRoom(projectId: string): string {
  return `project:${projectId}`;
}

function taskRoom(taskId: string): string {
  return `task:${taskId}`;
}
