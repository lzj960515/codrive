# Codrive Agent Guide

Codrive is a local, single-user orchestration service that connects filesystem-backed product state, Codex App Server conversations, and reusable Skills.

## Architecture

- `src/domain` owns project, milestone, task, execution, report, and event contracts.
- `src/application` owns deterministic workflow decisions and dispatch coordination.
- `PlanningCoordinator` owns persistent project selection and milestone assessment turns, sharing one automatic planning slot per project.
- `model-routing.ts` owns capacity-failure classification, persisted retry state, exponential backoff, and fallback routing for every Codex turn.
- `PackageVersionCheckScheduler` owns startup compensation, the persisted hourly npm check cadence, and live board status events; `PackageVersionService` owns npm access, validation, caching, and in-flight deduplication.
- `SystemSettingsService` owns validated runtime concurrency plus global and project model configuration changes.
- `SemanticAtlasMaintenanceCoordinator` consumes a persisted Integration only
  after its source task reaches `done`, asks Semantic Atlas only whether the
  repository recorded by that Work delivery requires maintenance, and ensures
  one open ordinary maintenance task per repository. Semantic Atlas owns all
  candidate, business-domain, and completion interpretation.
- `src/infrastructure` owns filesystem persistence, App Server transport, and managed Skill/Hook installation.
- `src/interfaces` owns the HTTP API, authenticated Socket.IO board transport, CLI, and local board.
- `skills` contains the product's installable Codex Skills.

Project-level Codex turns decide which backlog tasks should start from current product, milestone, and repository facts. Milestone owners assess empty initial goals, new evidence, and final acceptance; discoveries and decisions are typed activities, not independent entities. Unresolved affected-task activities restrict dispatch and recovery while unrelated work continues. All selection, assessment, work, and Review conversations are visible and persistent under the project repository. See [Milestones and continuous planning](./docs/architecture/milestones.md). Codrive validates IDs, task availability, each project's concurrency budget, and the repository integration lease. Codex reevaluates task relationships during every selection.

Task lifecycle has three layers. `Task.status` is the board-visible business state, `Task.requestedAction` selects `work | review | integrate`, and `TaskExecution.status` records attempt runtime such as running, waiting, retrying, or completed. Every work result enters independent Review. A `work_completed` activity owns its optional `candidateCommit`; the task and the following Review/integration executions bind that exact activity by ID. Integration then decides whether the whole task is `completed`, needs another `work` round through `work_required`, or produced a new candidate through `needs_review`. A work result without a candidate represents reviewable release, migration, or verification evidence and never triggers Git integration.

Each task's independent Review uses a persistent `[review] <task title>` conversation. During server startup, Codrive asks App Server once whether an enabled `code-review` Skill is available and retains that boolean in `CodexTaskDispatcher` for the process lifetime. Initial, resumed, and scheduled-resume Review turns explicitly load `$code-review` from that startup snapshot. A missing Skill or failed startup check keeps the ordinary `$codrive-task` Review path; later Skill changes take effect after Codrive restarts.

每轮任务都从 `$codrive-task` 进入。有 `taskDocumentPath` 的任务从项目仓库原路径读取当前文档作为任务正文；没有路径的历史任务读取原描述和验收条件。读取当前阶段、完整活动历史及仓库规则后，再选择适合本阶段工作的其他 Skill。独立审查仍按 `$code-review` 的调度规则执行。

`PROJECT.md` 是任务选择和执行使用的当前产品事实。`Project.productFacts` 保存已接受的文档版本与摘要，决定摘要保存在追加式生命周期事件中。Agent 编辑本地文件后，提交修改前的版本与摘要及修改后的摘要；`WorkflowEngine` 验证文件、撤销过期选择、推进规划并重新调度。新登记的普通任务先在项目仓库写好文档，再登记相对路径；未开始任务可通过 `task.update_definition` 调整标题、归属或文档路径，已有路径的正文直接编辑原文件。没有路径的历史任务沿用原描述和验收条件。任务 JSON 只保存内部登记信息和运行状态。`project.add_work` 要求独立的决定摘要，产品事实可保持不变。当前持久化契约为第五版；启动时先在状态锁内迁移受支持的旧数据，再启动 Codex 服务与恢复流程。迁移保留任务身份和工作成果绑定，将临时规划改为待执行的持续选择。运行时只接受当前数据模型与 API。详见[产品事实生命周期](./docs/architecture/product-facts.md)。

