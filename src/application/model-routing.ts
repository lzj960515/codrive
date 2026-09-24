import type {
  ExecutionModelRouting,
  ModelRoutingSettings,
  ReasoningEffort,
} from "../domain/types.js";

export interface CodexTurnFailure {
  turnId: string;
  message: string;
  codexErrorInfo?: unknown;
}

export type TurnFailureRecovery =
  | { outcome: "retry_scheduled"; routing: ExecutionModelRouting }
  | { outcome: "exhausted"; routing: ExecutionModelRouting };

export const defaultModelCapacityRetryDelaysMs = [5_000, 10_000, 20_000] as const;
export const defaultModelCapacityRetryResetAfterMs = 5 * 60_000;
export const defaultModelPrimaryProbeAfterMs = 5 * 60_000;

const disconnectedResponseMessage =
  "stream disconnected before completion: Transport error: network error: error decoding response body";

export function resetCapacityFailuresAfterStableTurn(
  current: ExecutionModelRouting,
  turnStartedAt: string | undefined,
  now: Date,
  resetAfterMs: number,
): ExecutionModelRouting {
  if (!turnStartedAt) return current;
  const stableSince =
    current.circuitBreaker?.state === "half_open"
      ? current.circuitBreaker.probeStartedAt
      : turnStartedAt;
  const startedAt = Date.parse(stableSince);
  if (!Number.isFinite(startedAt) || now.getTime() - startedAt < resetAfterMs) {
    return current;
  }

  const primaryProbeRecovered = current.circuitBreaker?.state === "half_open";
  if (current.retryCount === 0 && !primaryProbeRecovered) return current;

  const reset: ExecutionModelRouting = {
    ...current,
    retryCount: 0,
    ...(primaryProbeRecovered
      ? { circuitBreaker: { state: "closed" as const } }
      : {}),
  };
  delete reset.nextRetryAt;
  delete reset.lastError;
  return reset;
}

export function initialModelRouting(
  settings: ModelRoutingSettings,
): ExecutionModelRouting {
  return {
    model: settings.primary,
    ...(settings.primaryReasoningEffort !== undefined
      ? { reasoningEffort: settings.primaryReasoningEffort }
      : {}),
    route: "primary",
    retryCount: 0,
  };
}

export function planModelCapacityRecovery(
  current: ExecutionModelRouting,
  failure: CodexTurnFailure,
  settings: ModelRoutingSettings,
  now: Date,
  retryDelaysMs: readonly number[],
  primaryProbeAfterMs: number,
): TurnFailureRecovery {
  const lastError = {
    kind: "model_capacity" as const,
    message: failure.message,
    failedAt: now.toISOString(),
  };
  if (current.circuitBreaker?.state === "half_open") {
    return {
      outcome: "retry_scheduled",
      routing: {
        model: settings.fallback,
        ...(settings.fallbackReasoningEffort !== undefined
          ? { reasoningEffort: settings.fallbackReasoningEffort }
          : {}),
        route: "fallback",
        retryCount: current.circuitBreaker.fallbackRetryCount,
        circuitBreaker: openCircuit(now, primaryProbeAfterMs),
        nextRetryAt: now.toISOString(),
        lastError,
      },
    };
  }

  const retryCount = current.lastError?.kind === "transport_error" ? 0 : current.retryCount;
  const nextDelay = retryDelaysMs[retryCount];
  if (nextDelay !== undefined) {
    return {
      outcome: "retry_scheduled",
      routing: {
        ...current,
        retryCount: retryCount + 1,
        nextRetryAt: new Date(now.getTime() + nextDelay).toISOString(),
        lastError,
      },
    };
  }
  if (current.route === "primary") {
    return {
      outcome: "retry_scheduled",
      routing: {
        model: settings.fallback,
        ...(settings.fallbackReasoningEffort !== undefined
          ? { reasoningEffort: settings.fallbackReasoningEffort }
          : {}),
        route: "fallback",
        retryCount: 0,
        circuitBreaker: openCircuit(now, primaryProbeAfterMs),
        nextRetryAt: now.toISOString(),
        lastError,
      },
    };
  }
  return {
    outcome: "exhausted",
    routing: { ...current, lastError },
  };
}

export function planTurnFailureRecovery(
  current: ExecutionModelRouting,
  failure: CodexTurnFailure,
  settings: ModelRoutingSettings,
  now: Date,
  retryDelaysMs: readonly number[],
  resetAfterMs: number,
  primaryProbeAfterMs: number,
  turnStartedAt?: string,
): TurnFailureRecovery | undefined {
  const modelCapacity = isModelCapacityFailure(failure);
  const disconnectedResponse = isDisconnectedResponseFailure(failure);
  if (!modelCapacity && !disconnectedResponse) return undefined;

  const routing = resetCapacityFailuresAfterStableTurn(
    current,
    turnStartedAt,
    now,
    resetAfterMs,
  );
  return modelCapacity
    ? planModelCapacityRecovery(routing, failure, settings, now, retryDelaysMs, primaryProbeAfterMs)
    : planDisconnectedResponseRecovery(routing, failure, now, retryDelaysMs);
}

