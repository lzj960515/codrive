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

## Registration and recovery

Registration is the only operation that carries a complete `productDocument`, because the project has no Codrive-owned `PROJECT.md` yet. Codrive writes the initial file and creates product-facts revision 1.

State schema v3 is the current state contract for this lifecycle. Codrive creates it for an empty state directory. A published schema-v2 installation upgrades once: Codrive validates every `PROJECT.md`, creates a durable `backups/state-v2` copy, derives the accepted document digest, assigns a report-opportunity identity to any legacy task execution that still lacks one, records migration state, and writes the v3 marker last. The upgrade is safe to retry after interruption. A directory containing projects without a version marker, or carrying any schema other than v2 or v3, fails startup without conversion.

Startup compares every accepted digest with its local file. A changed or empty document is exposed as `modified`; any active project-selection execution is marked interrupted before recovery. The editor must make the file non-empty and send the normal lightweight notification. Notifications for unchanged content are rejected.
