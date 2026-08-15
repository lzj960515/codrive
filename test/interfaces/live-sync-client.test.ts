import { describe, expect, it, vi } from "vitest";

import type {
  LiveSyncChange,
  LiveSyncEnvelope,
} from "../../src/domain/live-sync.js";
import {
  captureLiveUiState,
  createLiveSyncController,
  liveSyncRefreshPlan,
  restoreLiveUiState,
} from "../../src/interfaces/http/live-sync-client.js";

describe("board live sync client", () => {
  it("plans only the projections affected by each scope", () => {
    const boardState = {
      route: { type: "board" as const },
      selectedProjectId: "project_1",
      selectedTaskId: "task_1",
    };

    expect(
      liveSyncRefreshPlan(
        event({ type: "task.changed", scope: "task", projectId: "project_1", taskId: "task_1" }),
        boardState,
      ),
    ).toEqual({ board: true, taskId: "task_1" });
    expect(
      liveSyncRefreshPlan(
        event({ type: "task.changed", scope: "task", projectId: "project_2", taskId: "task_2" }),
        boardState,
      ),
    ).toEqual({ board: true });
    expect(
      liveSyncRefreshPlan(
        event({ type: "system.changed", scope: "system" }),
        boardState,
      ),
    ).toEqual({ system: true });

    const projectState = {
      route: { type: "project" as const, projectId: "project_1" },
      selectedProjectId: "project_1",
      selectedTaskId: null,
    };
    expect(
      liveSyncRefreshPlan(
        event({ type: "project.changed", scope: "project", projectId: "project_1" }),
        projectState,
      ),
    ).toEqual({ board: true, projectId: "project_1" });
    expect(liveSyncRefreshPlan(null, projectState)).toEqual({
      board: true,
      projectId: "project_1",
      system: true,
    });
  });

  it("serializes events, resyncs sequence gaps, and resyncs every reconnect", async () => {
    const sockets: FakeSocket[] = [];
    const applied: number[] = [];
    const resync = vi.fn(async () => undefined);
    const timers: Array<() => void> = [];
    const controller = createLiveSyncController({
      createSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      applyEvent: async (message) => {
        applied.push(message.sequence);
      },
      resync,
      onStatus: vi.fn(),
      setTimer: (callback) => {
        timers.push(callback);
        return callback;
      },
      clearTimer: (timer) => {
        const index = timers.indexOf(timer as () => void);
        if (index >= 0) timers.splice(index, 1);
      },
    });

    controller.start();
    sockets[0]!.receive(event({ type: "live.connected", scope: "connection" }, 1));
    sockets[0]!.receive(event({ type: "system.changed", scope: "system" }, 2));
    sockets[0]!.receive(event({ type: "project.changed", scope: "project", projectId: "project_1" }, 4));
    await vi.waitFor(() => expect(resync).toHaveBeenCalledTimes(2));
    expect(applied).toEqual([2]);

    sockets[0]!.disconnect();
    expect(timers).toHaveLength(1);
    timers.shift()!();
    sockets[1]!.receive(event({ type: "live.connected", scope: "connection" }, 1));
    await vi.waitFor(() => expect(resync).toHaveBeenCalledTimes(3));

    controller.stop();
    expect(sockets[1]!.close).toHaveBeenCalledWith(1000, "Page closed");
    expect(timers).toHaveLength(0);
  });

  it("marks incompatible messages as protocol errors before reopening a baseline", async () => {
    const socket = new FakeSocket();
    const statuses: string[] = [];
    const resync = vi.fn(async () => undefined);
    const controller = createLiveSyncController({
      createSocket: () => socket,
      applyEvent: async () => undefined,
      resync,
      onStatus: (status) => statuses.push(status),
      setTimer: () => 1,
      clearTimer: () => undefined,
    });

    controller.start();
    socket.receive({
      schemaVersion: 2,
      sequence: 1,
      type: "live.connected",
      scope: "connection",
    });

    await vi.waitFor(() => expect(resync).toHaveBeenCalledTimes(1));
    expect(statuses).toContain("protocol_error");
    expect(socket.close).toHaveBeenCalledWith(1002, "Unsupported live sync message");
  });

  it("treats a failed authoritative refresh as a reconnect instead of a protocol error", async () => {
    const socket = new FakeSocket();
    const statuses: string[] = [];
    const controller = createLiveSyncController({
      createSocket: () => socket,
      applyEvent: async () => {
        throw new Error("HTTP service restarted");
      },
      resync: async () => undefined,
      onStatus: (status) => statuses.push(status),
      setTimer: () => 1,
      clearTimer: () => undefined,
    });

    controller.start();
    socket.receive(event({ type: "live.connected", scope: "connection" }, 1));
    socket.receive(event({ type: "system.changed", scope: "system" }, 2));

    await vi.waitFor(() => {
      expect(socket.close).toHaveBeenCalledWith(1012, "Live sync resync required");
    });
    expect(statuses).not.toContain("protocol_error");
  });

  it("caps reconnect backoff and releases the pending timer on stop", () => {
    const sockets: FakeSocket[] = [];
    const timers: Array<{ callback: () => void; delay: number }> = [];
    const delays: number[] = [];
    const controller = createLiveSyncController({
      createSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      applyEvent: async () => undefined,
      resync: async () => undefined,
      onStatus: () => undefined,
      setTimer: (callback, delay) => {
        const timer = { callback, delay };
        timers.push(timer);
        delays.push(delay);
        return timer;
      },
      clearTimer: (timer) => {
        const index = timers.indexOf(timer as (typeof timers)[number]);
        if (index >= 0) timers.splice(index, 1);
      },
    });

    controller.start();
    for (let attempt = 0; attempt < 7; attempt += 1) {
      sockets.at(-1)!.disconnect();
      if (attempt < 6) {
        const timer = timers.shift()!;
        timer.callback();
      }
    }

    expect(delays).toEqual([500, 1_000, 2_000, 5_000, 10_000, 10_000, 10_000]);
    controller.stop();
    expect(timers).toHaveLength(0);
  });

  it("restores editable values, focus, and scroll after a scoped render", () => {
    const input = fakeField("settings-max", "4");
    const scroll = { dataset: { preserveScroll: "board" }, scrollLeft: 90, scrollTop: 25 };
    const document = fakeDocument(input, scroll);
    const window = { scrollX: 12, scrollY: 34, scrollTo: vi.fn() };
    input.focus();
    input.selectionStart = 1;
    input.selectionEnd = 1;

    const state = captureLiveUiState(document as never, window as never);
    input.value = "2";
    input.selectionStart = 0;
    input.selectionEnd = 0;
    scroll.scrollLeft = 0;
    scroll.scrollTop = 0;
    restoreLiveUiState(document as never, window as never, state);

    expect(input.value).toBe("4");
    expect(input.focus).toHaveBeenCalledTimes(2);
    expect(input.setSelectionRange).toHaveBeenCalledWith(1, 1);
    expect(scroll).toMatchObject({ scrollLeft: 90, scrollTop: 25 });
    expect(window.scrollTo).toHaveBeenCalledWith(12, 34);
  });

  it("restores focus to a stable button after scoped markup replacement", () => {
    const original = fakeControl("task:task_1");
    const replacement = fakeControl("task:task_1");
    let focusable = original;
    const document = {
      activeElement: original,
      querySelectorAll(selector: string) {
        if (selector === "input, textarea, select") return [];
        if (selector === "[data-preserve-scroll]") return [];
        return [focusable];
      },
    };
    const window = { scrollX: 0, scrollY: 0, scrollTo: vi.fn() };

    const state = captureLiveUiState(document as never, window as never);
    focusable = replacement;
    restoreLiveUiState(document as never, window as never, state);

    expect(replacement.focus).toHaveBeenCalledOnce();
  });
});