Project archive is independent persisted visibility information, not a `ProjectStatus`. Archiving requires every project, milestone, and task execution to be clear of active, retrying, awaiting-report, waiting-for-input, and scheduled-resume states, and every milestone question to be resolved; one serialized transition records the archive time and pauses scheduling. Restoring removes the archive time but keeps scheduling paused. `projectCanSchedule` is the shared eligibility boundary for planning, task dispatch, retries, planned waits, and recovery. The Store retains archived projects and all of their files, lifecycle events, activities, execution evidence, and thread references.

Every execution persists the model and configured reasoning effort selected when it starts. An optional `Project.modelConfig` overrides the global primary and fallback models and their independent reasoning efforts for that project's planning and task turns; without it, the project inherits the current global models. The model catalog and supported reasoning efforts come from the bundled Codex App Server. Settings validate each effort against its selected model. Omitted efforts use the model catalog default, which is sent explicitly on every turn to clear a previous conversation override. Configuration changes leave the active turn unchanged and align routing when the next turn starts. Capacity failures preserve the current attempt, stage, and conversation while the recovery timer performs three exponential-backoff retries before opening the primary circuit and routing to the effective fallback model. Route health follows later task stages and project-planning revisions. After a five-minute cooldown, the next natural turn probes the effective primary model without interrupting active fallback work. A failed probe immediately reopens the circuit and restores the fallback failure budget; a probe that stays healthy for five minutes closes the circuit and clears its failures. Scheduled retries count against the owning project's concurrency budget and resume after a paused project is continued.

Task recovery reattaches the persisted conversation and starts a new turn in the current attempt, action, and model route. Successful recovery is auditable through task activities; an unavailable persisted conversation produces an explicit blocked recovery result.

`ExecutionActivityBridge` accepts live activity only from the managed Hook endpoint and keeps the latest safe activity plus the exact execution's Hook `lastSeen` only in process memory. Opening task detail reads only that latest Hook activity; without one, the UI waits for the next signal. Startup creates a fresh observation window. After ten minutes without a valid Hook request, `RecoveryManager` reads the exact thread and turn snapshot: `inProgress` resets the window, `completed` uses the normal completion path, and a coherent `interrupted` or `failed` turn reaches the serialized recovery entry point. An unloaded persisted thread remains coherent when the exact turn is terminal and no turn is active. Missing, unreadable, contradictory, superseded, paused, or capacity-blocked work remains unchanged for a later check, while Presence stays an in-memory concern.

The detached upgrade worker installs the exact package, stops the old Codrive service and its App Server, runs the new package's state migration, synchronizes all managed Skills and Hooks while the service remains stopped, starts the current-schema service, and verifies resource status plus the running version before recording success. Every startup rereads the persisted state and managed-resource markers, so a partial or manually bypassed upgrade remains stopped before App Server and Recovery. Later user removal remains an explicit repair action instead of being silently reversed on every restart.

Scheduled blockers are persisted task-execution waits. They keep the action, attempt, conversation, model route, absolute deadline, reason, and AI resume checkpoint while releasing project capacity and the repository integration lease. Every reportable turn has a server-generated `reportOpportunityId`; a resumed turn rotates that identity within the same attempt, while `submittedActivityId` continues to point at the current recorded decision. Reports and immutable report activities carry the opportunity identity so retries remain idempotent without allowing an earlier turn to occupy the resumed turn. Missing or mismatched execution identity is rejected. `WorkflowEngine` owns due, early, rescheduled, paused, cancelled, duplicate-wakeup, and report-opportunity decisions; `RecoveryManager` only maintains exact deadline wakeups and startup/reconnect compensation.

The HTTP surface has five read boundaries: board projection, product detail, project model settings, runtime settings and integrations, and Skill context. The board projection separates the default unarchived list, the explicit archived collection with its count, and a project-scoped snapshot for later refreshes. Writes use the unified `/api/commands` endpoint. State transitions and persisted project configuration belong to `WorkflowEngine`; validated runtime, integration, and project model inputs belong to `SystemSettingsService`, not route handlers.

Semantic Atlas automatic maintenance is a global opt-in. Settings expose only
installed or uninstalled plus the toggle; Codrive does not install, upgrade, or
diagnose that product. When enabled, ordinary task turns explicitly load
`$semantic-atlas`; that Skill alone decides whether the task changes business
behavior and whether to query or record anything. Code-backed Work reports are
resolved from their worktree to one persistent Git repository before the
worktree can be removed. Generated maintenance work uses the ordinary task
lifecycle and stays bound to that repository. Its own Integration completion
follows the same event path and asks Semantic Atlas whether another maintenance
task is required. See
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
