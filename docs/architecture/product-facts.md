# Product facts lifecycle

This page defines how Codrive keeps one current product truth while preserving historical decisions for audit. It applies to project registration, product-document edits, Skill context, planning revisions, and persisted-state recovery.

## Ownership

`PROJECT.md` is the only current product-facts document read by project selection and task work. `Project.productFacts` records the accepted document revision, SHA-256 digest, and change time. Decision summaries belong to append-only lifecycle events and are not copied into Agent context.

The product document has two observable states:

| Status | Meaning | Scheduling behavior |
| --- | --- | --- |
| `current` | The file digest matches the accepted revision. | Project selection may run. |
| `modified` | The live file differs from the accepted digest. This is computed at the HTTP read boundary. | The editor records the local change before further selection. |

Task activities remain in task context as execution history. Product lifecycle events are audit-only and are not returned by project or task context. Current product behavior comes from `PROJECT.md`.

## Local-file change contract

An Agent reads project context before editing and retains `productFacts.revision` plus `productFacts.acceptedDigest`. It edits `projectDocument` with ordinary filesystem tools, then sends only:

```json
{
  "decisionSummary": "Describe the confirmed product change",
  "expectedRevision": 3,
  "expectedDigest": "sha256:<accepted digest before editing>",
  "documentDigest": "sha256:<digest of the edited local file>"
}
```

The bundled CLI computes `documentDigest`; the Agent does not transmit the document body. `WorkflowEngine` serializes the command, rereads `PROJECT.md`, requires non-empty content, verifies the accepted revision and digest, and verifies the current file digest. A stale revision or mismatched digest returns a conflict without overwriting the file.

After validation, Codrive:

1. marks the edited document as the next accepted product-facts revision;
2. stores the decision summary in `project.product_document_updated`;
3. interrupts an active task-selection execution and records it as superseded;
4. advances the project planning revision; and
5. reconciles scheduling from the new facts.

`project.add_work` uses the same document-change metadata and adds the confirmed tasks inside one serialized workflow operation. The document and new tasks therefore create one planning revision and one replacement selection.

## Task definition changes

An ordinary task remains editable while it is an unstarted `backlog` task with no requested action or execution. The update command carries the task's current `updatedAt`, one decision summary, and a partial replacement of `title`, `description`, or `acceptanceCriteria`. Codrive rejects stale versions, no-op changes, system-generated tasks, archived or cancelled projects, and tasks whose lifecycle has already started.

A task-only clarification requires the accepted `PROJECT.md` digest to remain current. When a task revision also changes product facts, the Agent edits `PROJECT.md` first and includes the prior product revision and digest in the same task update. The bundled CLI computes the new document digest. `WorkflowEngine` then accepts both changes in one serialized operation, records `task.definition_updated` and the product decision, supersedes active task selection, advances planning once with `task_definition_updated`, and reconciles scheduling.

Task snapshot JSON combines the current definition with lifecycle and execution state, so it remains an internal persistence format. Agents use `task.update_definition` instead of writing that file. Started work keeps the definition evaluated by its current execution; later scope changes use that lifecycle or a follow-up task, preserving completed and cancelled task history.

## Registration and recovery

Registration is the only operation that carries a complete `productDocument`, because the project has no Codrive-owned `PROJECT.md` yet. Codrive writes the initial file and creates product-facts revision 1.

State schema v4 is the current persisted contract. It keeps board-visible task status, the next `work | review | integrate` action, and execution runtime state as separate layers. Every review and integration execution is bound to the exact `work_completed` activity it evaluates, while an optional Git candidate remains evidence on that immutable activity instead of task state.

A schema-v3 installation upgrades only through the offline migration command while the service is stopped. Codrive first creates a durable `backups/state-v3` copy, converts task snapshots and append-only events in an isolated projects tree, reconstructs each open review or integration binding from chronological work activities, validates identities and lifecycle values, and then replaces the projects tree and v4 marker together. A binding that cannot be reconstructed fails closed and leaves v3 authoritative. A schema-v2 installation first performs the existing v2-to-v3 migration and then the v3-to-v4 migration. Ordinary startup creates v4 only for an empty state directory; otherwise it requires a current v4 marker plus exact-version managed Skill and Hook markers before App Server or Recovery starts. Pending migration, unversioned state, unsupported schema versions, and incomplete managed resources all fail startup without recovery.

Startup compares every accepted digest with its local file. A changed or empty document is exposed as `modified`; any active project-selection execution is marked interrupted before recovery. The editor must make the file non-empty and send the normal lightweight notification. Notifications for unchanged content are rejected.
