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
): ModelCapacityRecovery {
  const lastError = {
    kind: "model_capacity" as const,
    message: failure.message,
    failedAt: now.toISOString(),
  };
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
