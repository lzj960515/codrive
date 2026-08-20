# Realtime synchronization

Codrive keeps HTTP authoritative and uses Socket.IO only to tell an open browser which visible scope has changed. This split keeps persisted state, projections, authentication, and command responses in the existing HTTP model while allowing each browser to follow only the project and task it is displaying.

## Runtime model

```text
ProjectStore events ─┐
                     ├─ BoardRealtimeGateway ─ scoped Socket.IO signal ─ browser
System status events ┘                                             │
                                                                  └─ HTTP reread
                                                                      ├─ project snapshot
                                                                      ├─ task detail
                                                                      └─ system status
```

`BoardRealtimeGateway` owns the transport lifecycle. It authenticates each Socket.IO handshake with the same local access token as the HTTP API, validates watch requests against `ProjectStore`, derives room names on the server, and removes its Store and system subscriptions when Fastify closes.

Each connection has at most one project watch and one task watch. A task watch must belong to the watched project. The server handles watch requests in connection order, while the browser's watch coordinator serializes overlapping reconnect and selection changes and finishes on the latest visible scope. Socket.IO owns disconnect cleanup for the connection's rooms.

## Rooms and invalidations

| Browser scope | Server-owned room | Published signal | Authoritative reread |
| --- | --- | --- | --- |
| Selected project | `project:<projectId>` | `project:changed` | `GET /api/board/projects/:projectId` |
| Open task | `task:<taskId>` | `task:changed` | `GET /api/tasks/:taskId` |
| Update status | `system` | `system:changed` | `GET /api/system` |

A projection-changing project event publishes only to its project room. A task event publishes both `project:changed` to the owning project room and `task:changed` to that task's room. Audit-only `command.*`, `recovery.*`, `app_server.*`, and `workflow.*` events remain in the lifecycle log without invalidating an unchanged HTTP projection. System version and update status signals publish only to the `system` room. Payloads identify the affected scope; they do not contain project, task, or system state.

The server accepts only typed `watch:*` and `unwatch:*` requests containing a project ID, task ID, or the empty system request. Clients never submit room names.

## Browser lifecycle

Initial navigation uses HTTP:

1. `/api/board` loads the project list and initial board projections.
2. A product route also reads `/api/projects/:projectId`; settings reads `/api/system/settings`.
3. `/api/system` loads update status.
4. After the initial view is available, the Socket.IO client connects and watches system plus the current project and optional task.

Later changes are scoped:

- Selecting a project leaves the old task and project rooms, joins the new project room, and reads only the new project snapshot.
- Opening, switching, or closing task details changes only the task room and task-detail read.
- A task-two change updates the current project's task list, but it does not read task two while task one is open.
- Product detail routes watch their project but never join a task room.
- Settings and system invalidations do not request board, product, or task data.

Every connect or reconnect restores the current watches and rereads those same HTTP scopes. Request revisions prevent a slower response from an earlier selection from replacing newer state. Background rerenders capture and restore input values, focus, and document, board, sidebar, and task-detail scroll positions.

## Failure behavior

Socket.IO uses its built-in reconnect behavior and preserves connection-local event order. A disconnect shows the existing local-service recovery banner. Missed signals do not require a custom sequence or event log because the reconnect path rereads each visible authoritative HTTP scope.

An absent or incorrect handshake token rejects the Socket.IO connection. Invalid IDs, extra request fields, a task outside the watched project, and unsupported watch payloads receive a failed acknowledgement without joining a room.

## Execution activity and silence recovery

Live activity and liveness share one accepted signal boundary:

```text
Managed Codex Hook ─ POST /api/hooks/activity ─ recordHook()
                                                   ├─ latest safe activity ─ task room
                                                   └─ exact execution lastSeen
                                                                    │ 10 minutes silent
                                                                    v
RecoveryManager minute scan ─ thread/read(includeTurns: true) ─ WorkflowEngine
```

`ExecutionActivityBridge` associates every accepted Hook request with the current project, task, action, attempt, thread, and turn. It keeps the replaceable activity and `lastSeen` only in process memory. `PreToolUse` displays the canonical safe tool name, `PostToolUse` shows that its result is being processed, and `Stop` clears the activity. An identity change starts a new observation, while a terminal or excluded execution removes the old observation. Startup initializes current `pending`, `running`, and `awaiting_report` turns at the startup time, so losing process memory never makes a persisted turn immediately recoverable. Opening a task detail reads only the latest accepted Hook activity and otherwise waits for the next signal; App Server items are not presented as live Activity.

`RecoveryManager` claims each due observation before awaiting App Server, which prevents overlapping scans from checking or recovering the same window twice. A valid Hook request invalidates an outstanding claim. Read failures and uncertain snapshots remain retryable without creating a task activity, execution field, or presence status. Normal App Server lifecycle notifications such as turn completion, thread status changes, and transport disconnection continue through the existing workflow lifecycle; item notifications are not activity heartbeats.

### Authoritative turn decisions

The App Server gateway returns only the thread status, in-progress turn IDs, the exact turn status, and safe item type/status pairs. Prompt text, reasoning, tool arguments, output, paths, and other item content do not cross this boundary.

| Exact snapshot | Decision |
| --- | --- |
| Thread active; saved turn is the only `inProgress` turn | Keep running and begin a new ten-minute window |
| Thread idle or not loaded; exact saved turn is `completed` and no turn is active | Use the existing completion and report path |
| Thread idle or not loaded; exact saved turn is `interrupted` or `failed` and no turn is active | Ask `WorkflowEngine` to recover the same execution |
| Exact turn missing or App Server unreadable | Keep current state and retry later |
| Thread and turn disagree, or another turn is active | Keep current state and retry later |

A persisted thread can be `notLoaded` after an App Server restart or unload even though `thread/read(includeTurns: true)` returns its turns. That status is conclusive only when the exact saved turn is terminal and no turn is active; `active`, `systemError`, missing turns, and any active-turn conflict remain uncertain.

Recovery is serialized by `WorkflowEngine`. Immediately before resuming, it compares the project, task, action, attempt, execution status, thread, and turn, then verifies that the project is active and running, its concurrency limit still covers the execution, and no other task owns the repository integration lease. A failed check leaves the current execution untouched. A successful check reuses the persisted conversation, attempt, action, and model route, starts at most one new turn, and records the existing `execution_recovered` lifecycle activity.

Planned waits, model retry waits, user decisions, blocked or cancelled tasks, terminal executions, and paused projects never enter silence recovery. Stopping the service removes lifecycle, Store, and timer subscriptions; the next service start creates fresh observation windows.
