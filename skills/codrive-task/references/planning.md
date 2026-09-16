# 规划与目标验收

项目调度决定现在启动哪些任务；里程碑负责人决定完成目标还需要哪些工作。两者使用同项目可见的持久会话，由 Codrive 统一派发，每轮读取当前事实而非依赖聊天记忆。

## 共同入口与依据

```text
node <skill-directory>/scripts/codrive-task.mjs project-context <project-id>
node <skill-directory>/scripts/codrive-task.mjs milestone-context <milestone-id>
```

读取产品契约、当前目标、任务定义与状态、完整相关活动和直接证据。`PROJECT.md` 只承载当前长期产品事实；里程碑定义拥有阶段目标、范围与验收。每轮保存 context 返回的 `attemptId`、`reportOpportunityId` 与读取版本；报告原样使用这些身份。新证据可以推翻旧结论，历史活动保留来源，当前计划按最新证据判断。

已有授权来自用户确认目标、产品契约、里程碑边界及已接受决定。目标内必要漏项、调查和实现方法直接处理；范围外能力或改变已有业务结果的选择才需要用户。报告依据说明具体事实与授权，理由本身不扩大授权。

## 项目任务选择 `select_tasks`

读取固定的 `planningRevision`、`availableTaskSlots`，检查全项目 backlog、活动任务、里程碑限制、已完成结果和当前代码。任务所属里程碑不同不代表必须串行；按真实前置结果选择，历史编号及排列顺序不构成依赖，用户明确的执行顺序仍是约束。

- 有可独立开始的工作：`selected`，`taskIds` 唯一且不超过本轮容量。
- 当前候选需等活动任务交付：`wait_for_active_tasks`，说明具体前置结果。
- 缺少决定性业务语义或新权限：`needs_input`，说明事实和问题；已有里程碑问题由对应负责人处理，避免重复询问。
- 确定无法推进：`blocked`，给出具体障碍。

通过 `project-report` 提交，包含本轮 `attemptId`、`reportOpportunityId`、`outcome`、`summary` 和所需结果字段。少于可用槽位仍表示已检查完整 backlog；新的任务/阶段结果、产品事实或其他规划事实变化才触发再判断，空位仅是派发条件。

## 里程碑评估 `assess_milestone`

1. **核实目标。** 阅读定义版本、验收、授权、当前事实版本与上次评估之后的活动。没有任务也要评估：目标已成立就逐项提供证据，否则形成足以开始的工作。
2. **检查新事实。** 从发现与有效阶段报告检查遗漏的消费者、依赖、验证及失效前提。短小只读核实可当轮完成；需要较长调查、代码修改、运行验证时创建普通任务，继续经过独立 Review。
3. **组织处置。** 原任务内细节继续原任务；独立漏项追加任务；证据不足安排调查；重复来源关联到同一项任务或问题；无关增强保留候选并说明不影响本目标。处置引用 `sourceActivityIds`，对新结论保留反证和取代依据。
4. **保护受影响工作。** 需要暂缓时，在处置中列出确实受影响的 `affectedTaskIds`。调查和无关任务继续。已开始任务保持定义、归属和候选；Codrive 持久化活动后中断在途 turn，恢复前检查未决影响。确认交付失效才使用有版本及理由的取消并生成替代任务。
5. **形成下一步或验收。** 需要某项调查、验证或前置交付结束后继续判断时，在处置的 `waitForTaskIds` 中记录对应任务。任务完成或取消后，Codrive 会重新启动评估。成员任务全部结束后逐项核对当前验收、待处理来源、取消/替代缺口及所需运行证据；缺证据创建普通验证任务。只有所有必要结果和证据成立才报告完成。

### 等待用户期间继续推进

问题与评估执行分开。用 `needs_input` 报告附问题的处置，说明事实、影响、选项、推荐和受影响任务；本轮接受后释放执行位置，后续证据仍在原里程碑会话开启新评估。

多个来源重复提出同一个问题时，关联到已有问题活动并补充证据，保留一个当前待答入口。新证据已解决原问题时，用处置引用旧活动、说明依据；用户随后回答已被取代的问题，先核实当前有效目标，旧回答不会自动变成新计划。

用户回答只解决业务取舍。若删除仍需等待消费者迁移，接受决定的同一计划中保留 `affectedTaskIds`，并设置 `waitForTaskIds` 指向必要交付；直到证据足够再处置这条等待活动。原问题解决不等于全部执行限制解除。通过活动保持处置连续，不另建暂停状态或手改任务文件。

### 报告和计划

```text
node <skill-directory>/scripts/codrive-task.mjs milestone-report <milestone-id> --json '<report-json>'
```

报告字段：`attemptId`、`reportOpportunityId`、`definitionVersion`、`planningRevision`、`outcome`、`summary`，以及必要的 `evidence` 和 `plan`。里程碑 ID 由脚本参数传入。

| outcome | 表达的结果 |
| --- | --- |
| `progress` | 接受计划、处置来源，继续等待明确任务或新事实 |
| `needs_input` | 保存当前业务问题和影响；无关工作继续 |
| `blocked` | 明确当前无法推进的原因 |
| `completed` | 当前目标逐项有有效证据且无必要未结工作 |

`plan` 只按需要包含：

- `tasks`：新增普通任务，每项 `key` 在本报告内唯一，其他字段为 `title`、`description`、`acceptanceCriteria`。
- `updates`：普通未开始任务的 `taskId`、`expectedUpdatedAt`、`changes`。
- `cancellations`：已证实需要取消任务的 `taskId`、`expectedUpdatedAt`、`decisionBasis`、`reason`，沿用 `agent_decision | user_confirmed`。
- `resolutions`：`sourceActivityIds`、`summary`，可附 `question`、`affectedTaskIds`、`waitForTaskIds`。任务引用使用现有 ID 或同一计划 `tasks[].key`，Codrive 在接受时统一转成新任务 ID。

普通任务沿自身阶段继续，负责人在明确新发现、指定等待任务结束、全部成员任务结束或目标与决定变化时评估。等待最终验收可保持 `progress`；需要中途重新判断的交付使用 `waitForTaskIds`，需要暂缓的任务另列 `affectedTaskIds`。初始问题或初始等待的 `sourceActivityIds` 可为空，后续处置引用真实来源活动。等待任务应指向尚未取得所需有效交付的任务。外部条件要到指定时点核实，创建普通任务并沿其计划恢复能力处理。没有可推进来源时补充工作、明确阻塞或完成目标。

任务发现通过主 Skill 的非终态 `discovery` 命令登记；Review 的 `findings` 继续专指当前交付阻塞。

服务端拒绝旧定义或涉及任务的陈旧版本时，重新读取上下文修订计划。同一报告机会重试同一报告，不重新制造任务；普通并发新证据留给下一轮。完成报告需核对最新事实，不能使用陈旧验收基线。

脚本成功返回 `ok: true` 和服务端结果后完成交接。实际验证沿普通任务，里程碑负责人综合已审查证据；无代码验证任务沿既有生命周期核实结果，不生成空提交。
