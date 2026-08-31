---
name: codrive-control
description: 查询和控制本地 Codrive 项目、任务与运行设置，包括产品详情、产品文档事实、看板状态、归档、恢复、暂停、取消、重试、重新规划和模型路由。用户询问 Codrive 进度、阻塞原因、产品事实更新、模型容量恢复或要求干预自动流程时使用。
compatibility: Requires Node.js 24+ and a running local Codrive service.
---

# Codrive Control

使用确定性脚本读取或改变 Codrive 状态。执行写操作前复述目标项目或任务和预期影响。

## 查询

```text
node <skill-directory>/scripts/codrive-control.mjs board
node <skill-directory>/scripts/codrive-control.mjs archived
node <skill-directory>/scripts/codrive-control.mjs project <project-id>
node <skill-directory>/scripts/codrive-control.mjs task <task-id>
```

`board` 返回默认看板中的未归档项目；`archived` 返回已归档项目及其数量。`project` 返回注册信息、完整 `PROJECT.md`、产品事实同步状态、最小规划状态、归档时间、任务与当前执行信息。`task` 返回任务定义、当前状态、完整进展记录和推导后的 Codex 对话链接。

项目的 `attention` 只表达需要处理的异常状态：`decision_requested` 表示需要在对应 Codex App 对话中作出决定，`blocked` 表示项目存在确定阻塞。没有 `attention` 时，项目按当前任务和规划状态正常推进。

## 运行设置

```text
node <skill-directory>/scripts/codrive-control.mjs settings
node <skill-directory>/scripts/codrive-control.mjs update-settings --json '{"maxConcurrentTasks":4,"models":{"primary":"<primary-model-id>","fallback":"<fallback-model-id>"}}'
```

`update-settings` 的 `--json` 参数接收完整设置：

```json
{
  "maxConcurrentTasks": 4,
  "models": {
    "primary": "<primary-model-id>",
    "fallback": "<fallback-model-id>"
  }
}
```

并发上限按项目独立计算。模型设置作用于后续创建的执行；已经运行的 turn 保持启动时保存的模型。修改并发会为每个项目创建一个新的规划版本，单独修改模型路由保持现有规划版本。

## 控制项目

动作是 `pause`、`resume`、`retry`、`replan`、`archive`、`unarchive` 或 `cancel`：

```text
node <skill-directory>/scripts/codrive-control.mjs project-control <project-id> <action>
```

暂停和恢复只控制后续调度；已经运行的 turn 可以结束，所以看板可能显示“执行中 · 后续已暂停”。项目级执行失败并保留 `requestedAction` 时，使用 `retry` 在同一规划版本创建新的执行 attempt。确认产品、仓库或外部 Gate 已变化时，使用 `replan` 创建新的规划版本并重新判断 backlog。

归档前先读取项目和任务执行状态。项目或任一任务正在启动、运行、等待重试、等待汇报、等待输入或计划等待时，保留当前项目并报告 Codrive 返回的可操作原因。`archive` 会暂停后续调度并从默认看板隐藏项目，同时保留本地数据、`PROJECT.md`、任务、活动历史、执行证据和 Codex 对话引用。`unarchive` 恢复项目可见性；恢复后仍保持暂停，需要用户明确执行 `resume` 才会重新调度。归档与取消的语义独立，第一版不永久删除项目，也不联动归档 Codex 对话。

## 控制任务

```text
node <skill-directory>/scripts/codrive-control.mjs task-control <task-id> retry
node <skill-directory>/scripts/codrive-control.mjs task-control <task-id> continue
node <skill-directory>/scripts/codrive-control.mjs task-control <task-id> reschedule --json '<schedule-json>'
node <skill-directory>/scripts/codrive-control.mjs task-control <task-id> cancel --json '<decision-json>'
```

模型容量失败会在原 attempt 和原对话中按 5 秒、10 秒、20 秒自动重试三次，然后切换到 fallback 模型继续恢复。Fallback 同样重试三次；全部耗尽后任务才进入 `blocked`。此时任务级 `retry` 创建新的 attempt。`waiting_for_input` 由用户在原开发对话中回复，随后继续同一个 attempt。