function planDisconnectedResponseRecovery(
  current: ExecutionModelRouting,
  failure: CodexTurnFailure,
  now: Date,
  retryDelaysMs: readonly number[],
): TurnFailureRecovery {
  const retryCount = current.lastError?.kind === "transport_error" ? current.retryCount : 0;
  const lastError = {
    kind: "transport_error" as const,
    message: failure.message,
    failedAt: now.toISOString(),
  };
  const nextDelay = retryDelaysMs[retryCount];
  if (nextDelay === undefined) {
    return { outcome: "exhausted", routing: { ...current, retryCount, lastError } };
  }
  return {
    outcome: "retry_scheduled",
    routing: {
      ...current,
      retryCount: retryCount + 1,
      nextRetryAt: new Date(now.getTime() + nextDelay).toISOString(),
      lastError,
    },
  };
}

export function isModelCapacityFailure(failure: CodexTurnFailure): boolean {
  return (
    failure.codexErrorInfo === "serverOverloaded" ||
    failure.message.includes("Selected model is at capacity")
  );
}

function isDisconnectedResponseFailure(failure: CodexTurnFailure): boolean {
  return (
    failure.message.includes(disconnectedResponseMessage) ||
    (typeof failure.codexErrorInfo === "object" &&
      failure.codexErrorInfo !== null &&
      "responseStreamDisconnected" in failure.codexErrorInfo)
  );
}

export function isRetryDue(
  routing: ExecutionModelRouting,
  now: Date,
): boolean {
  return Boolean(
    routing.nextRetryAt && Date.parse(routing.nextRetryAt) <= now.getTime(),
  );
}

export function markRetryStarted(
  routing: ExecutionModelRouting,
): ExecutionModelRouting {
  const started = { ...routing };
  delete started.nextRetryAt;
  return started;
}

export function prepareModelRoutingForTurn(
  current: ExecutionModelRouting,
  settings: ModelRoutingSettings,
  now: Date,
  primaryProbeAfterMs: number,
): ExecutionModelRouting {
  const configuredModel =
    current.route === "primary" ? settings.primary : settings.fallback;
  if (current.model !== configuredModel) {
    return initialModelRouting(settings);
  }
  const reasoningEffort =
    current.route === "primary"
      ? settings.primaryReasoningEffort
      : settings.fallbackReasoningEffort;
  const routing = withReasoningEffort(current, reasoningEffort);
  if (
    routing.route === "primary" &&
    routing.circuitBreaker?.state === "half_open"
  ) {
    return {
      ...routing,
      circuitBreaker: {
        ...routing.circuitBreaker,
        probeStartedAt: now.toISOString(),
      },
    };
  }
  if (routing.route !== "fallback") return routing;
  const circuit = routing.circuitBreaker;
  if (!circuit) {
    return {
      ...routing,
      circuitBreaker: openCircuit(now, primaryProbeAfterMs),
    };
  }
  if (
    circuit.state === "open" &&
    Number.isFinite(Date.parse(circuit.primaryProbeAt)) &&
    Date.parse(circuit.primaryProbeAt) > now.getTime()
  ) {
    return routing;
  }

  const probing: ExecutionModelRouting = {
    ...routing,
    model: settings.primary,
    route: "primary",
    retryCount: 0,
    circuitBreaker: {
      state: "half_open",
      fallbackRetryCount: routing.retryCount,
      probeStartedAt: now.toISOString(),
    },
  };
  delete probing.nextRetryAt;
  return withReasoningEffort(probing, settings.primaryReasoningEffort);
}

function withReasoningEffort(
  routing: ExecutionModelRouting,
  reasoningEffort: ReasoningEffort | undefined,
): ExecutionModelRouting {
  if (routing.reasoningEffort === reasoningEffort) return routing;
  const configured = { ...routing };
  if (reasoningEffort === undefined) {
    delete configured.reasoningEffort;
  } else {
    configured.reasoningEffort = reasoningEffort;
  }
  return configured;
}

function openCircuit(
  now: Date,
  primaryProbeAfterMs: number,
): { state: "open"; primaryProbeAt: string } {
  return {
    state: "open",
    primaryProbeAt: new Date(now.getTime() + primaryProbeAfterMs).toISOString(),
  };
}
