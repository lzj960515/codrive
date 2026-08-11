---
name: codrive-control
description: 查询和控制本地 Codrive 项目、任务与运行设置，包括产品详情、看板状态、暂停、恢复、取消、重试、重新规划、模型路由和补充上下文。用户询问 Codrive 进度、阻塞原因、模型容量恢复或要求干预自动流程时使用。
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

`project` 返回注册信息、完整 `PROJECT.md`、产品上下文、最小规划状态、任务与当前执行信息。`task` 返回任务定义、当前状态、完整进展记录和推导后的 Codex 对话链接。

项目的 `attention` 只表达需要处理的异常状态：`decision_requested` 表示需要在对应 Codex App 对话中作出决定，`blocked` 表示项目存在确定阻塞。没有 `attention` 时，项目按当前任务和规划状态正常推进。

## 运行设置

```text
node <skill-directory>/scripts/codrive-control.mjs settings
node <skill-directory>/scripts/codrive-control.mjs update-settings
```

`update-settings` 通过标准输入接收完整设置：

```json
{
  "maxConcurrentTasks": 4,
  "models": {
    "primary": "<primary-model-id>",
    "fallback": "<fallback-model-id>"
  }
}
```

并发上限按项目独立计算。模型设置作用于后续创建的执行；已经运行的 turn 保持启动时保存的模型。修改并发会为每个项目创建一个新的规划版本，单独修改模型路由保持现有规划版本。

## 控制项目

动作是 `pause`、`resume`、`retry`、`replan` 或 `cancel`：

```text
node <skill-directory>/scripts/codrive-control.mjs project-control <project-id> <action>
```

暂停和恢复只控制后续调度；已经运行的 turn 可以结束，所以看板可能显示“执行中 · 后续已暂停”。项目级执行失败并保留 `requestedAction` 时，使用 `retry` 在同一规划版本创建新的执行 attempt。确认产品、仓库或外部 Gate 已变化时，使用 `replan` 创建新的规划版本并重新判断 backlog。

## 控制任务

```text
node <skill-directory>/scripts/codrive-control.mjs task-control <task-id> retry
node <skill-directory>/scripts/codrive-control.mjs task-control <task-id> cancel
```

模型容量失败会在原 attempt 和原对话中按 5 秒、10 秒、20 秒自动重试三次，然后切换到 fallback 模型继续恢复。Fallback 同样重试三次；全部耗尽后任务才进入 `blocked`。此时任务级 `retry` 创建新的 attempt。`waiting_for_input` 由用户在原开发对话中回复，随后继续同一个 attempt。

## 取消判断

取消是永久终态。先读取目标项目或任务的当前状态、完整进展记录和对话上下文，再判断取消是否依赖用户意图：

- 需要产品取舍、停止范围或现场保留决定时，通过当前任务或项目报告提交 `needs_input`，在 `question` 中写清建议取消的原因和需要用户回答的问题。用户在原 Codex 对话明确答复后，以 `user_confirmed` 执行取消。
- 当前事实已经证明目标重复、已被替代或不再可执行，并且取消不需要新的产品选择或外部授权时，以 `agent_decision` 直接执行取消。

项目和任务的取消命令都通过标准输入接收判断依据与取消理由：

```json
{
  "decisionBasis": "<user_confirmed|agent_decision>",
  "reason": "<具体取消理由及其事实或用户决定>"
}
```

`user_confirmed` 的取消理由概括用户同意的范围和原因；`agent_decision` 的取消理由写明支持直接取消的事实。取消命令作为这次处理的最后一个副作用，完成后报告新的终态。

## 记录产品决策

用户在 Codex App 中回答产品级问题后，把整理后的长期产品决策写入 Codrive。通过标准输入传入 `decision`，需要更新产品契约时同时传入完整的 `productDocument`：

```text
node <skill-directory>/scripts/codrive-control.mjs record-decision <project-id>
```

任务级问题直接在原开发或审查对话中回答。Codex 使用当前对话继续同一个执行阶段，并在完成后通过 `$codrive-task` 汇报，不把原始聊天内容复制到 Codrive。

## 结果交接

查询或控制完成后，报告新的业务状态，并在存在开发或审查对话 ID 时提供对应 `codex://threads/<id>` 链接。操作触发后续工作时，明确说明执行权已经交给 Codrive，后续开发、审查、返工和合入将由 Codrive 创建和调度的独立 Codex 对话继续执行。完成报告后结束当前回合。
