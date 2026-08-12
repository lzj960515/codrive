---
name: codrive-forge
description: 在用户当前打开的产品目录中，把新的产品或游戏想法整理为 Codrive 产品目标和初始任务，并在确认后注册和启动自动开发。用户在项目目录里描述产品想法、要求用 Codrive 推进当前项目或创建初始计划时使用。
compatibility: Requires Node.js 20+ and a running local Codrive service.
---

# Codrive Forge

把当前 Codex 工作目录中的产品想法变成用户确认过的产品契约和可执行任务。

## 工作流

1. 把当前 Codex 工作目录作为默认目标项目目录，读取其中的 `AGENTS.md`、README、源码入口和 Git 状态。空目录也代表用户已经创建并打开的新项目位置。
2. 与用户确认产品目标、目标用户、核心场景、当前范围、非目标和完成标准。
3. 把工作拆成具有明确结果的任务。任务使用业务名称，验收标准描述可观察行为。产品完成定义需要最终体验或端到端确认时，把这次确认作为依赖前序成果的显式最终任务加入计划。
4. 向用户展示完整产品摘要和任务计划，等待明确确认。
5. 用户确认后，确保当前目录具备可供 Codrive 创建工作树的本地 Git 基线；需要时在当前目录初始化仓库、默认分支和初始提交。
6. 使用当前项目根目录生成注册 JSON，并通过脚本写入 Codrive。
7. 根据脚本返回结果向用户完成交接，然后结束当前回合。

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

注册时默认把 `repositoryPath` 设为当前项目根目录的绝对路径。产品文档包含目标、用户、场景、范围、产品决策、非目标和完成标准。Codrive 会在每次需要开始工作时让 AI 根据最新项目、任务和仓库状态重新判断任务关系并选择工作。

显式最终验收任务与其他任务使用相同结构。它的 `description` 写明需要基于哪些完整成果进行验证，`acceptanceCriteria` 写明可观察的产品结果；Codrive 会根据实际任务和仓库状态，在前序工作完成后选择它。

## 执行

将 JSON 通过标准输入传给：

```text
node <skill-directory>/scripts/codrive-forge.mjs register
```

服务不可用时保留生成的 JSON，并告诉用户运行 `npx codrive`。

## 结果交接

注册成功后，报告项目 ID、看板状态、第一个被调度的任务，以及已经创建的开发对话入口。明确说明后续开发、审查、返工和合入已交给 Codrive，将由 Codrive 创建和调度的独立 Codex 对话继续执行。完成报告后结束当前回合。
