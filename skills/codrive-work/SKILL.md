---
name: codrive-work
description: 为已有 Codrive 项目增加或修改任务、需求、里程碑和后续工作，并在用户确认后更新产品文档与任务计划。用户要求给现有产品加功能、修改任何状态的任务定义、追加工作或开启下一阶段时使用；包括判断 backlog 能否原地修改，以及为已经开始、审查中、完成或取消的任务选择安全后续路径。
compatibility: Requires Node.js 24+ and a running local Codrive service.
---

# Codrive Work

在现有产品契约上增加或调整工作，保持任务与当前目标、已完成能力和进行中任务一致。

## 工作流

1. 通过项目 ID读取项目，或先用 `$codrive-control` 查看当前仓库对应项目。
2. 阅读 `PROJECT.md`、`productFacts` 和现有任务状态，保存修改前的文档版本与哈希。
3. 与用户确认新需求的结果、范围和完成标准。
4. 结合现有任务判断是澄清普通 backlog 任务还是增加新工作。尚未开始的任务定义能够完整承载结果时修改它。任务已经开始或进入审查时，不改变已确认结果的实现或审查反馈进入原任务对话；改变产品结果、责任边界或验收标准时，向用户说明当前执行影响，并确认让原任务按旧契约完成，还是取消后用替代任务继续。已完成或取消任务的新增变化形成后续任务。系统生成任务交给其所有者维护。
5. 向用户展示产品文档变化和任务计划变化，等待明确确认。
6. 新增工作时局部更新 `PROJECT.md`，再通过本 Skill 的脚本提交文档变更元数据与新增任务。修改既有 backlog 任务时读取 `$codrive-control`，使用它的 `task-update` 命令；产品事实同时变化时先编辑 `PROJECT.md`，并把原文档版本与哈希放进同一个任务修改命令。
7. 根据脚本返回结果向用户完成交接，然后结束当前回合。

## 查询项目

```text
node <skill-directory>/scripts/codrive-work.mjs show <project-id>
```

## 添加任务

构造以下 JSON：

```json
{
  "decisionSummary": "本轮确认的产品变化",
  "expectedRevision": 3,
  "expectedDigest": "sha256:<修改前 show 返回的哈希>",
  "tasks": [
    {
      "title": "任务名称",
      "description": "结果和边界",
      "acceptanceCriteria": ["可观察标准"]
    }
  ]
}
```

脚本直接读取修改后的 `PROJECT.md` 并计算新哈希，不通过 API 传输完整文档。Codrive 把文档确认和任务追加作为一次规划事实变化处理；版本或哈希陈旧时拒绝命令，不覆盖本地文件。

```text
node <skill-directory>/scripts/codrive-work.mjs add <project-id> --json '<work-json>'
```

把完整对象序列化为单行 JSON，通过唯一的 `--json` 参数提交。脚本只在 Codrive 成功接受产品事实和新增任务后输出 `ok: true` 和 `result`，并以退出码 `0` 结束；HTTP 或 JSON 校验失败时以非零状态退出。

## 调整未开始任务

普通 backlog 任务的名称、结果边界或验收标准需要调整时，读取 `$codrive-control` 并使用其 `task-update` 命令。纯任务澄清只发送任务变化；产品范围变化同时携带 `productDocumentChange`，让 Codrive 用一个规划修订接受两项事实。命令成功后重新读取任务，确认返回的定义、任务状态和新规划均来自服务端持久化结果。

已经开始或进入审查的任务保留它启动时的定义。实现与审查反馈没有改变已确认结果时，在任务详情提供的原开发或审查对话中继续；产品结果、责任边界或验收标准发生变化时，先取得用户对当前任务完成或取消的决定，再通过现有取消与新增工作流程形成可追踪的替代任务。证据不足以判断变化性质时，说明两种路径对当前执行的影响并请用户决定。

## 结果交接

完成后报告新增或修改的任务 ID 和当前看板状态；存在开发或审查对话时提供对应入口。明确说明后续开发、审查、返工和合入已交给 Codrive，将由 Codrive 创建和调度的独立 Codex 对话继续执行。完成报告后结束当前回合。