function event(
  change: LiveSyncChange,
  sequence = 1,
): LiveSyncEnvelope {
  return { schemaVersion: 1, sequence, ...change } as LiveSyncEnvelope;
}

class FakeSocket {
  readonly listeners = new Map<string, Array<(event?: { data?: string }) => void>>();
  readonly close = vi.fn();

  addEventListener(name: string, listener: (event?: { data?: string }) => void) {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }

  receive(message: object) {
    for (const listener of this.listeners.get("message") ?? []) {
      listener({ data: JSON.stringify(message) });
    }
  }

  disconnect() {
    for (const listener of this.listeners.get("close") ?? []) listener();
  }
}

function fakeField(id: string, value: string) {
  return {
    id,
    name: "",
    type: "text",
    value,
    checked: false,
    selectionStart: null as number | null,
    selectionEnd: null as number | null,
    dataset: {} as Record<string, string>,
    focus: vi.fn(),
    setSelectionRange: vi.fn(),
  };
}

function fakeControl(key: string) {
  return {
    id: "",
    dataset: { liveSyncKey: key },
    focus: vi.fn(),
  };
}

function fakeDocument(
  input: ReturnType<typeof fakeField>,
  scroll: { dataset: Record<string, string>; scrollLeft: number; scrollTop: number },
) {
  const fields = [input];
  const scrolls = [scroll];
  return {
    activeElement: input,
    querySelectorAll(selector: string) {
      return selector === "[data-preserve-scroll]" ? scrolls : fields;
    },
  };
}
