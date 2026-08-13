---
name: codrive-work
description: 为已有 Codrive 项目增加需求、里程碑或后续任务，并在用户确认后更新产品文档和任务计划。用户要求给现有产品加功能、追加工作或开启下一阶段时使用。
compatibility: Requires Node.js 24+ and a running local Codrive service.
---

# Codrive Work

在现有产品契约上增加工作，保持新任务与当前目标、已完成能力和进行中任务一致。

## 工作流

1. 通过项目 ID读取项目，或先用 `$codrive-control` 查看当前仓库对应项目。
2. 阅读 `PROJECT.md` 和现有任务状态。
3. 与用户确认新需求的结果、范围和完成标准。
4. 结合现有任务避免复制已经完成的工作，并保持每个新增任务可以独立理解。新增需求直接形成需求任务；明确需要发布验证或端到端验收时，把对应验证作为显式任务加入本轮计划。
5. 向用户展示产品文档变化和新增任务，等待明确确认。
6. 通过脚本添加任务；`idle` 项目进入 `active`，项目原有的暂停状态继续保持。
7. 根据脚本返回结果向用户完成交接，然后结束当前回合。

## 查询项目

```text
node <skill-directory>/scripts/codrive-work.mjs show <project-id>
```

## 添加任务

将以下 JSON 通过标准输入传给添加命令：

```json
{
  "productDocument": "可选的完整更新后 PROJECT.md",
  "tasks": [
    {
      "title": "任务名称",
      "description": "结果和边界",
      "acceptanceCriteria": ["可观察标准"]
    }
  ]
}
```

```text
node <skill-directory>/scripts/codrive-work.mjs add <project-id>
```

## 结果交接

添加成功后，报告新增任务 ID、当前看板状态，以及已经创建的开发对话入口。明确说明后续开发、审查、返工和合入已交给 Codrive，将由 Codrive 创建和调度的独立 Codex 对话继续执行。完成报告后结束当前回合。
