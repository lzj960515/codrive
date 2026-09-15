---
name: codrive-work
description: 为已有 Codrive 项目增加或修改里程碑、任务和后续工作，判断归属、授权与生命周期；仅在长期产品事实变化时更新产品文档。用户要求给现有产品加功能、修改任何状态的任务定义、追加工作或开启下一阶段时使用；包括判断 backlog 能否原地修改，以及为已经开始、审查中、完成或取消的任务选择安全后续路径。
compatibility: Requires Node.js 24+ and a running local Codrive service.
---

# Codrive Work

在现有产品契约上增加或调整工作，保持任务与当前目标、已完成能力和进行中任务一致。

## 工作流

1. 通过项目 ID 读取项目，或先用 `$codrive-control` 查明当前仓库对应项目；读取 `PROJECT.md`、产品事实同步状态、里程碑及现有任务与活动。
2. 区分长期产品事实、阶段目标和具体交付。产品契约只因用途、能力或长期业务约束改变而修改；阶段目标进入里程碑，具体交付进入任务。
3. 从当前对话、产品契约、里程碑和已有决定确认结果与授权。已确认目标内的调查、必要漏项和实现选择直接推进；新增产品能力、改变既有结果或扩大阶段范围时，带着事实、影响、选项与推荐向用户请求决定。
4. 判断归属与生命周期。完成某个开放里程碑所必需的任务归入它；独立工作保持独立。普通未开始任务能完整承载结果时修改它；已开始任务保持定义和归属，不改变结果的反馈继续原会话。证据证明任务失效时按既有取消与替代流程处理；仍需调查时保留现场，让里程碑负责人记录受影响任务与调查去向。无关增强保留候选。
5. 需要拆分任务或安排迁移时，读取[任务拆分方法](references/task-slicing.md)。展示本次目标或任务变化及依据；已有授权覆盖的必要分解直接提交，不逐项重复确认。只是查询当前事实时完成查询后继续原工作流。
6. 新增普通任务使用 `add`；创建阶段目标使用 `milestone-create`，目标可以先没有任务。修改未开始任务或已确认里程碑定义使用 `$codrive-control`。只有真实产品事实改变时才先编辑 `PROJECT.md`，并在新增工作或任务修改中携带产品变更元数据。
7. 读取服务端回执，报告实际接受的目标或任务及推进状态，完成交接。

## 查询项目

```text
node <skill-directory>/scripts/codrive-work.mjs show <project-id>
```

## 添加任务

普通工作使用独立的计划摘要；产品文档不变时提交：

```json
{
  "decisionSummary": "补齐已确认迁移目标内的消费者",
  "tasks": [
    {
      "title": "迁移遗漏的消费者",
      "description": "保持原有结果，改为读取新模型",
      "acceptanceCriteria": ["消费者结果符合既有契约"],
      "milestoneId": "已存在的开放里程碑 ID"
    }
  ]
}
```

独立任务省略 `milestoneId`。同时改变长期产品事实时，先保存修改前的 `productFacts.revision` 与 `acceptedDigest`，编辑 `PROJECT.md`，再增加 `productDocumentChange: { expectedRevision, expectedDigest }`。脚本只在提供该对象时读取文件、计算 `documentDigest`；Codrive 在同一次计划变化中验证文档并追加任务。纯工作追加仍要求磁盘产品文档与已接受摘要一致。

```text
node <skill-directory>/scripts/codrive-work.mjs add <project-id> --json '<work-json>'
```

## 创建里程碑

为需要持续发现工作并最终验收的阶段创建目标，沿用 `title`、`description`、`acceptanceCriteria`。在 `description` 写清范围、非目标和已有自主授权；验收写可核实结果。已有阶段目标可以没有首批任务，由负责人初始评估补齐。

```text
node <skill-directory>/scripts/codrive-work.mjs milestone-create <project-id> --json '<milestone-json>'
```

把完整对象序列化为单行 JSON，通过唯一的 `--json` 参数提交。脚本只在 Codrive 成功接受命令后输出 `ok: true` 和 `result`，并以退出码 `0` 结束；HTTP 或 JSON 校验失败时以非零状态退出。版本冲突时重新读取当前事实，修订同一项变化。

## 调整未开始任务

普通 backlog 任务的名称、结果边界或验收标准需要调整时，读取 `$codrive-control` 并使用其 `task-update` 命令。纯任务澄清和已有目标内的任务补充只发送任务变化；长期产品事实变化同时携带 `productDocumentChange`，让 Codrive 用一个规划修订接受两项事实。命令成功后重新读取任务，确认返回的定义、任务状态和新规划均来自服务端持久化结果。

已经开始或进入审查的任务保留它启动时的定义。实现与审查反馈没有改变已确认结果时，在任务详情提供的原开发或审查对话中继续；原目标被新证据推翻时，先查清影响；需要新的业务取舍才请求用户决定。已获授权且事实足以判断的取消或替代直接处理，原因引用事实和已有授权。

## 结果交接

完成后报告新增或修改的任务 ID 和当前看板状态；存在开发或审查对话时提供对应入口。明确说明后续开发、审查、返工和合入已交给 Codrive，将由 Codrive 创建和调度的独立 Codex 对话继续执行。完成报告后结束当前回合。
