---
name: codrive-task
description: 读取并执行 Codrive 的项目任务选择或看板任务当前阶段，包括开发、返工、独立审查、同步合入和结果汇报。用户或 Codrive 要求选择、领取、处理、审查、继续、验收或汇报 Codrive 工作时使用。
compatibility: Requires Node.js 20+, Git, and a running local Codrive service.
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

读取命令返回的 `projectDocument`、`taskDocument`、完整 `activities` 和仓库 `AGENTS.md`。以 context 中的 `requestedAction` 决定当前工作。开始每个阶段前按时间通读活动历史，结合任务定义、当前状态和已有证据恢复连续上下文。

处理项目级任务选择时运行：

```text
node <skill-directory>/scripts/codrive-task.mjs project-context <project-id>
```

根据返回的 `requestedAction` 执行任务选择，并读取 `PROJECT.md`、全部任务文件、仓库规则和实际代码。

## 连续任务工作区

Codrive 将持久任务对话归属到产品仓库根目录，让开发和审查对话始终显示在 Codex App 的同一个项目下。对话目录表示产品归属；`context.workspacePath` 和 `context.delivery` 是从活动历史推导的当前工作树与 Git 事实。开发、审查、返工和合入的文件、Git 与测试操作都在任务工作树中完成。

- `context` 返回 `workspacePath` 时，先进入该工作树，再执行当前阶段。提交与审查基线使用 `context.delivery`，并用实际 Git 状态确认。
- 首次开发尚未记录 `workspacePath` 时，先检查规范路径 `<repository>/.worktrees/codrive/<project-id>/<task-id>`；已有工作树就继续使用，没有时再创建。
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

通过 `project-report` 提交选择结果。Codrive 按该 attempt 捕获的容量验证任务，并为选中任务分别创建独立开发对话。任务开始、审查、返工和合入延续当前选择结果；完整任务完成、任务取消、新工作、产品决定、并发配置变化或人工重新规划才产生新的规划版本。

## 开发 `develop`

1. 按“连续任务工作区”定位或创建当前任务的隔离工作树。
2. 让 `.worktrees/` 进入仓库自己的 `.git/info/exclude`。
3. 理解并整理工作树中的现有实现，让最终差异完整服务当前任务。
4. 实现任务、运行相关测试、修复发现的问题并提交代码。
5. 汇报 `completed`，包括 `workspacePath`、`baseCommit`、`candidateCommit` 和测试摘要。

## 返工 `rework`

从 `activities` 末尾向前找到最近一条 `review_changes_requested`，读取其中的 `evidence.findings`，在现有工作树修复所有阻塞问题。运行测试并提交新的候选，随后汇报 `completed`。

## 审查 `review`

从任务契约、验收标准、完整活动历史、`context.delivery.candidateCommit` 和实际 Git 状态独立判断。验证功能、测试、明显回归、安全和数据风险。

- 满足交付标准时汇报 `approved`，把审查时的主分支提交写入 `reviewedMainCommit`。
- 存在阻塞问题时汇报 `changes_requested`，`findings` 只列可操作问题。
- 风格偏好和非必要扩展建议不阻塞交付。

## 合入 `integrate`

根据 `context.delivery` 恢复候选提交与审查基线，检查主分支和人工改动，安全同步候选并自主解决可以判断的冲突。运行受影响测试。

- 审查后主分支没有影响候选时，合入主分支，删除任务工作树和临时任务分支，再用 `git worktree list` 与 `git branch --list` 确认清理结果，汇报 `completed` 和 `mergedCommit`。
- 同步或冲突解决改变候选实现时，提交新候选但先不合入，汇报 `needs_review`。
- 需要新的产品决策、外部凭据或权限时汇报 `needs_input`，保留所有现有内容。

## 汇报契约

通过标准输入提交 JSON：

```text
node <skill-directory>/scripts/codrive-task.mjs report <task-id>
```

每份报告包含 `context` 返回的 `attemptId`、当前阶段允许的 `outcome` 和简明 `summary`。报告 JSON 输入形式保持稳定；Codrive 将每次成功报告追加为一条不可变活动。各阶段同时提供后续流程依赖的事实：

- `develop` 完成：`workspacePath`、`baseCommit`、`candidateCommit`、`tests`。
- `rework` 完成：`candidateCommit`、`tests`。
- `review` 通过：`reviewedMainCommit`、`tests`。
- `review` 退回：非空 `findings` 和已执行的验证。
- `integrate` 完成：`mergedCommit`、`tests`。
- `integrate` 需要重审：新的 `candidateCommit` 和 `tests`。
- 需要用户决定：`needs_input` 和一个明确的 `question`。

`needs_input` 追加“请求决定”活动并保留当前执行和 `attemptId`。用户在 Codex App 的原任务对话中回答后，继续当前阶段，并使用同一个 `attemptId` 提交新的最终报告；历史请求继续保留在活动时间线中。

## 取消判断

当前阶段出现取消候选时，先判断是否需要用户决定：

- 需要产品取舍、停止范围或现场保留决定时，提交 `needs_input`，在 `question` 中说明建议取消的原因和需要用户确认的具体事项。用户在原任务对话明确答复后，使用 `$codrive-control` 以 `user_confirmed` 取消。
- 当前仓库和任务事实已经证明任务重复、已被替代或不再可执行，并且取消不需要新的产品选择或外部授权时，使用 `$codrive-control` 以 `agent_decision` 直接取消。

两种路径都提供具体取消理由：`user_confirmed` 概括用户同意的范围和原因，`agent_decision` 写明支持直接取消的可观察事实。取消命令成为当前阶段的最后一个副作用，终态任务无需再提交阶段报告。

开发完成报告格式：

```json
{
  "attemptId": "attempt-id",
  "outcome": "completed",
  "summary": "完成内容",
  "workspacePath": "/absolute/worktree/path",
  "baseCommit": "base-commit-sha",
  "candidateCommit": "commit-sha",
  "tests": "实际运行的测试及结果"
}
```

先完成仓库操作，再把汇报作为当前阶段的最后一个副作用。脚本拒绝报告时，根据返回的字段要求修正同一份报告并重新提交。发生无法继续的确定问题时使用 `blocked`。
