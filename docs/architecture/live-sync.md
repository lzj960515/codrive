# Live Sync Architecture

Codrive keeps HTTP as the authoritative state boundary and uses one WebSocket connection only to announce which projection changed. Commands continue to use `POST /api/commands`; the live channel never carries command requests or responses.

## Protocol

The browser connects to `GET /api/live` with the same local access token used by HTTP. Missing or invalid tokens are rejected before the WebSocket upgrade.

Every message uses schema version `1` and contains:

| Field | Meaning |
| --- | --- |
| `schemaVersion` | Stable envelope version. |
| `sequence` | Positive, monotonic sequence local to one connection. A new connection starts at `1`. |
| `type` | `live.connected`, `project.changed`, `task.changed`, `settings.changed`, `system.changed`, or the reserved `presence.changed`. |
| `scope` | `connection`, `project`, `task`, `settings`, or `system`. |
| `projectId` | Required for project and task scopes. |
| `taskId` | Required for task scope. |

`ProjectStore` events containing a task ID become `task.changed`; other store events become `project.changed`. Runtime settings writes become `settings.changed`; version checks and accepted system update commands become `system.changed`. Upgrade service restarts are recovered by the same reconnect resynchronization. Execution Presence can later use the existing task-scoped `presence.changed` event without creating another transport.

## Client refresh boundaries

| Event scope | Authoritative reads and UI work |
| --- | --- |
| `task` | Refresh the board projection, the matching product detail when open, and only the matching open task detail. |
| `project` | Refresh the board projection and the matching open product detail. |
| `settings` | Refresh runtime settings only when the settings page is open. |
| `system` | Refresh the system/update projection only. |

Initial load reads the board, current route projection, and system status over HTTP. The first `live.connected` baseline repeats that route-scoped read once, closing the gap between bootstrap and subscription; the browser then applies WebSocket events serially. A sequence gap, unsupported message, or successful reconnect triggers the same HTTP resynchronization and establishes a new connection baseline.

Before a scoped render, the client records dirty form values, active-field selection, and marked scroll containers. It restores that transient UI state after replacing authoritative data, so task selection, the detail drawer, update dialog, focus, unfinished input, and scroll positions survive normal events and reconnects.

## Connection lifecycle

Each WebSocket connection owns its own sequence and subscriptions to `ProjectStore` and system update events. Closing or failing the socket releases those subscriptions immediately. Clients reconnect with delays capped at ten seconds, distinguish ordinary reconnects from an active Codrive upgrade restart, and show protocol failures separately.

The server does not replay live events. HTTP snapshots are the recovery source after a gap or reconnect, which keeps persistence and compatibility in the existing authoritative boundaries instead of introducing a second state store inside the WebSocket layer.
