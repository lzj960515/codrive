# Codrive Agent Guide

Codrive is a local, single-user orchestration service that connects filesystem-backed product state, Codex App Server conversations, and reusable Skills.

## Architecture

- `src/domain` owns project, task, execution, report, and event contracts.
- `src/application` owns deterministic workflow decisions and dispatch coordination.
- `ProjectExecutionCoordinator` owns temporary task-selection turns.
- `model-routing.ts` owns capacity-failure classification, persisted retry state, exponential backoff, and fallback routing for every Codex turn.
- `PackageVersionCheckScheduler` owns startup compensation, the persisted hourly npm check cadence, and live board status events; `PackageVersionService` owns npm access, validation, caching, and in-flight deduplication.
- `SystemSettingsService` owns validated runtime concurrency plus global and project model configuration changes.
- `SemanticAtlasMaintenanceCoordinator` consumes persisted Integration events,
  asks Semantic Atlas only whether the current project requires maintenance,
  and ensures one open ordinary maintenance task per project. Semantic Atlas
  owns all candidate, business-domain, and completion interpretation.
- `src/infrastructure` owns filesystem persistence, App Server transport, and managed Skill/Hook installation.
- `src/interfaces` owns the HTTP API, authenticated Socket.IO board transport, CLI, and local board.
- `skills` contains the product's installable Codex Skills.

Project-level Codex turns decide which backlog tasks should start from current product and repository facts. Codrive validates IDs, task availability, each project's concurrency budget, and the repository integration lease. Codex reevaluates task relationships during every selection.

Task lifecycle has three layers. `Task.status` is the board-visible business state, `Task.requestedAction` selects `work | review | integrate`, and `TaskExecution.status` records attempt runtime such as running, waiting, retrying, or completed. Every work result enters independent Review. A `work_completed` activity owns its optional `candidateCommit`; the task and the following Review/integration executions bind that exact activity by ID. Integration then decides whether the whole task is `completed`, needs another `work` round through `work_required`, or produced a new candidate through `needs_review`. A work result without a candidate represents reviewable release, migration, or verification evidence and never triggers Git integration.

`PROJECT.md` is the only current product-facts source for project selection and task turns. `Project.productFacts` stores the accepted file revision and digest; decision summaries stay in append-only lifecycle events. Agents edit the local file with normal filesystem tools, then send a lightweight change notification carrying the prior revision/digest and the edited-file digest. `WorkflowEngine` validates the file, supersedes stale project selection, advances planning, and reconciles scheduling. State schema v4 is the current persisted contract. The stopped-service migration creates a durable v3 backup, rewrites snapshots and `events.ndjson` in a temporary tree, reconstructs exact work-activity bindings, validates identities and counts, then replaces projects and writes the v4 marker. Published schema-v2 state first performs its existing v3 upgrade and then the same v4 migration. Ordinary startup never performs that migration: it initializes only empty state and otherwise requires current v4 state plus exact-version managed resource markers before App Server or Recovery starts. See [Product facts lifecycle](./docs/architecture/product-facts.md).

Project archive is independent persisted visibility information, not a `ProjectStatus`. Archiving rejects every project or task execution that is active, retrying, awaiting a report, waiting for input, or waiting for a scheduled resume; one serialized transition records the archive time and pauses scheduling. Restoring removes the archive time but keeps scheduling paused. `projectCanSchedule` is the shared eligibility boundary for planning, task dispatch, retries, planned waits, and recovery. The Store retains archived projects and all of their files, lifecycle events, activities, execution evidence, and thread references.

Every execution persists the model selected when it starts. An optional `Project.modelConfig` overrides the global primary and fallback models for that project's planning and task turns; without it, the project inherits the current global models. Configuration changes leave the active turn unchanged and align routing when the next turn starts. Capacity failures preserve the current attempt, stage, and conversation while the recovery timer performs three exponential-backoff retries before opening the primary circuit and routing to the effective fallback model. Route health follows later task stages and project-planning revisions. After a five-minute cooldown, the next natural turn probes the effective primary model without interrupting active fallback work. A failed probe immediately reopens the circuit and restores the fallback failure budget; a probe that stays healthy for five minutes closes the circuit and clears its failures. Scheduled retries count against the owning project's concurrency budget and resume after a paused project is continued.

