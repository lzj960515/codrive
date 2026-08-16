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

A project event publishes only to its project room. A task event publishes both `project:changed` to the owning project room and `task:changed` to that task's room. System version and update status signals publish only to the `system` room. Payloads identify the affected scope; they do not contain project, task, or system state.

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
