---
name: codrive-task
description: 读取并执行 Codrive 的项目任务选择或看板任务当前阶段，包括通用工作、独立审查、同步合入、后续工作判断和结果汇报。用户或 Codrive 要求选择、领取、处理、审查、继续、验收或汇报 Codrive 工作时使用。
compatibility: Requires Node.js 24+, Git, and a running local Codrive service.
---

# Codrive Task

Codrive 只提供任务引用。你主动读取产品和任务事实，完成当前阶段，并通过脚本回报业务结果。

## 读取上下文

有任务 ID 时运行：

```text
node <skill-directory>/scripts/codrive-task.mjs context <task-id>
```

需要根据当前目录找到项目时运行：

```text
node <skill-directory>/scripts/codrive-task.mjs resolve --cwd <absolute-current-directory>
```

读取命令返回的 `projectDocument`、`productFacts`、`taskDocument`、完整 `activities` 和仓库 `AGENTS.md`。`PROJECT.md` 是唯一当前产品事实；活动历史用于理解任务交付过程，不把历史产品决定重新拼成当前上下文。以 context 中的 `requestedAction` 决定当前工作。开始每个阶段前按时间通读活动历史，结合任务定义、当前状态和已有证据恢复连续上下文。

读取任务定义、验收标准、当前阶段和完整活动历史后，把这些内容与仓库规则共同作为本轮任务语义。开始执行当前阶段前，对照当前可用 Skill 的 `description`，加载与当前阶段实际工作匹配的 Skill，并遵循对应工作流。没有其他匹配 Skill 的任务继续按照本 Skill 完成。

`productFacts.status` 为 `modified` 时，磁盘文件尚未完成 Codrive 通知；负责这次修改的对话先用 `$codrive-control` 记录文档变更。项目选择在状态恢复为 `current` 前保持停止。

处理项目级任务选择时运行：

```text
node <skill-directory>/scripts/codrive-task.mjs project-context <project-id>
```

根据返回的 `requestedAction` 执行任务选择，并读取 `PROJECT.md`、全部任务文件、仓库规则和实际代码。只有 `productFacts.status` 为 `current` 时才提交选择结果。

## 连续任务工作区

Codrive 将持久任务对话归属到产品仓库根目录，让工作和审查对话始终显示在 Codex App 的同一个项目下。每个任务拥有两个稳定角色的对话：工作对话负责代码、文档、发布、迁移、验证、审查反馈处理和合入，独立的 Review 对话负责当前 work 结果的审查与复审。新的 Review round 继续同一个 Review 对话，使审查者能够结合后续修改、反证和上一轮结论重新判断。

对话目录表示产品归属；`context.workspacePath` 和 `context.delivery` 来自当前绑定的 `work` 活动。该活动有 `candidateCommit` 时，这些字段是本轮 Review 和合入唯一可用的 Git 事实；没有候选时，本轮是发布、迁移、验证等无代码工作，不虚构 Git 操作。

- `context` 返回 `workspacePath` 时，先进入该工作树，再执行当前阶段。提交与审查基线使用 `context.delivery`，并用实际 Git 状态确认。
- 当前 `work` 需要改代码且尚未记录 `workspacePath` 时，先检查规范路径 `<repository>/.worktrees/codrive/<project-id>/<task-id>`；已有工作树就继续使用，没有时再创建。
- 进入工作树后检查 `git status`、提交历史和差异，把已有改动作为当前任务的连续执行现场。结合任务目标、验收标准和版本历史，自主决定保留、修改、整合或清理，然后继续当前阶段。
- 主仓库中的用户改动保持原样；开发工作放在任务工作树，合入时基于最新主分支安全整合。

把 `needs_input` 用于真正需要用户决定的产品语义、外部凭据或权限。工作树恢复、现有改动归属、Git 冲突和代码取舍由当前 Codex 根据可见事实完成。

## 任务选择 `select_tasks`

读取 project context 中固定的 `planningRevision` 和项目级 `availableTaskSlots`，查看全部 `backlog`、活动任务、已完成结果和当前仓库。根据工作之间的真实关系、当前代码状态和当轮容量，完整判断这一规划版本现在适合独立开始的任务。其他项目的工作不占用当前项目容量。

- 有适合开始的工作时汇报 `selected` 和唯一的 `taskIds`；一轮可以选择多个任务，数量不超过 `availableTaskSlots`。
- 少于可用槽位的选择仍表示本轮已经检查全部 backlog；Codrive 等待新的规划事实，不用空闲槽位重复询问。
- 当前候选应等待正在执行或等待继续的任务时汇报 `wait_for_active_tasks`，让原任务对话负责其实现现场。
- 缺少影响项目规划的产品语义、外部凭据或权限时汇报 `needs_input` 和明确的 `question`。
- 存在确定障碍时汇报 `blocked`。