Task recovery reattaches the persisted conversation and starts a new turn in the current attempt, action, and model route. Successful recovery is auditable through task activities; an unavailable persisted conversation produces an explicit blocked recovery result.

`ExecutionActivityBridge` accepts live activity only from the managed Hook endpoint and keeps the latest safe activity plus the exact execution's Hook `lastSeen` only in process memory. Opening task detail reads only that latest Hook activity; without one, the UI waits for the next signal. Startup creates a fresh observation window. After ten minutes without a valid Hook request, `RecoveryManager` reads the exact thread and turn snapshot: `inProgress` resets the window, `completed` uses the normal completion path, and a coherent `interrupted` or `failed` turn reaches the serialized recovery entry point. An unloaded persisted thread remains coherent when the exact turn is terminal and no turn is active. Missing, unreadable, contradictory, superseded, paused, or capacity-blocked work remains unchanged for a later check, while Presence stays an in-memory concern.

The detached upgrade worker installs the exact package, stops the old Codrive service and its App Server, runs the new package's state migration, synchronizes all managed Skills and Hooks while the service remains stopped, starts the v4-only service, and verifies resource status plus the running version before recording success. Every startup rereads the persisted state and managed-resource markers, so a partial or manually bypassed upgrade remains stopped before App Server and Recovery. Later user removal remains an explicit repair action instead of being silently reversed on every restart.

Scheduled blockers are persisted task-execution waits. They keep the action, attempt, conversation, model route, absolute deadline, reason, and AI resume checkpoint while releasing project capacity and the repository integration lease. Every reportable turn has a server-generated `reportOpportunityId`; a resumed turn rotates that identity within the same attempt, while `submittedActivityId` continues to point at the current recorded decision. Reports and immutable report activities carry the opportunity identity so retries remain idempotent without allowing an earlier turn to occupy the resumed turn. Missing or mismatched execution identity is rejected. `WorkflowEngine` owns due, early, rescheduled, paused, cancelled, duplicate-wakeup, and report-opportunity decisions; `RecoveryManager` only maintains exact deadline wakeups and startup/reconnect compensation.

The HTTP surface has five read boundaries: board projection, product detail, project model settings, runtime settings and integrations, and Skill context. The board projection separates the default unarchived list, the explicit archived collection with its count, and a project-scoped snapshot for later refreshes. Writes use the unified `/api/commands` endpoint. State transitions and persisted project configuration belong to `WorkflowEngine`; validated runtime, integration, and project model inputs belong to `SystemSettingsService`, not route handlers.

Semantic Atlas automatic maintenance is a global opt-in. Settings expose only
installed or uninstalled plus the toggle; Codrive does not install, upgrade, or
diagnose that product. Generated maintenance work uses the ordinary task
lifecycle. Its own Integration completion follows the same event path and asks
Semantic Atlas whether another maintenance task is required. See
[Semantic Atlas automatic maintenance](./docs/architecture/semantic-atlas-maintenance.md).

Socket.IO carries scoped invalidation signals, while HTTP remains authoritative for data. `BoardRealtimeGateway` authenticates the handshake, derives `project:<id>`, `task:<id>`, and `system` rooms from validated watch requests, and maps Store or system events to `project:changed`, `task:changed`, and `system:changed`. Archive and restore additionally emit `projects:changed` to authenticated connections so browsers reread only the default and archived project collections. Browser reconnects restore only the current watches and reread only those HTTP scopes.

Keep Git worktree creation, coding, review, conflict resolution, commits, merges, and cleanup inside Codex task instructions. Codrive persists state and dispatches conversations; it does not implement those Git workflows.

## Commands

```text
pnpm test
pnpm typecheck
pnpm build
pnpm dev
```

Use Node.js 24 for development and runtime. Keep the published package, CI, documentation, CLI diagnostics, and bundled Skills aligned with this baseline.
