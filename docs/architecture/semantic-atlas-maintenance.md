# Semantic Atlas Automatic Maintenance

This page defines how Codrive schedules Semantic Atlas business-map maintenance
without owning business interpretation or introducing a parallel task lifecycle.

## Product Boundary

Semantic Atlas owns candidate discovery, business-domain identity, exact
candidate sources, maintenance classifications, and whether a source remains
actionable. Codrive owns the global user toggle, durable post-integration check
requests, ordinary task creation, scheduling, independent review, integration,
and recovery.

The settings page reports only whether the public `semantic-atlas` command is
installed. An installed command exposes the global automatic-maintenance
toggle. An unavailable command exposes the public project link. Codrive does not
install, upgrade, version-gate, or diagnose Semantic Atlas.

## Runtime Flow

```text
ordinary task completes Integration
  -> durable check request keyed by integration activity
  -> semantic-atlas reconcile candidates --repo
  -> no actionable domains: complete the request
  -> actionable domains: ensure one open task per project + business domain
  -> normal work -> independent review -> integration -> done
  -> rescan requests that waited for the maintenance task
```

`SemanticAtlasMaintenanceCoordinator` derives check requests from completed
ordinary tasks and their immutable `integration_completed` activities. It
stores requests and handled activity IDs in
`semantic-atlas-maintenance.json`. Startup and a low-frequency timer recover
missed events and retry failed CLI or storage work. Enabling the integration
records an activation time so historical integrations do not become an
unexpected backlog.

Each request waits while its maintenance tasks are non-terminal. When they
finish, Codrive queries Semantic Atlas again. This preserves an ordinary
integration that arrived while maintenance was already running: the existing
domain task is reused, then the retained request rescans and creates another
task only when Semantic Atlas still reports actionable candidates.

## Task Identity And Lifecycle

A generated task carries `origin.kind = semantic_atlas_maintenance` and one
`businessDomainId`. `WorkflowEngine` atomically reuses the current open task for
the same project and domain or creates the missing backlog tasks as one batch.
One candidate report advances project planning once even when it contains
several domains. Different projects and domains can proceed independently.

The task remains a normal Codrive task. Its description explicitly activates
`$semantic-atlas-maintenance`; Work prepares a YAML candidate or evidence-only
classification, Review remains independent, and Integration records the
Semantic Atlas maintenance observation. No-change results still pass through
Review and Integration. Existing statuses, retry, recovery, capacity, and Git
integration leases remain authoritative.

A generated maintenance task never creates a new post-integration request from
its own completion. This origin check prevents the automatic loop without
adding a hidden task state or board column.

## Failure Semantics

- A missing CLI pauses automatic checks and leaves existing Codrive tasks
  and the persisted user toggle unchanged.
- Candidate command, task creation, or state persistence failures retain the
  request for retry and reach the Codrive log.
- Saving the user setting succeeds independently of an immediate background
  wake-up; the timer and next startup retry the work.
- Creating a task before request-state persistence is recoverable because the
  project-and-domain task key is idempotent.
- Disabling the integration stops new processing without cancelling already
  visible maintenance tasks.
