import type { WebSocket } from "@fastify/websocket";

import type { VersionStatusEventSource } from "../../application/package-version-check-scheduler.js";
import {
  createLiveSyncEnvelope,
  liveSyncChangeForStoreEvent,
  type LiveSyncChange,
} from "../../domain/live-sync.js";
import type { ProjectStore } from "../../infrastructure/project-store.js";

export interface LiveSyncServerDependencies {
  store: Pick<ProjectStore, "subscribe">;
  systemUpdateEvents?: VersionStatusEventSource;
}

export class LiveSyncServer {
  private readonly sessions = new Set<LiveSyncSession>();

  constructor(private readonly dependencies: LiveSyncServerDependencies) {}

  connect(socket: WebSocket): void {
    const session = new LiveSyncSession(
      socket,
      this.dependencies,
      () => this.sessions.delete(session),
    );
    this.sessions.add(session);
    session.start();
  }

  publish(change: LiveSyncChange): void {
    for (const session of this.sessions) session.publish(change);
  }
}

class LiveSyncSession {
  private sequence = 0;
  private unsubscribeStore: (() => void) | null = null;
  private unsubscribeSystem: (() => void) | null = null;
  private closed = false;

  constructor(
    private readonly socket: WebSocket,
    private readonly dependencies: LiveSyncServerDependencies,
    private readonly onClose: () => void,
  ) {}

  start(): void {
    this.unsubscribeStore = this.dependencies.store.subscribe((event) => {
      this.publish(liveSyncChangeForStoreEvent(event));
    });
    this.unsubscribeSystem = this.dependencies.systemUpdateEvents?.subscribe(
      () => {
        this.publish({ type: "system.changed", scope: "system" });
      },
    ) ?? null;
    this.socket.once("close", () => this.close());
    this.socket.once("error", () => this.close());
    this.publish({ type: "live.connected", scope: "connection" });
  }

  publish(change: LiveSyncChange): void {
    if (this.closed || this.socket.readyState !== 1) return;
    const message = createLiveSyncEnvelope(change, ++this.sequence);
    try {
      this.socket.send(JSON.stringify(message));
    } catch {
      this.close();
      this.socket.close();
    }
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribeStore?.();
    this.unsubscribeStore = null;
    this.unsubscribeSystem?.();
    this.unsubscribeSystem = null;
    this.onClose();
  }
}
