# Product facts lifecycle

This page defines how Codrive keeps one current product truth while preserving historical decisions for audit. It applies to project registration, product-document edits, Skill context, planning revisions, and persisted-state recovery.

## Ownership

`PROJECT.md` is the only current product-facts document read by project selection and task work. `Project.productFacts` records the accepted document revision, SHA-256 digest, synchronization status, and change time. Decision summaries belong to append-only lifecycle events and are not copied into Agent context.

The product document has three observable states:

| Status | Meaning | Scheduling behavior |
| --- | --- | --- |
| `current` | The file digest matches the accepted revision. | Project selection may run. |
| `modified` | The live file differs from the accepted digest. This is computed at the HTTP read boundary. | The editor records the local change before further selection. |
| `reconciliation_required` | Codrive found legacy notes, an empty file, or an unrecorded change during startup. | New project selection remains stopped until one explicit reconciliation. |

Task activities and product lifecycle events remain historical evidence. Agents use them to understand execution and audit decisions, while current product behavior comes from `PROJECT.md`.

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
2. stores the decision summary in `project.product_document_updated` or `project.product_facts_reconciled`;
3. interrupts an active task-selection execution and records it as superseded;
4. advances the project planning revision; and
5. reconciles scheduling from the new facts.

`project.add_work` uses the same document-change metadata and adds the confirmed tasks inside one serialized workflow operation. The document and new tasks therefore create one planning revision and one replacement selection.

## Registration and recovery

Registration is the only operation that carries a complete `productDocument`, because the project has no Codrive-owned `PROJECT.md` yet. Codrive writes the initial file and creates product-facts revision 1.

State schema v3 converts legacy `contextNotes` into append-only audit data without merging them into `PROJECT.md`. A project with any legacy notes enters `reconciliation_required`, and an active selection is marked interrupted. The user or Agent resolves conflicts in the file and sends the normal lightweight notification; confirming unchanged file content is valid for this one reconciliation.

Startup also compares every accepted digest with its local file. A changed or empty document enters `reconciliation_required` before recovery can restart project selection. Existing task history and execution state remain available so task conversations can request the required product decision through their normal report lifecycle.
