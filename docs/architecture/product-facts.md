# Product facts lifecycle

This page defines how Codrive keeps one current product truth while preserving historical decisions for audit. It applies to project registration, product-document edits, Skill context, planning revisions, and persisted-state recovery.

## Ownership

`PROJECT.md` is the only current product-facts document read by project selection, milestone assessment, and task work. `Project.productFacts` records the accepted document revision, SHA-256 digest, and change time. Decision summaries belong to append-only lifecycle events and are not copied into Agent context.

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

`project.add_work` requires a top-level `decisionSummary` and tasks; `productDocumentChange` is optional. Ordinary additions verify that the accepted document is current and leave its content, digest, and product revision unchanged. A real product change carries `expectedRevision`, `expectedDigest`, and `documentDigest` inside `productDocumentChange`, with the single decision summary at the top level. Document acceptance and task addition then create one planning revision in one serialized workflow operation. The current API does not normalize old nested summaries or infer document changes from task additions.

Milestone goals and task plans are separate current facts, provided alongside the product contract in context. Discovery and assessment activities provide evidence and disposition, not a second product document. See [Milestones and continuous planning](./milestones.md).

## Task definition changes

新登记的普通任务先在项目仓库的 `docs/tasks/` 写好非空文档，再登记标题和相对仓库根目录的 `taskDocumentPath`。每轮规划、工作、审查和恢复均从原路径读取当前内容；直接编辑文件即可调整后续回合使用的任务正文，不保存正文快照。没有该路径的历史任务继续使用 `description` 和 `acceptanceCriteria`。自动生成的业务地图维护任务由内部流程创建并继续使用其内部定义。

普通未开始任务处于 `backlog`、尚无请求动作和执行记录时，可以用 `task.update_definition` 调整标题、里程碑归属或文档路径；历史任务还可以修改原描述和验收条件，首次设置文档路径后转为文档模式。命令携带当前 `updatedAt` 和决定摘要。Codrive 拒绝过期版本、无变化更新、系统生成的任务、已归档或取消的项目，以及已开始的任务。已有路径的正文直接编辑原文件，不经过定义修改命令。

A task-only clarification requires the accepted `PROJECT.md` digest to remain current. When a task revision also changes product facts, the Agent edits `PROJECT.md` first and includes the prior product revision and digest in the same task update. The bundled CLI computes the new document digest. `WorkflowEngine` then accepts both changes in one serialized operation, records `task.definition_updated` and the product decision, supersedes active task selection, advances planning once with `task_definition_updated`, and reconciles scheduling.

任务 JSON 保存登记信息与运行状态，是内部持久化格式；Agent 使用定义修改命令调整未开始任务的登记信息。已开始任务的路径和归属保持稳定，任务文档仍可按已确认目标编辑，后续回合读取当前内容。需要改变业务结果时，按任务生命周期判断是继续当前对话还是安排后续任务，保留已完成与已取消任务的历史。

## Registration and recovery

Registration is the only operation that carries a complete `productDocument`, because the project has no Codrive-owned `PROJECT.md` yet. Codrive writes the initial file and creates product-facts revision 1.

State schema v5 is the current persisted contract. It adds milestone snapshots and typed activities, optional task membership, and persistent planning conversations while retaining task delivery bindings. It keeps board-visible task status, the next `work | review | integrate` action, and execution runtime state as separate layers. Every review and integration execution is bound to the exact `work_completed` activity it evaluates, while an optional Git candidate remains evidence on that immutable activity instead of task state.

Before normal service startup, Codrive holds the state lock, backs up older supported state, converts snapshots and embedded recovery events, and validates the converted tree before switching the schema marker. The upgrade chain converts published v2/v3 state through its existing migrations and then v4 to v5. Existing tasks keep their identity, lifecycle, conversations, and exact work-activity bindings; milestone membership is not guessed. Prior temporary selection executions are closed as interrupted, their stale result is cleared, and planning is made pending for a visible persistent conversation.

App Server and Recovery start only after state conversion and current managed-resource validation. Normal runtime consumes only v5; legacy API or data-shape branches are confined to migration rather than normal reads. Failed validation preserves the backup and keeps normal service execution stopped. Restoring an old binary requires stopping the service and restoring the matching complete backup.

Startup compares every accepted digest with its local file. A changed or empty document is exposed as `modified`; any active project-selection execution is marked interrupted before recovery. The editor must make the file non-empty and send the normal lightweight notification. Notifications for unchanged content are rejected.
