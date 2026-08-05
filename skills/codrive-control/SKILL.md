---
name: codrive-control
description: 查询和控制本地 Codrive 项目与任务，包括看板状态、暂停、恢复、取消、重试和补充上下文。用户询问 Codrive 进度、阻塞原因或要求干预自动流程时使用。
compatibility: Requires Node.js 20+ and a running local Codrive service.
---

# Codrive Control

使用确定性脚本读取或改变 Codrive 状态。执行写操作前复述目标项目或任务和预期影响。

## 查询

```text
node <skill-directory>/scripts/codrive-control.mjs board
node <skill-directory>/scripts/codrive-control.mjs project <project-id>
node <skill-directory>/scripts/codrive-control.mjs task <task-id>
```

## 控制项目

动作是 `pause`、`resume` 或 `cancel`：

```text
node <skill-directory>/scripts/codrive-control.mjs project-control <project-id> <action>
```

取消会停止后续调度。暂停保留当前状态；恢复会立即检查可执行任务。

## 控制任务

```text
node <skill-directory>/scripts/codrive-control.mjs task-control <task-id> retry
node <skill-directory>/scripts/codrive-control.mjs task-control <task-id> cancel
```

## 记录产品决策

用户在 Codex App 中回答产品级问题后，把整理后的长期产品决策写入 Codrive。通过标准输入传入 `decision`，需要更新产品契约时同时传入完整的 `productDocument`：

```text
node <skill-directory>/scripts/codrive-control.mjs record-decision <project-id>
```

任务级问题直接在原开发或审查对话中回答。Codex 使用当前对话继续同一个执行阶段，并在完成后通过 `$codrive-task` 汇报，不把原始聊天内容复制到 Codrive。

## 结果交接

查询或控制完成后，报告新的业务状态，并在存在开发或审查对话 ID 时提供对应 `codex://threads/<id>` 链接。操作触发后续工作时，明确说明执行权已经交给 Codrive，后续开发、审查、返工和合入将由 Codrive 创建和调度的独立 Codex 对话继续执行。完成报告后结束当前回合。
