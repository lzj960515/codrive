import type { LiveSyncEnvelope } from "../../domain/live-sync.js";

export interface LiveSyncClientState {
  route:
    | { type: "board" }
    | { type: "project"; projectId: string }
    | { type: "settings" };
  selectedProjectId: string | null;
  selectedTaskId: string | null;
}

export interface LiveSyncRefreshPlan {
  board?: true;
  projectId?: string;
  taskId?: string;
  settings?: true;
  system?: true;
}

interface LiveSyncSocket {
  addEventListener(
    name: string,
    listener: (event?: { data?: unknown }) => void,
  ): void;
  close(code?: number, reason?: string): void;
}

export type LiveSyncConnectionStatus =
  | "connecting"
  | "reconnecting"
  | "connected"
  | "protocol_error";

export interface LiveSyncControllerOptions {
  createSocket(): LiveSyncSocket;
  applyEvent(event: LiveSyncEnvelope): Promise<void>;
  resync(): Promise<void>;
  onStatus(status: LiveSyncConnectionStatus): void;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

export interface LiveSyncController {
  start(): void;
  stop(): void;
}

export interface PreservedLiveUiState {
  fields: Array<{
    key: string;
    value: string;
    checked: boolean;
  }>;
  activeFieldKey: string | null;
  selectionStart: number | null;
  selectionEnd: number | null;
  scroll: Array<{ key: string; left: number; top: number }>;
  windowX: number;
  windowY: number;
}

export function liveSyncRefreshPlan(
  event: LiveSyncEnvelope | null,
  state: LiveSyncClientState,
): LiveSyncRefreshPlan {
  if (!event) {
    return {
      board: true,
      ...(state.route.type === "project"
        ? { projectId: state.route.projectId }
        : {}),
      ...(state.route.type === "settings" ? { settings: true } : {}),
      ...(state.route.type === "board" && state.selectedTaskId
        ? { taskId: state.selectedTaskId }
        : {}),
      system: true,
    };
  }
  if (event.scope === "system") return { system: true };
  if (event.scope === "settings") {
    return state.route.type === "settings" ? { settings: true } : {};
  }
  if (event.scope === "project") {
    return {
      board: true,
      ...(state.route.type === "project" &&
      state.route.projectId === event.projectId
        ? { projectId: event.projectId }
        : {}),
    };
  }
  if (event.scope === "task") {
    return {
      board: true,
      ...(state.route.type === "project" &&
      state.route.projectId === event.projectId
        ? { projectId: event.projectId }
        : {}),
      ...(state.route.type === "board" &&
      state.selectedTaskId === event.taskId
        ? { taskId: event.taskId }
        : {}),
    };
  }
  return {};
}

export function createLiveSyncController(
  options: LiveSyncControllerOptions,
): LiveSyncController {
  const reconnectDelays = [500, 1_000, 2_000, 5_000, 10_000];
  const setTimer =
    options.setTimer ??
    ((callback: () => void, delayMs: number) =>
      globalThis.setTimeout(callback, delayMs));
  const clearTimer =
    options.clearTimer ??
    ((timer: unknown) => globalThis.clearTimeout(timer as number));
  let socket: LiveSyncSocket | null = null;
  let reconnectTimer: unknown = null;
  let reconnectAttempt = 0;
  let connectionGeneration = 0;
  let expectedSequence = 0;
  let connectedBefore = false;
  let stopped = false;
  let messageQueue = Promise.resolve();

  const isEnvelope = (value: unknown): value is LiveSyncEnvelope => {
    if (!value || typeof value !== "object") return false;
    const envelope = value as Partial<LiveSyncEnvelope>;
    const supportedTypes = [
      "live.connected",
      "project.changed",
      "task.changed",
      "settings.changed",
      "system.changed",
      "presence.changed",
    ];
    const supportedScopes = [
      "connection",
      "project",
      "task",
      "settings",
      "system",
    ];
    return (
      envelope.schemaVersion === 1 &&
      Number.isSafeInteger(envelope.sequence) &&
      (envelope.sequence ?? 0) > 0 &&
      supportedTypes.includes(envelope.type ?? "") &&
      supportedScopes.includes(envelope.scope ?? "") &&
      (envelope.scope !== "project" || typeof envelope.projectId === "string") &&
      (envelope.scope !== "task" ||
        (typeof envelope.projectId === "string" &&
          typeof envelope.taskId === "string"))
    );
  };

  const scheduleReconnect = () => {
    if (stopped || reconnectTimer !== null) return;
    options.onStatus("reconnecting");
    const delay = reconnectDelays[
      Math.min(reconnectAttempt, reconnectDelays.length - 1)
    ]!;
    reconnectAttempt += 1;
    reconnectTimer = setTimer(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  };

  const rejectMessage = async (current: LiveSyncSocket) => {
    options.onStatus("protocol_error");
    try {
      await options.resync();
    } catch {
      // Reconnecting will retry the authoritative read on a fresh baseline.
    } finally {
      current.close(1002, "Unsupported live sync message");
    }
  };

  const processMessage = async (
    data: unknown,
    current: LiveSyncSocket,
    generation: number,
  ) => {
    if (stopped || generation !== connectionGeneration) return;
    let message: unknown;
    try {
      message = typeof data === "string" ? JSON.parse(data) : data;
    } catch {
      await rejectMessage(current);
      return;
    }
    if (!isEnvelope(message)) {
      await rejectMessage(current);
      return;
    }
    if (message.type === "live.connected") {
      if (message.scope !== "connection" || message.sequence !== 1) {
        await rejectMessage(current);
        return;
      }
      expectedSequence = message.sequence;
      reconnectAttempt = 0;
      await options.resync();
      connectedBefore = true;
      options.onStatus("connected");
      return;
    }
    if (expectedSequence === 0) {
      await rejectMessage(current);
      return;
    }
    if (message.sequence !== expectedSequence + 1) {
      expectedSequence = message.sequence;
      await options.resync();
      return;
    }
    expectedSequence = message.sequence;
    await options.applyEvent(message);
  };

  const connect = () => {
    if (stopped) return;
    const current = options.createSocket();
    socket = current;
    expectedSequence = 0;
    const generation = ++connectionGeneration;
    options.onStatus(connectedBefore ? "reconnecting" : "connecting");
    current.addEventListener("message", (event) => {
      messageQueue = messageQueue
        .then(() => processMessage(event?.data, current, generation))
        .catch(() => {
          options.onStatus("reconnecting");
          current.close(1012, "Live sync resync required");
        });
    });
    current.addEventListener("close", () => {
      if (generation !== connectionGeneration) return;
      socket = null;
      expectedSequence = 0;
      scheduleReconnect();
    });
    current.addEventListener("error", () => {
      if (generation === connectionGeneration && !stopped) {
        options.onStatus("reconnecting");
      }
    });
  };

  return {
    start() {
      if (socket || reconnectTimer !== null) return;
      stopped = false;
      connect();
    },
    stop() {
      stopped = true;
      connectionGeneration += 1;
      if (reconnectTimer !== null) {
        clearTimer(reconnectTimer);
        reconnectTimer = null;
      }
      const current = socket;
      socket = null;
      current?.close(1000, "Page closed");
    },
  };
}

export function captureLiveUiState(
  document: Document,
  window: Pick<Window, "scrollX" | "scrollY">,
): PreservedLiveUiState {
  const editable = Array.from(
    document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
      "input, textarea, select",
    ),
  );
  const fieldKey = (
    field: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
    index: number,
  ) => field.id || field.dataset.liveSyncKey || `${field.name || "field"}:${index}`;
  const activeIndex = editable.indexOf(
    document.activeElement as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  );
  const active = activeIndex >= 0 ? editable[activeIndex]! : null;
  const selectionStart =
    active && "selectionStart" in active ? active.selectionStart : null;
  const selectionEnd =
    active && "selectionEnd" in active ? active.selectionEnd : null;
  const preserveField = (
    field: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  ) => {
    if (field === active) return true;
    if ("defaultChecked" in field && field.checked !== field.defaultChecked) {
      return true;
    }
    if ("defaultValue" in field && field.value !== field.defaultValue) {
      return true;
    }
    if ("options" in field) {
      return Array.from(field.options).some(
        (option) => option.selected !== option.defaultSelected,
      );
    }
    return false;
  };
  return {
    fields: editable.flatMap((field, index) =>
      preserveField(field)
        ? [{
            key: fieldKey(field, index),
            value: field.value,
            checked: "checked" in field ? field.checked : false,
          }]
        : [],
    ),
    activeFieldKey: active ? fieldKey(active, activeIndex) : null,
    selectionStart,
    selectionEnd,
    scroll: Array.from(
      document.querySelectorAll<HTMLElement>("[data-preserve-scroll]"),
    ).map((element, index) => ({
      key: element.dataset.preserveScroll || String(index),
      left: element.scrollLeft,
      top: element.scrollTop,
    })),
    windowX: window.scrollX,
    windowY: window.scrollY,
  };
}

export function restoreLiveUiState(
  document: Document,
  window: Pick<Window, "scrollTo">,
  state: PreservedLiveUiState,
): void {
  const editable = Array.from(
    document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
      "input, textarea, select",
    ),
  );
  const fieldKey = (
    field: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
    index: number,
  ) => field.id || field.dataset.liveSyncKey || `${field.name || "field"}:${index}`;
  const values = new Map(state.fields.map((field) => [field.key, field]));
  for (const [index, field] of editable.entries()) {
    const saved = values.get(fieldKey(field, index));
    if (!saved) continue;
    field.value = saved.value;
    if ("checked" in field) field.checked = saved.checked;
  }
  const activeIndex = editable.findIndex(
    (field, index) => fieldKey(field, index) === state.activeFieldKey,
  );
  const active = activeIndex >= 0 ? editable[activeIndex]! : null;
  active?.focus();
  if (
    active &&
    "setSelectionRange" in active &&
    state.selectionStart !== null &&
    state.selectionEnd !== null
  ) {
    active.setSelectionRange(state.selectionStart, state.selectionEnd);
  }
  const scrollPositions = new Map(state.scroll.map((item) => [item.key, item]));
  for (const [index, element] of Array.from(
    document.querySelectorAll<HTMLElement>("[data-preserve-scroll]"),
  ).entries()) {
    const saved = scrollPositions.get(
      element.dataset.preserveScroll || String(index),
    );
    if (!saved) continue;
    element.scrollLeft = saved.left;
    element.scrollTop = saved.top;
  }
  window.scrollTo(state.windowX, state.windowY);
}

export function renderLiveSyncClientRuntime(): string {
  return [
    `const liveSyncRefreshPlan = ${liveSyncRefreshPlan.toString()};`,
    `const createLiveSyncController = ${createLiveSyncController.toString()};`,
    `const captureLiveUiState = ${captureLiveUiState.toString()};`,
    `const restoreLiveUiState = ${restoreLiveUiState.toString()};`,
  ].join("\n");
}
