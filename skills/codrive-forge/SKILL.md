---
name: codrive-forge
description: 在用户当前打开的产品目录中，把新的产品或游戏想法整理为 Codrive 产品目标和初始任务，并在确认后注册和启动自动开发。用户在项目目录里描述产品想法、要求用 Codrive 推进当前项目或创建初始计划时使用。
compatibility: Requires Node.js 24+ and a running local Codrive service.
---

# Codrive Forge

把当前 Codex 工作目录中的产品想法变成用户确认过的产品契约，以及阶段目标或可执行任务。

## 工作流

1. 把当前 Codex 工作目录作为默认目标项目目录，读取其中的 `AGENTS.md`、README、源码入口和 Git 状态。空目录也代表用户已经创建并打开的新项目位置。
2. 从当前对话和已有资料提取已确认的产品目标、目标用户、核心场景、范围、非目标和完成标准；只澄清仍会改变结果的缺口。
3. 对需要持续发现工作和最终验收的阶段，先形成里程碑目标、范围、自主授权和验收；首批任务可以为空。已经明确的独立交付直接形成任务。拟定任务粒度、前置结果或迁移批次时，读取[任务拆分方法](../codrive-work/references/task-slicing.md)。最终体验或端到端确认属于里程碑验收时写入其标准，由负责人按证据安排普通验证任务；只有明确可定义的实际验证工作才提前形成任务。
4. 向用户展示产品契约、阶段目标或独立任务及授权边界；已有确认覆盖目标及必要分解时直接注册，只有尚未确认的业务结果需要确认。
5. 用户确认后，按[任务文档写法](../codrive-work/references/task-document.md)为每项新任务在项目仓库内写好 Markdown 文件，读回正文并核实路径。确保当前目录具备可供 Codrive 创建工作树的本地 Git 基线；需要时在当前目录初始化仓库、默认分支和初始提交。
6. 使用当前项目根目录和任务文档的相对路径生成注册 JSON，并通过脚本写入 Codrive。
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
      "taskDocumentPath": "docs/tasks/任务名称.md"
    }
  ]
}
```

注册时默认把 `repositoryPath` 设为当前项目根目录的绝对路径。新项目尚无磁盘文档，因此注册请求携带初始 `productDocument`，Codrive 创建 `PROJECT.md`；注册完成后所有修改都使用本地文件工具和轻量变更通知。产品文档保存用途、用户、能力、场景和长期约束；阶段范围和完成标准保存到里程碑，任务分解随证据变化。注册至少提供普通任务或里程碑之一；里程碑无任务时也会进行初始评估。Codrive 会在每次需要开始工作时让 AI 根据最新项目、任务和仓库状态重新判断任务关系并选择工作。

初始里程碑通过 `milestones` 数组传入，每项使用 `title`、`description`、`acceptanceCriteria`，可附使用相同文档路径格式的 `tasks`。只有阶段目标时传入 `tasks: []` 与非空 `milestones`；初始独立任务继续使用顶层 `tasks`。

## 执行

把完整注册对象序列化为单行 JSON，通过唯一的 `--json` 参数提交：

```text
node <skill-directory>/scripts/codrive-forge.mjs register --json '<registration-json>'
```

脚本只在 Codrive 成功接受注册后输出 `ok: true` 和 `result`，并以退出码 `0` 结束。HTTP 或 JSON 校验失败时以非零状态退出。服务不可用时保留生成的 JSON，并告诉用户运行 `npx codrive`。

## 结果交接

注册成功后，报告项目 ID、接受的里程碑或任务和看板状态，以及已经创建的持久对话入口。目标尚在初始评估时如实说明该阶段，不推断已派发具体任务。明确说明后续开发、审查、返工和合入已交给 Codrive，将由 Codrive 创建和调度的独立 Codex 对话继续执行。完成报告后结束当前回合。
