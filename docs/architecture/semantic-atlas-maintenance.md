# Semantic Atlas Automatic Maintenance

This page defines how Codrive schedules Semantic Atlas business-map maintenance
without owning business interpretation or introducing a parallel task lifecycle.

## Product Boundary

Semantic Atlas owns task and maintenance observations, candidate grouping,
business-domain identity, completion semantics, and the decision that at least
one candidate is currently actionable. Codrive owns the global user toggle,
durable Integration-event consumption, ordinary task creation, scheduling,
independent review, integration, and recovery.

The settings page reports only whether the public `semantic-atlas` command is
installed. An installed command exposes the global automatic-maintenance
toggle. An unavailable command exposes the public project link. Codrive does not
install, upgrade, version-gate, or diagnose Semantic Atlas.

## Runtime Flow

```text
task records a persisted integration_completed activity
  -> ProjectStore publishes the same event to in-process subscribers
  -> retain one check request keyed by the Integration activity
  -> current project already has open maintenance: complete the request
  -> semantic-atlas reconcile status --repo
  -> required: false: complete the request
  -> required: true: ensure one open maintenance task for the project
  -> normal work -> independent review -> integration -> done
  -> the maintenance task's integration_completed event follows the same path
```

`SemanticAtlasMaintenanceCoordinator` subscribes directly to `ProjectStore`.
Socket.IO is a separate projection of those Store events for the browser; the
coordinator does not connect back through the socket. Normal runtime performs no
maintenance polling and does not scan unrelated projects after an Integration.

The activity is already durable before subscribers run. The coordinator also
stores pending requests and handled activity IDs in
`semantic-atlas-maintenance.json`. It subscribes before startup recovery, then
runs one pass over persisted Integration activities after `enabledAt`. The same
one-pass recovery runs when the setting changes. Event IDs make a live event and
its recovered copy idempotent; there is no periodic recovery loop.

## Task Identity And Lifecycle

A generated task carries only `origin.kind = semantic_atlas_maintenance`.
`WorkflowEngine` atomically reuses the project's current open maintenance task
or creates one backlog task. Codrive neither receives nor persists a candidate
list or business-domain identity.

The task remains a normal Codrive task. Its description explicitly activates
`$semantic-atlas-maintenance`; Work selects one business domain and prepares a
YAML candidate or evidence-only classification, Review remains independent, and
Integration records the Semantic Atlas maintenance observation. No-change
results still pass through Review and Integration. Existing statuses, retry,
recovery, capacity, and Git integration leases remain authoritative.

A maintenance task's own Integration completion is intentionally consumed. If
Semantic Atlas reports no remaining actionable candidate, the event ends. If
work remains, the completed task is terminal and `WorkflowEngine` can create the
next normal maintenance task. This uses one event model instead of a special
self-loop exclusion or retained waiting-task protocol.

## Failure And Shutdown Semantics

- A missing CLI leaves the user toggle and pending requests unchanged.
- Status-command, task-creation, or state-persistence failures reach the Codrive
  log. The durable Integration event or retained request is retried by startup,
  setting-change recovery, or a later event for that project.
- Creating a task before request-state persistence is recoverable because
  `WorkflowEngine` returns the project's existing open maintenance task.
- Disabling the integration stops request processing without cancelling already
  visible maintenance tasks.
- Shutdown first removes the Store subscription and then waits for the accepted
  internal event queue. The server releases its instance lock only after that
  queue has settled, so an old process cannot continue maintenance work beside
  its replacement.