通过 `project-report` 提交选择结果。Codrive 按该 attempt 捕获的容量验证任务，并为选中任务分别创建独立工作对话。任务的 work、Review 和合入延续当前选择结果；完整任务完成、任务取消、新工作、产品决定、并发配置变化或人工重新规划才产生新的规划版本。

## 工作 `work`

`work` 是任务内所有需要业务判断和执行的通用阶段，包括首次实现、处理 Review finding、发布、迁移、外部验证和合入后的后续工作。先从活动末尾确认本轮来源：存在最近的 `review_changes_requested` 或 `integration_work_required` 时，独立判断每条 finding 或后续工作依据；成立的问题完成修改，不适用的问题形成有证据的回复，需要新产品语义的问题汇报 `needs_input`。

- 需要修改仓库时，按“连续任务工作区”定位或创建隔离工作树，让 `.worktrees/` 进入仓库自己的 `.git/info/exclude`，理解并整理已有现场，完成实现、验证和提交。汇报 `completed` 时提供 `workspacePath`、`baseCommit`、`candidateCommit` 和测试摘要。
- 不修改仓库的发布、迁移或验证工作直接在受支持的目标边界执行并收集证据。汇报 `completed` 时提供实际验证摘要，不提交空 SHA 或虚构工作树。
- 当前 Review finding 已由证据证明不适用时，可以保留原实现；在 `summary` 中记录反证。新的 `work_completed` 活动仍代表本轮可审查结果，Review 对话会重新判断。

## 审查 `review`

从任务契约、验收标准、完整活动历史、当前绑定的 work 活动和实际交付物状态还原真实交付场景。work 活动有 `context.delivery.candidateCommit` 时独立审查该候选；没有候选时审查发布、迁移或验证证据，不要求 Git 提交。根据交付物性质检查目标是否完成、证据是否可信，以及明显回归、安全和数据风险。只有能通过受支持的使用方式触发并真实影响当前交付的问题才成为阻塞；纯理论可能性保留为非阻塞观察，不进入 `findings`。

- 满足交付标准时汇报 `approved`。当前 work 有候选时把审查时的主分支提交写入 `reviewedMainCommit`；无候选时只提供测试或业务验证证据。
- 存在阻塞问题时汇报 `changes_requested`，`findings` 只列可操作问题。
- 复审时读取执行者对 findings 的处理与反证，重新判断旧结论；当前没有阻塞问题时直接批准。

## 合入 `integrate`

根据当前绑定 work 的 `context.delivery` 判断本轮是否包含代码候选，并结合任务契约判断本轮结果之后整个任务是否结束。

- 有候选时，检查主分支和人工改动，安全同步候选并自主解决可以判断的冲突，运行受影响测试。同步未改变候选语义时完成合入并清理任务工作树和临时分支；用 `git worktree list` 与 `git branch --list` 确认清理结果。
- 无候选时不执行 Git 合入或清理，只核实已经 Review 通过的业务结果。
- 本轮结果已经满足整个任务时汇报 `completed`；有候选时同时提供 `mergedCommit`，无候选时提供实际核实证据。
- 本轮已经合入或核实，但任务仍有发布、迁移、验证或代码工作时汇报 `work_required`，在 `summary` 中写清下一轮工作；本轮有候选时同时提供 `mergedCommit`。
- 同步或冲突解决产生新的代码候选时，先不合入，汇报 `needs_review`，并提供 `workspacePath`、`baseCommit`、`candidateCommit` 和测试证据。该报告会形成新的 `work_completed` 活动并重新进入独立 Review。
- 需要新的产品决策、外部凭据或权限时汇报 `needs_input`，保留所有现有内容。

## 汇报契约

把完整报告序列化为单行 JSON，通过唯一的 `--json` 参数提交：

```text
node <skill-directory>/scripts/codrive-task.mjs report <task-id> --json '<report-json>'
```

项目选择结果使用相同输入契约：

```text
node <skill-directory>/scripts/codrive-task.mjs project-report <project-id> --json '<report-json>'
```

脚本在 Codrive 接受报告后输出 `ok: true`。任务报告同时回读刚写入的不可变活动并返回非空 `activityId` 和本次 `reportOpportunityId`；项目报告返回 `attemptId` 和 `outcome`。以进程退出码 `0`、`ok: true` 及对应回执字段作为提交成功依据，再结束当前回合。HTTP、JSON、执行身份或回执验证失败时，脚本以非零状态退出并输出错误。

每份报告包含刚刚读取的 `context` 返回的 `attemptId` 和非空 `reportOpportunityId`，以及当前阶段允许的 `outcome` 和简明 `summary`。直接原样使用这两个执行身份，不从 turn、活动或历史 context 推导。缺少任一身份时停止提交并重新读取 context。Codrive 将每个报告机会的首次成功报告追加为一条不可变活动；同一机会的完全相同报告幂等返回，不追加活动。各阶段同时提供后续流程依赖的事实：