`waiting_for_resume` 是计划等待：保留原阶段、attempt、thread、模型路由和 AI 编写的 `resumePrompt` 检查点，同时释放项目容量与 integrate 的仓库资格。`continue` 提前继续同一执行；`reschedule` 通过唯一的 `--json` 参数接收新的未来 RFC 3339 绝对时间：

```json
{
  "resumeAt": "2026-08-13T18:30:00+08:00"
}
```

```text
node <skill-directory>/scripts/codrive-control.mjs task-control <task-id> reschedule --json '{"resumeAt":"2026-08-13T18:30:00+08:00"}'
```

重新安排只改变恢复时间；提前继续和到期恢复都会先重新取得当前项目容量与仓库合入资格，再在原对话启动唯一的新 turn。项目暂停会保留等待，恢复项目后处理已经到期的任务。

## 取消判断

取消是永久终态。先读取目标项目或任务的当前状态、完整进展记录和对话上下文，再判断取消是否依赖用户意图：

- 需要产品取舍、停止范围或现场保留决定时，通过当前任务或项目报告提交 `needs_input`，在 `question` 中写清建议取消的原因和需要用户回答的问题。用户在原 Codex 对话明确答复后，以 `user_confirmed` 执行取消。
- 当前事实已经证明目标重复、已被替代或不再可执行，并且取消不需要新的产品选择或外部授权时，以 `agent_decision` 直接执行取消。

项目和任务的取消命令都通过唯一的 `--json` 参数接收判断依据与取消理由：

```json
{
  "decisionBasis": "<user_confirmed|agent_decision>",
  "reason": "<具体取消理由及其事实或用户决定>"
}
```

```text
node <skill-directory>/scripts/codrive-control.mjs project-control <project-id> cancel --json '{"decisionBasis":"agent_decision","reason":"<具体取消理由>"}'
node <skill-directory>/scripts/codrive-control.mjs task-control <task-id> cancel --json '{"decisionBasis":"agent_decision","reason":"<具体取消理由>"}'
```

`user_confirmed` 的取消理由概括用户同意的范围和原因；`agent_decision` 的取消理由写明支持直接取消的事实。取消命令作为这次处理的最后一个副作用，完成后报告新的终态。

## 更新当前产品事实

`PROJECT.md` 是 Agent 读取的唯一当前产品事实。修改前读取 project context，保存 `productFacts.revision` 和 `productFacts.acceptedDigest`；使用普通文件编辑工具局部修改返回的 `projectDocument`，然后立即发送轻量通知：

```text
node <skill-directory>/scripts/codrive-control.mjs product-document-changed <project-id> --json '{"decisionSummary":"<本次决定>","expectedRevision":3,"expectedDigest":"sha256:<修改前哈希>"}'
```

`--json` 只传文档修改前的身份和本次决定摘要，不传完整文档：

```json
{
  "decisionSummary": "当前产品事实发生了什么变化",
  "expectedRevision": 3,
  "expectedDigest": "sha256:<修改前 context 返回的哈希>"
}
```

脚本读取当前磁盘文件并计算新哈希；Codrive 再次读取并验证非空文档、预期版本、预期哈希和新哈希，随后记录决定摘要、推进规划修订、终止失效的项目选择并重新调度。版本或哈希冲突时重新读取项目，不覆盖磁盘内容，并根据当前事实重新整理修改。文件内容没有变化时不创建新的产品事实版本。

任务级问题直接在原开发或审查对话中回答。Codex 使用当前对话继续同一个执行阶段，并在完成后通过 `$codrive-task` 汇报，不把原始聊天内容复制到 Codrive。

所有写命令只在 Codrive 返回成功响应后输出 `ok: true` 和 `result`，并以退出码 `0` 结束；HTTP 或 JSON 校验失败时以非零状态退出。读取命令继续直接输出查询结果。

## 结果交接

查询或控制完成后，报告新的业务状态，并在存在开发或审查对话 ID 时提供对应 `codex://threads/<id>` 链接。操作触发后续工作时，明确说明执行权已经交给 Codrive，后续开发、审查、返工和合入将由 Codrive 创建和调度的独立 Codex 对话继续执行。完成报告后结束当前回合。
