# Documentation log

## 2026-09-01

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
