---
name: codrive-forge
description: 把新的产品或游戏想法整理为 Codrive 产品目标和初始任务，在用户确认后注册并启动本地自动开发。用户说想做一个产品、创建新 Codrive 项目或把当前仓库交给 Codrive 时使用。
compatibility: Requires Node.js 20+ and a running local Codrive service.
---

# Codrive Forge

把模糊想法变成用户确认过的产品契约和可执行任务，而不是直接开始写代码。

## 工作流

1. 阅读当前仓库的 `AGENTS.md`、README、源码入口和现有 Git 状态，理解已有产品与约束。
2. 与用户确认产品目标、目标用户、核心场景、当前范围、非目标和完成标准。
3. 把工作拆成具有明确结果的任务。任务使用业务名称，验收标准描述可观察行为。
4. 向用户展示完整产品摘要和任务计划，等待明确确认。
5. 用户确认后生成注册 JSON，并通过脚本写入 Codrive。

## 注册格式

```json
{
  "name": "产品名称",
  "repositoryPath": "/absolute/repository/path",
  "defaultBranch": "main",
  "productDocument": "# 产品名称\n\n## 产品目标\n...",
  "tasks": [
    {
      "title": "任务名称",
      "description": "任务结果和边界",
      "acceptanceCriteria": ["可观察验收标准"]
    }
  ]
}
```

注册前保证目录是绝对路径，产品文档包含目标、用户、场景、范围、产品决策、非目标和完成标准。Codrive 会在每次需要开始工作时让 AI 根据最新项目、任务和仓库状态重新判断任务关系并选择工作。

## 执行

将 JSON 通过标准输入传给：

```text
node <skill-directory>/scripts/codrive-forge.mjs register
```

脚本成功后报告项目 ID、看板状态和第一个被调度的任务。服务不可用时保留生成的 JSON，并告诉用户运行 `npx codrive`。
