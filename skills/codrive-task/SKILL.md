---
name: codrive-task
description: 读取并执行 Codrive 看板任务或产品验收的当前阶段，包括开发、返工、独立审查、同步合入、产品完成判断和结果汇报。用户或 Codrive 要求领取、处理、审查、继续、验收或汇报 Codrive 工作时使用。
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

读取命令返回的 `projectDocument`、`taskDocument` 和仓库 `AGENTS.md`。以任务文件中的 `requestedAction` 决定当前工作。

处理项目级任务选择或产品验收时运行：

```text
node <skill-directory>/scripts/codrive-task.mjs project-context <project-id>
```

根据返回的 `requestedAction` 执行任务选择或产品验收，并读取 `PROJECT.md`、全部任务文件、仓库规则和实际代码。

## 任务选择 `select_tasks`

查看全部 `backlog`、活动任务、已完成结果和当前仓库。根据工作之间的真实关系、当前代码状态和可用并发数，选择现在适合独立开始的任务。每次选择都基于最新事实重新判断任务关系。

- 有适合开始的工作时汇报 `selected` 和唯一的 `taskIds`。
- 当前候选应等待正在执行的任务时汇报 `wait_for_active_tasks`。
- 缺少产品决策时汇报 `needs_input` 和明确的 `question`。
- 存在确定障碍时汇报 `blocked`。

通过 `project-report` 提交选择结果。Codrive 验证任务状态和并发数，并为选中任务分别创建独立开发对话。

## 开发 `develop`

1. 检查仓库和用户已有改动。
2. 遵循仓库工作树约定；没有约定时使用 `<repository>/.worktrees/codrive/<project-id>/<task-id>`。
3. 让 `.worktrees/` 进入仓库自己的 `.git/info/exclude`。
4. 实现任务、运行相关测试、修复发现的问题并提交代码。
5. 汇报 `completed`，包括 `workspacePath`、`baseCommit`、`candidateCommit` 和测试摘要。

## 返工 `rework`

读取任务中的最新审查报告，在现有工作树修复所有阻塞问题。运行测试并提交新的候选，随后汇报 `completed`。

## 审查 `review`

从任务契约、验收标准和实际候选提交独立判断，不依赖开发者的解释。验证功能、测试、明显回归、安全和数据风险。

- 满足交付标准时汇报 `approved`，把审查时的主分支提交写入 `reviewedMainCommit`。
- 存在阻塞问题时汇报 `changes_requested`，`findings` 只列可操作问题。
- 风格偏好和非必要扩展建议不阻塞交付。

## 合入 `integrate`

检查主分支和人工改动，安全同步候选并自主解决可以判断的冲突。运行受影响测试。

- 审查后主分支没有影响候选时，合入主分支，删除任务工作树和临时任务分支，再用 `git worktree list` 与 `git branch --list` 确认清理结果，汇报 `completed` 和 `mergedCommit`。
- 同步或冲突解决改变候选实现时，提交新候选但先不合入，汇报 `needs_review`。
- 无法安全判断人工改动或产品语义时汇报 `needs_input`，保留所有现有内容。

## 汇报契约

通过标准输入提交 JSON：

```text
node <skill-directory>/scripts/codrive-task.mjs report <task-id>
```

每份报告包含 `context` 返回的 `attemptId`、当前阶段允许的 `outcome` 和简明 `summary`。各阶段同时提供后续流程依赖的事实：

- `develop` 完成：`workspacePath`、`baseCommit`、`candidateCommit`、`tests`。
- `rework` 完成：`candidateCommit`、`tests`。
- `review` 通过：`reviewedMainCommit`、`tests`。
- `review` 退回：非空 `findings` 和已执行的验证。
- `integrate` 完成：`mergedCommit`、`tests`。
- `integrate` 需要重审：新的 `candidateCommit` 和 `tests`。
- 需要用户决定：`needs_input` 和一个明确的 `question`。

`needs_input` 暂停当前执行但保留 `attemptId`。用户在 Codex App 的原任务对话中回答后，继续当前阶段，并使用同一个 `attemptId` 提交新的最终报告。

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

## 产品验收

产品验收使用临时独立对话。检查产品完成标准、实际仓库行为和全部已完成任务：

- 完成标准全部满足时汇报 `completed`。
- 存在明确且可实施的缺口时汇报 `tasks_required`，提供具有业务结果、边界和验收标准的下一轮任务。
- 缺少产品决策时汇报 `needs_input` 和一个明确问题。
- 存在无法继续的确定障碍时汇报 `blocked`。

通过标准输入提交产品验收 JSON：

```text
node <skill-directory>/scripts/codrive-task.mjs project-report <project-id>
```

下一轮任务报告格式：

```json
{
  "attemptId": "evaluation-attempt-id",
  "outcome": "tasks_required",
  "summary": "仍需完成的产品缺口",
  "tasks": [
    {
      "title": "任务名称",
      "description": "任务结果和边界",
      "acceptanceCriteria": ["可观察验收标准"]
    }
  ]
}
```