- `work` 完成：代码工作提供 `workspacePath`、`baseCommit`、`candidateCommit`、`tests`；无代码工作提供实际验证证据，不携带 Git 字段。
- `review` 通过：代码 work 提供 `reviewedMainCommit`、`tests`；无代码 work 提供实际审查证据。
- `review` 退回：非空 `findings` 和已执行的验证。
- `integrate` 完成：代码 work 提供 `mergedCommit`、`tests`；无代码 work 提供核实证据。
- `integrate` 需要继续工作：`work_required`、清楚的后续工作摘要，以及代码 work 的 `mergedCommit`。
- `integrate` 需要重审：新的 `workspacePath`、`baseCommit`、`candidateCommit` 和 `tests`。
- 需要用户决定：`needs_input` 和一个明确的 `question`。

`needs_input` 追加“请求决定”活动并保留当前执行和 `attemptId`，同时为用户回答后的结果轮换 `reportOpportunityId`。用户在 Codex App 的原任务对话中回答后，重新读取 context，使用同一个 `attemptId` 和新的 `reportOpportunityId` 提交最终报告；历史请求继续保留在活动时间线中，`submittedActivityId` 仍指向当前决定活动，直到新结果写入。

## 阻塞与计划恢复

根据恢复条件选择同一个 `blocked` outcome 的两种形式：

- 恢复时间未知时提交普通 `blocked`，写清当前障碍。该执行结束，用户稍后通过 `retry` 创建新的 attempt。
- 障碍具有明确恢复时间时提交计划 `blocked`，同时提供 `resumeAt` 和 `resumePrompt`。Codrive 保留当前 action、attempt、thread 和模型路由，到期并重新取得项目容量与合入资格后，在原对话继续同一执行。

`resumeAt` 使用可解析、处于未来且带 `Z` 或 UTC 偏移的 RFC 3339 绝对时间。用户使用自然语言表达时间时，先读取当前会话的时区上下文，将它解析为带偏移的绝对时间再提交；信息不足且不同解释会改变恢复时刻时，使用 `needs_input` 确认。

`resumePrompt` 是写给恢复后自己的执行检查点，简明包含：届时要重新检查的外部或仓库事实、等待前已经完成的工作与验证、继续当前阶段的明确下一步。恢复消息还会携带固定任务 ID 和 `$codrive-task` 入口，不在检查点中复制完整任务文档。

恢复 turn 启动时，会在同一 action、attempt 和 thread 中形成新的报告机会，并生成新的 `reportOpportunityId`。重新读取 context，使用原 `attemptId` 和新的 `reportOpportunityId` 提交恢复结果；等待前的 blocked 报告继续作为不可变活动保留，它携带旧机会身份，不能占用新 turn。当前报告机会内重复提交完全相同的报告保持幂等，提交不同结果仍按冲突处理。

计划阻塞报告格式：

```json
{
  "attemptId": "attempt-id",
  "reportOpportunityId": "report-opportunity-id",
  "outcome": "blocked",
  "summary": "等待原因",
  "resumeAt": "2026-08-13T18:30:00+08:00",
  "resumePrompt": "先检查等待事实与现有工作树，再从当前阶段的下一步继续。"
}
```

当前阶段要求报告为最后一个副作用时，计划阻塞同样遵守该顺序。提交成功后由 Codrive 原生调度，当前回合结束；不创建外部 cron、Automation 或额外提醒。

## 取消判断

当前阶段出现取消候选时，先判断是否需要用户决定：

- 需要产品取舍、停止范围或现场保留决定时，提交 `needs_input`，在 `question` 中说明建议取消的原因和需要用户确认的具体事项。用户在原任务对话明确答复后，使用 `$codrive-control` 以 `user_confirmed` 取消。
- 当前仓库和任务事实已经证明任务重复、已被替代或不再可执行，并且取消不需要新的产品选择或外部授权时，使用 `$codrive-control` 以 `agent_decision` 直接取消。

两种路径都提供具体取消理由：`user_confirmed` 概括用户同意的范围和原因，`agent_decision` 写明支持直接取消的可观察事实。取消命令成为当前阶段的最后一个副作用，终态任务无需再提交阶段报告。

代码 work 完成报告格式：

```json
{
  "attemptId": "attempt-id",
  "reportOpportunityId": "report-opportunity-id",
  "outcome": "completed",
  "summary": "完成内容",
  "workspacePath": "/absolute/worktree/path",
  "baseCommit": "base-commit-sha",
  "candidateCommit": "commit-sha",
  "tests": "实际运行的测试及结果"
}
```

先完成仓库操作，再把汇报作为当前阶段的最后一个副作用。脚本拒绝报告时，根据返回的字段要求修正同一份报告并重新提交。发生无法继续的确定问题时使用 `blocked`。
