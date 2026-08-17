# Codrive Agent Guide

Codrive is a local, single-user orchestration service that connects filesystem-backed product state, Codex App Server conversations, and reusable Skills.

## Architecture

- `src/domain` owns project, task, execution, report, and event contracts.
- `src/application` owns deterministic workflow decisions and dispatch coordination.
- `ProjectExecutionCoordinator` owns temporary task-selection turns.
- `model-routing.ts` owns capacity-failure classification, persisted retry state, exponential backoff, and fallback routing for every Codex turn.
- `PackageVersionCheckScheduler` owns startup compensation, the persisted hourly npm check cadence, and live board status events; `PackageVersionService` owns npm access, validation, caching, and in-flight deduplication.
- `SystemSettingsService` owns validated runtime concurrency and model configuration changes.
- `src/infrastructure` owns filesystem persistence, App Server transport, and managed Skill/Hook installation.
- `src/interfaces` owns the HTTP API, authenticated Socket.IO board transport, CLI, and local board.
- `skills` contains the product's installable Codex Skills.

Project-level Codex turns decide which backlog tasks should start from current product and repository facts. Codrive validates IDs, task availability, each project's concurrency budget, and the repository integration lease. Codex reevaluates task relationships during every selection.

Every execution persists the model selected when it starts. Capacity failures preserve the current attempt, stage, and conversation while the recovery timer performs three exponential-backoff retries before opening the primary circuit and routing to the configured fallback model. Route health follows later task stages and project-planning revisions. After a five-minute cooldown, the next natural turn probes the primary model without interrupting active fallback work. A failed probe immediately reopens the circuit and restores the fallback failure budget; a probe that stays healthy for five minutes closes the circuit and clears its failures. Scheduled retries count against the owning project's concurrency budget and resume after a paused project is continued.

Task recovery reattaches the persisted conversation and starts a new turn in the current attempt, action, and model route. Successful recovery is auditable through task activities; an unavailable persisted conversation produces an explicit blocked recovery result.

`ExecutionActivityBridge` accepts live activity only from the managed Hook endpoint and keeps the latest safe activity plus the exact execution's Hook `lastSeen` only in process memory. Opening task detail may read one safe App Server snapshot without renewing that window. Startup creates a fresh observation window. After ten minutes without a valid Hook request, `RecoveryManager` reads the exact thread and turn snapshot: `inProgress` resets the window, `completed` uses the normal completion path, and a coherent `interrupted` or `failed` turn reaches the serialized recovery entry point. An unloaded persisted thread remains coherent when the exact turn is terminal and no turn is active. Missing, unreadable, contradictory, superseded, paused, or capacity-blocked work remains unchanged for a later check, while Presence stays an in-memory concern.

The updated service owns final managed-resource verification because an older detached upgrade worker cannot know resources introduced by the package it installs. A successful upgrade records the package version whose complete Skill/Hook contract was confirmed. On startup, `ManagedResourceUpgradeReconciler` completes only an unmarked current-version success; later user removal remains an explicit repair action instead of being silently reversed on every restart.

Scheduled blockers are persisted task-execution waits. They keep the action, attempt, conversation, model route, absolute deadline, reason, and AI resume checkpoint while releasing project capacity and the repository integration lease. Every reportable turn has a server-generated `reportOpportunityId`; a resumed turn rotates that identity within the same attempt, while `submittedActivityId` continues to point at the current recorded decision. Reports and immutable report activities carry the opportunity identity so retries remain idempotent without allowing an earlier turn to occupy the resumed turn. A persisted legacy execution with neither identity accepts its first nonhistorical report as the current opportunity, then uses `submittedActivityId` for idempotency; an exact historical replay remains a conflict. `WorkflowEngine` owns due, early, rescheduled, paused, cancelled, duplicate-wakeup, and report-opportunity decisions; `RecoveryManager` only maintains exact deadline wakeups and startup/reconnect compensation.

The HTTP surface has four read boundaries: board projection, product detail, runtime settings, and Skill context. The board projection provides an initial project list and a project-scoped snapshot for later refreshes. Writes use the unified `/api/commands` endpoint. State transitions belong to `WorkflowEngine`, and validated runtime configuration belongs to `SystemSettingsService`, not route handlers.

Socket.IO carries scoped invalidation signals, while HTTP remains authoritative for data. `BoardRealtimeGateway` authenticates the handshake, derives `project:<id>`, `task:<id>`, and `system` rooms from validated watch requests, and maps Store or system events to `project:changed`, `task:changed`, and `system:changed`. Browser reconnects restore only the current watches and reread only those HTTP scopes.

Keep Git worktree creation, coding, review, conflict resolution, commits, merges, and cleanup inside Codex task instructions. Codrive persists state and dispatches conversations; it does not implement those Git workflows.

## Commands

```text
pnpm test
pnpm typecheck
pnpm build
pnpm dev
```

Use Node.js 24 for development and runtime. Keep the published package, CI, documentation, CLI diagnostics, and bundled Skills aligned with this baseline.
