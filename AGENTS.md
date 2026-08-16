# Codrive Agent Guide

Codrive is a local, single-user orchestration service that connects filesystem-backed product state, Codex App Server conversations, and reusable Skills.

## Architecture

- `src/domain` owns project, task, execution, report, and event contracts.
- `src/application` owns deterministic workflow decisions and dispatch coordination.
- `ProjectExecutionCoordinator` owns temporary task-selection turns.
- `model-routing.ts` owns capacity-failure classification, persisted retry state, exponential backoff, and fallback routing for every Codex turn.
- `PackageVersionCheckScheduler` owns startup compensation, the persisted hourly npm check cadence, and live board status events; `PackageVersionService` owns npm access, validation, caching, and in-flight deduplication.
- `SystemSettingsService` owns validated runtime concurrency and model configuration changes.
- `src/infrastructure` owns filesystem persistence, App Server transport, and Skill installation.
- `src/interfaces` owns the HTTP API, CLI, and local board.
- `skills` contains the product's installable Codex Skills.

Project-level Codex turns decide which backlog tasks should start from current product and repository facts. Codrive validates IDs, task availability, each project's concurrency budget, and the repository integration lease. Codex reevaluates task relationships during every selection.

Every execution persists the model selected when it starts. Capacity failures preserve the current attempt, stage, and conversation while the recovery timer performs three exponential-backoff retries before opening the primary circuit and routing to the configured fallback model. Route health follows later task stages and project-planning revisions. After a five-minute cooldown, the next natural turn probes the primary model without interrupting active fallback work. A failed probe immediately reopens the circuit and restores the fallback failure budget; a probe that stays healthy for five minutes closes the circuit and clears its failures. Scheduled retries count against the owning project's concurrency budget and resume after a paused project is continued.

Task recovery reattaches the persisted conversation and starts a new turn in the current attempt, action, and model route. Successful recovery is auditable through task activities; an unavailable persisted conversation produces an explicit blocked recovery result.

Scheduled blockers are persisted task-execution waits. They keep the action, attempt, conversation, model route, absolute deadline, reason, and AI resume checkpoint while releasing project capacity and the repository integration lease. Every reportable turn has a server-generated `reportOpportunityId`; a resumed turn rotates that identity within the same attempt, while `submittedActivityId` continues to point at the current recorded decision. Reports and immutable report activities carry the opportunity identity so retries remain idempotent without allowing an earlier turn to occupy the resumed turn. `WorkflowEngine` owns due, early, rescheduled, paused, cancelled, duplicate-wakeup, and report-opportunity decisions; `RecoveryManager` only maintains exact deadline wakeups and startup/reconnect compensation.

The HTTP surface has four read boundaries: board projection, product detail, runtime settings, and Skill context. Writes use the unified `/api/commands` endpoint. State transitions belong to `WorkflowEngine`, and validated runtime configuration belongs to `SystemSettingsService`, not route handlers.

Keep Git worktree creation, coding, review, conflict resolution, commits, merges, and cleanup inside Codex task instructions. Codrive persists state and dispatches conversations; it does not implement those Git workflows.

## Commands

```text
pnpm test
pnpm typecheck
pnpm build
pnpm dev
```

Use Node.js 24 for development and runtime. Keep the published package, CI, documentation, CLI diagnostics, and bundled Skills aligned with this baseline.
