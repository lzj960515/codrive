import type {
  ExecutionModelRouting,
  ModelRoutingSettings,
} from "../domain/types.js";

export interface CodexTurnFailure {
  turnId: string;
  message: string;
  codexErrorInfo?: unknown;
}

export type ModelCapacityRecovery =
  | { outcome: "retry_scheduled"; routing: ExecutionModelRouting }
  | { outcome: "exhausted"; routing: ExecutionModelRouting };

export const defaultModelCapacityRetryDelaysMs = [5_000, 10_000, 20_000] as const;
export const defaultModelCapacityRetryResetAfterMs = 5 * 60_000;
export const defaultModelPrimaryProbeAfterMs = 5 * 60_000;

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
): ModelCapacityRecovery {
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
        route: "fallback",
        retryCount: current.circuitBreaker.fallbackRetryCount,
        circuitBreaker: openCircuit(now, primaryProbeAfterMs),
        nextRetryAt: now.toISOString(),
        lastError,
      },
    };
  }

  const nextDelay = retryDelaysMs[current.retryCount];
  if (nextDelay !== undefined) {
    return {
      outcome: "retry_scheduled",
      routing: {
        ...current,
        retryCount: current.retryCount + 1,
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

export function isModelCapacityFailure(failure: CodexTurnFailure): boolean {
  return (
    failure.codexErrorInfo === "serverOverloaded" ||
    failure.message.includes("Selected model is at capacity")
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
  if (
    current.route === "primary" &&
    current.circuitBreaker?.state === "half_open"
  ) {
    return {
      ...current,
      circuitBreaker: {
        ...current.circuitBreaker,
        probeStartedAt: now.toISOString(),
      },
    };
  }
  if (current.route !== "fallback") return current;
  const circuit = current.circuitBreaker;
  if (!circuit) {
    return {
      ...current,
      circuitBreaker: openCircuit(now, primaryProbeAfterMs),
    };
  }
  if (
    circuit.state === "open" &&
    Number.isFinite(Date.parse(circuit.primaryProbeAt)) &&
    Date.parse(circuit.primaryProbeAt) > now.getTime()
  ) {
    return current;
  }

  const probing: ExecutionModelRouting = {
    ...current,
    model: settings.primary,
    route: "primary",
    retryCount: 0,
    circuitBreaker: {
      state: "half_open",
      fallbackRetryCount: current.retryCount,
      probeStartedAt: now.toISOString(),
    },
  };
  delete probing.nextRetryAt;
  return probing;
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
