# Documentation log

## 2026-09-16

- Replaced the default patch release rule with change-based version selection: new product capabilities require minor, while fixes and maintenance use patch; assess the complete unpublished change set.

- Fixed the global settings return link so the page renders independently of project details, with an executed-client navigation regression test.
- Kept milestone filter cards compact when summaries are long and constrained their width to the available space on narrow screens.

- Reconciled reviewed business-map candidates for milestone ownership and continuous planning, preserving discovery reassessment, affected-work restrictions, and evidence-based acceptance.
- Added the source-verified model-settings capability, including complete project overrides, route-specific reasoning effort, and next-turn application.

- Kept all task states visible in the task board, limited homepage filters to active milestone cards, and added an inline detail action plus filter reset.
- Documented manual cancellation for idle tasks, serialized execution checks, and retained-conversation activity checks before cancellation.

## 2026-09-15

- Separated current tasks from milestone history in the project workspace, reused the task detail panel for goals, and kept project facts and settings on their own page. Preserved terminal tasks, archived project history, and workspace location across reloads and project-information navigation.

- Separated current product facts from milestone goals and task plans; ordinary work additions no longer require editing `PROJECT.md`.
- Documented initial assessment, non-terminal discoveries, evidence-driven plans, task-specific restrictions, continued assessment while awaiting decisions, and verified milestone completion.
- Unified visible persistent planning conversations with task conversations and recorded the startup-before-runtime v5 migration boundary.
- Updated the four managed Skills and their planning reference without introducing another Skill or separate discovery/hold lifecycle.

## 2026-09-07

- Updated the bundled Codex CLI to 0.153.4 so its live model catalog includes
  `gpt-6-astra` and exposes supported/default reasoning efforts.
- Added independent primary and fallback reasoning choices to global Settings
  and project detail, with model-specific validation and inherited configuration.
- Persisted configured effort in execution routing and applied it on task,
  planning, retry, fallback, and resumed turns. Model-default choices explicitly
  clear prior conversation effort overrides on the next turn.

## 2026-09-03

- Made `$codrive-task` select and load other available Skills only after reading
  the authoritative task definition, acceptance criteria, current stage,
  complete activity history, and repository rules.
- Kept short task-reference messages and explicit lifecycle guidance such as
  independent `$code-review`, while ordinary tasks without another matching
  Skill continue through the existing workflow.

## 2026-09-02

- Named new and resumed independent Review conversations
  `[review] <task title>` so they remain distinguishable from each task's Work
  conversation, including tasks created before this behavior.
- Queried App Server once at Codrive startup and retained the enabled
  `code-review` result as an in-memory process-lifetime capability snapshot.
- Loaded `$code-review` for initial, resumed, and scheduled Review turns from
  that snapshot, preserved ordinary Review when startup detection is absent or
  fails, and composed it with existing Semantic Atlas task guidance.

## 2026-09-01

- Added optimistic backlog task-definition updates through the unified command
  boundary, including optional atomic `PROJECT.md` acceptance, lifecycle audit,
  stale selection replacement, and managed Skill support.
- Made the enabled integration load `$semantic-atlas` for every ordinary task
  turn while leaving business applicability and no-op decisions inside the Skill.
- Resolved each code-backed Work delivery from its worktree to one persistent
  Git repository and carried that identity through Review and Integration.
- Scoped post-integration checks and open maintenance-task reuse by repository,
  including independent child repositories inside one registered product.
- Kept the Agent report contract single-repository and unchanged; no historical
  candidate compensation or multi-repository delivery payload was added.

## 2026-08-31

- Added the opt-in Semantic Atlas integration card with installed/uninstalled
  detection and one global automatic-maintenance toggle.
- Added durable post-integration check requests, one boolean Semantic Atlas
  status read, one open ordinary maintenance task per project, and startup
  recovery from persisted Integration activities.
- Kept business interpretation and candidate completion inside Semantic Atlas;
  Codrive continues to own only orchestration, review, integration, and recovery.
- Made normal runtime consume persisted Integration events directly instead of
  polling all projects. A maintenance task's own Integration event checks for
  remaining work through the same flow.
- Bound Integration consumption to the persisted `task.completed` transition
  while retaining the immutable Integration activity as the request identity,
  so a completing maintenance task cannot suppress its own follow-up check and
  interrupted tasks remain recoverable.
- Standardized every managed Skill write payload on one explicit `--json` argument, added successful-command envelopes, and made task reports return their persisted activity receipt.

## 2026-08-26

- Defined `PROJECT.md` as the only current product-facts source.
- Added local-file change notification, optimistic concurrency, planning invalidation, and lifecycle audit.
- Established state schema v3 as the only startup contract and removed prior context, state conversion, report identity, update API, and managed-resource upgrade fallbacks.
- Restored a bounded, backed-up schema-v2 to schema-v3 startup upgrade after the strict v3 release prevented existing installations from starting.
- Kept historical cancelled tasks readable when their older state predates structured cancellation metadata.
- Removed historical product notes and project execution diagnostics from product detail.
