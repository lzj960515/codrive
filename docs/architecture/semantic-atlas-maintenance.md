# Semantic Atlas Automatic Maintenance

This page defines how Codrive schedules Semantic Atlas business-map maintenance
without owning business interpretation or introducing a parallel task lifecycle.

## Product Boundary

Semantic Atlas owns task and maintenance observations, candidate grouping,
business-domain identity, completion semantics, and the decision that at least
one candidate is currently actionable. Codrive owns the global user toggle,
durable Integration-event consumption, ordinary task creation, scheduling,
independent review, integration, and recovery.

When the toggle is enabled, Codrive explicitly loads `$semantic-atlas` beside
`$codrive-task` for every ordinary task turn. This guarantees that the Agent
has the business-understanding workflow in context; it does not make Codrive a
business classifier. The Semantic Atlas Skill reads the task and decides
whether to query, validate, or record business understanding. Purely mechanical
work reaches the Skill's normal no-op result without a map query or observation.
Dedicated maintenance task turns explicitly load `$semantic-atlas-maintenance`
instead of the ordinary Skill.

The settings page reports only whether the public `semantic-atlas` command is
installed. An installed command exposes the global automatic-maintenance
toggle. An unavailable command exposes the public project link. Codrive does not
install, upgrade, version-gate, or diagnose Semantic Atlas.

## Runtime Flow

```text
code-backed Work reports one workspacePath
  -> git rev-parse resolves its persistent repository root
  -> Work, Review, and Integration activities retain that repository identity
  -> task records a persisted integration_completed activity
  -> task reaches done and ProjectStore publishes task.completed
  -> resolve the exact persisted Integration activity
  -> retain one repository-scoped check request keyed by the Integration activity
  -> that repository already has open maintenance: complete the request
  -> semantic-atlas reconcile status --repo <repository>
  -> required: false: complete the request
  -> required: true: ensure one open maintenance task for the repository
  -> normal work -> independent review -> integration -> done
  -> the maintenance task's completed Integration follows the same path
```

`SemanticAtlasMaintenanceCoordinator` subscribes directly to `ProjectStore`.
Socket.IO is a separate projection of those Store events for the browser; the
coordinator does not connect back through the socket. Normal runtime performs no
maintenance polling and does not scan unrelated projects after an Integration.

`GitRepositoryPathResolver` runs while the reported worktree still exists and
uses Git's common directory to identify the persistent repository rather than
the registered product root. This supports a registered product whose task is
delivered from one independent child repository. The internal repository path
is activity evidence, not a new Agent report field. One Work result represents
one repository; a single task report cannot deliver several repositories.

The Integration activity is durable before the task reaches `done`. The
coordinator waits for the persisted `task.completed` state event before
consuming that activity, so the completing maintenance task cannot block its
own follow-up check as an open task. The coordinator also stores pending
requests and handled activity IDs in
`semantic-atlas-maintenance.json`. It subscribes before startup recovery, then
runs one pass over persisted Integration activities whose source tasks are
already `done` and whose activity occurred after `enabledAt`. The same one-pass
recovery runs when the setting changes. Activity IDs make a live completion and
its recovered copy idempotent; there is no periodic recovery loop. An activity
persisted before an interrupted task reaches `done` remains deferred until task
recovery publishes the normal completion event.

## Task Identity And Lifecycle

A generated task carries `origin.kind = semantic_atlas_maintenance` and its
single `origin.repositoryPath`. `WorkflowEngine` atomically reuses the current
open maintenance task for that repository or creates one backlog task. Open
maintenance for another child repository does not suppress it. Codrive neither
receives nor persists a candidate list or business-domain identity.

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
