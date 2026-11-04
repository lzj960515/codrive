---
name: codrive-control
description: 查询和控制本地 Codrive 项目、里程碑、任务与运行设置，包括产品详情、产品文档事实、已确认的未开始任务定义修改、看板状态、归档、恢复、暂停、取消、重试、重新规划和模型路由。用户询问 Codrive 进度、阻塞原因、执行已确认的 backlog 修改、更新产品事实、恢复模型容量或干预自动流程，以及定位本机项目、配置 Slack、创建或绑定频道、发送报告或本机文件、答复待决定问题时使用；新的任务需求和修改判断由 codrive-work 负责。
compatibility: Requires Node.js 24+ and a running local Codrive service.
---

# Codrive Control

使用确定性脚本读取或改变 Codrive 状态。执行写操作前复述目标项目或任务和预期影响。

## 查询

```text
node <skill-directory>/scripts/codrive-control.mjs local-projects
node <skill-directory>/scripts/codrive-control.mjs board
node <skill-directory>/scripts/codrive-control.mjs archived
node <skill-directory>/scripts/codrive-control.mjs project <project-id>
node <skill-directory>/scripts/codrive-control.mjs task <task-id>
node <skill-directory>/scripts/codrive-control.mjs milestone <milestone-id>
```

`board` 返回默认看板中的未归档项目；`archived` 返回已归档项目及其数量。`project` 返回注册信息、完整 `PROJECT.md`、产品事实同步状态、最小规划状态、归档时间、任务与当前执行信息。`task` 返回任务登记信息、归属、当前状态、完整进展记录和推导后的 Codex 对话链接；有 `taskDocumentPath` 时按项目仓库根目录读取原 Markdown 文件获得当前任务正文，没有路径的历史任务读取 `description` 和 `acceptanceCriteria`。`milestone` 返回目标、验收、当前结论、未决活动和负责人对话入口。当前任务数量不能代替里程碑完成判断。

项目的 `attention` 只表达需要处理的异常状态：`decision_requested` 表示需要在对应 Codex App 对话中作出决定，`blocked` 表示项目存在确定阻塞。没有 `attention` 时，项目按当前任务和规划状态正常推进。

`local-projects` 通过本机 Codrive 服务只读 Codex 桌面端保存的工作空间名称和根目录，与普通私信使用同一目录来源。它与 `board` 中的产品登记分别核实：一个工作空间可以包含多个产品，同一个目录也可以对应不同的 Codrive 产品。记录不可用时返回 `available: false`，继续核实用户给定的真实目录；桌面保存数据只提供定位线索，目标目录中的 README、AGENTS 和用户意图决定实际身份。

## Slack 接入与报告

机器人私信承担全局交流，已绑定频道使用对应项目；频道里的新根消息建立独立会话，机器人回复在原讨论串。普通查询直接使用适用工具办事，需要查询或控制 Codrive、发送报告或登记工程工作时再调用对应能力。

```text
node <skill-directory>/scripts/codrive-control.mjs slack-status
node <skill-directory>/scripts/codrive-control.mjs slack-channels
node <skill-directory>/scripts/codrive-control.mjs slack-configure --json-file <private-settings-file>
node <skill-directory>/scripts/codrive-control.mjs slack-bind <project-id> --json '{"channelId":"<channel-id>"}'
node <skill-directory>/scripts/codrive-control.mjs slack-create-channel <project-id> --json '{"name":"<channel-name>","isPrivate":true}'
```

创建或绑定项目频道时，按以下顺序办理：

1. 根据用户本次给出的名称或目录定位目标。私信运行目录只承担全局会话；使用 `local-projects` 查本机工作空间，再读取匹配目录的 README、AGENTS 核实用途。用户纠正过项目时，用这些当前事实重新核实目标。
2. 对照 `board` 和候选 `project` 的名称、目录、产品事实。用户指向工作空间，而已有产品仅与它共享目录时，使用 `$codrive-forge` 为准确的工作空间名称登记空任务项目，保留原产品记录。目标仍有歧义时列出可辨认的候选，请用户选择。
3. 用 `slack-status`、`slack-channels` 核对已有绑定与可访问频道。已有频道使用 `slack-bind`；用户要求新建时使用 `slack-create-channel`，按 Slack 规则把目标名转为频道名，例如 `pietra-ai-workspace`。该命令通过 API 创建频道、邀请配置的授权用户，再绑定目标项目，工作不依赖屏幕解锁。
4. 以真实返回的频道、绑定和受邀用户完成交接。权限缺失时报告所需 OAuth scope 和尚未完成的步骤；完成 API 授权后继续同一路径。创建已成功、后续失败时保留返回的 `channelId`，在同一创建命令中显式附上它续办；重名时核实实际频道归属后再选择，保持原项目和其他频道的绑定。

公开频道创建和邀请需要 `channels:manage`，私有频道需要 `groups:write`。机器人需要加入项目频道，并取得普通消息事件的权限，才能免 `@` 接收文字。连接设置从本机私有 JSON 文件读取，包含 `enabled`、`teamId`、`authorizedUserId`、`botToken`、`appToken`；用文件传入凭据，结果只展示服务端脱敏设置。

原生 Codex 定时报告或巡检结果使用同一发送入口：

```text
node <skill-directory>/scripts/codrive-control.mjs slack-report <project-id> --json '<report-json>'
```

```json
{
  "requestId": "<stable-report-request-id>",
  "markdown": "## 登录检查\n\n使用测试账号提交登录。预期进入首页，实际仍停留在登录页。",
  "source": {
    "kind": "codex_native",
    "requestId": "<stable-report-request-id>"
  }
}
```

一次报告生成一个请求身份，在同次发送重试时复用。以进程退出码 `0`、`ok: true` 和 `result` 中的真实 `messageTs`、`source`、`replyTarget` 确认发送成功；再次请求同一报告时沿用返回的消息位置。

巡检按本次要求执行检查，记录已观察到的操作、预期、实际结果与直接证据。发现异常后，先发送客观事实消息，拿到回执，再使用 `$codrive-work` 携带其中的 `source` 和 `replyTarget` 登记后续调查工作。原因调查、原因假设和修改代码属于开发阶段。普通报告发送后直接完成，不创建开发任务；发送失败时保留报告与请求身份，登记失败时复用已成功消息继续登记。

用户发来的图片和文件会下载到本机，消息上下文给出文件名、类型与绝对路径。按任务需要用看图或文件工具读取。需要把生成的文件交给用户时，完成文件写入，再使用当前消息的 `replyTarget` 上传到原会话：

```text
node <skill-directory>/scripts/codrive-control.mjs slack-send-file --json '<file-json>'
```

```json
{
  "replyTarget": { "kind": "slack", "teamId": "<当前工作区>", "channelId": "<原会话>", "threadTs": "<原讨论串根消息>" },
  "filePath": "/absolute/path/report.csv",
  "title": "数据报告",
  "comment": "已整理本次查询结果。"
}
```

直接私信的 `replyTarget` 可以没有 `threadTs`。以成功回执中的实际文件 `id` 和可用的 `permalink` 为交付依据。文件上传失败时报告失败，重试前核实已有回执，保持开发结果独立；该命令没有报告发送的持久自动补送语义。

Slack 内置 `/new` 在私信中开启新会话；频道的新根消息自然使用新会话。`/models` 列出当前可切换的主模型及当前、备用模型；`/model` 提供当前作用范围的模型选择，私信修改全局默认、绑定频道修改项目，下一回合生效。`/state` 查看作用范围、实际工作目录、模型、推理强度、权限和用量；频道内选择明确会话，或从消息菜单执行「查看 Codrive 状态」。缺少实际用量时显示暂无，窗口余量有数据时注明估算。

当前任务或项目确实存在待决定问题时，原样使用服务返回的 `scope`、对象 `id` 和 `reportOpportunityId`：

```text
node <skill-directory>/scripts/codrive-control.mjs reply-decision --json '{"scope":"task","id":"<task-id>","reportOpportunityId":"<current-opportunity-id>","message":"<用户答复>"}'
```

问题身份由当前事实校验；普通补充消息继续原会话，旧问题的答复不能占用新问题。安装或配置 Slack 应用时读取 [Slack 接入与 Mac 运行](https://github.com/lzj960515/codrive/blob/main/docs/operations/slack.md)；同一说明随 Codrive 包保存在 `docs/operations/slack.md`。定时计划在 Codex 原生界面管理。

## 运行设置

```text
node <skill-directory>/scripts/codrive-control.mjs settings
node <skill-directory>/scripts/codrive-control.mjs update-settings --json '{"maxConcurrentTasks":4,"models":{"primary":"<primary-model-id>","fallback":"<fallback-model-id>"}}'
```

`update-settings` 的 `--json` 参数接收完整设置：

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

动作是 `pause`、`resume`、`retry`、`replan`、`archive`、`unarchive` 或 `cancel`：

```text
node <skill-directory>/scripts/codrive-control.mjs project-control <project-id> <action>
```

暂停和恢复只控制后续调度；已经运行的 turn 可以结束，所以看板可能显示“执行中 · 后续已暂停”。项目级执行失败并保留 `requestedAction` 时，使用 `retry` 在同一规划版本创建新的执行 attempt。确认产品、仓库或外部前置条件已变化时，使用 `replan` 创建新的规划版本并重新判断 backlog。

归档前先读取项目和任务执行状态。项目或任一任务正在启动、运行、等待重试、等待汇报、等待输入或计划等待时，保留当前项目并报告 Codrive 返回的可操作原因。`archive` 会暂停后续调度并从默认看板隐藏项目，同时保留本地数据、`PROJECT.md`、任务、活动历史、执行证据和 Codex 对话引用。`unarchive` 恢复项目可见性；恢复后仍保持暂停，需要用户明确执行 `resume` 才会重新调度。归档与取消的语义独立，第一版不永久删除项目，也不联动归档 Codex 对话。

## 控制任务

```text
node <skill-directory>/scripts/codrive-control.mjs task-control <task-id> retry
node <skill-directory>/scripts/codrive-control.mjs task-control <task-id> continue
node <skill-directory>/scripts/codrive-control.mjs task-control <task-id> reschedule --json '<schedule-json>'
node <skill-directory>/scripts/codrive-control.mjs task-control <task-id> cancel --json '<decision-json>'
```

模型容量失败会在原 attempt 和原对话中按 5 秒、10 秒、20 秒自动重试三次，然后切换到 fallback 模型继续恢复。Fallback 同样重试三次；全部耗尽后任务才进入 `blocked`。此时任务级 `retry` 创建新的 attempt。`waiting_for_input` 由用户在原开发对话中回复，随后继续同一个 attempt。

`waiting_for_resume` 是计划等待：保留原阶段、attempt、thread、模型路由和 AI 编写的 `resumePrompt` 检查点，同时释放项目容量与 integrate 的仓库资格。`continue` 提前继续同一执行；`reschedule` 通过唯一的 `--json` 参数接收新的未来 RFC 3339 绝对时间：

```json
{
  "resumeAt": "2026-08-13T18:30:00+08:00"
}
```

```text
node <skill-directory>/scripts/codrive-control.mjs task-control <task-id> reschedule --json '{"resumeAt":"2026-08-13T18:30:00+08:00"}'
```

重新安排只改变恢复时间；提前继续和到期恢复都会先重新取得当前项目容量与仓库合入资格，再在原对话启动唯一的新 turn。项目暂停会保留等待，恢复项目后处理已经到期的任务。

## 修改未开始任务

用户提出新的任务需求或要求改变任务定义时，先读取 `$codrive-work` 完成范围与已有授权判断；新的业务取舍需确认，已授权的必要变化直接执行。本节负责执行已经确认的修改。

执行前读取任务与项目详情，保存任务当前的 `updatedAt`。任务仍是普通 `backlog`、`requestedAction=null`、没有执行，并且项目仍未取消和未归档时，使用定义修改命令调整标题、归属或文档路径。系统生成任务由其所有者维护；已经开始、完成或取消的任务返回 `$codrive-work` 选择当前生命周期、取消替换或后续任务。已有文档路径的任务正文在主项目目录直接编辑原文件，后续规划与任务回合重新读取。

纯登记信息变化直接提交相应字段：

```json
{
  "expectedUpdatedAt": "2026-09-01T10:00:00.000Z",
  "decisionSummary": "本次任务定义为什么变化",
  "changes": {
    "title": "可选的新名称",
    "taskDocumentPath": "docs/tasks/新的任务文档.md"
  }
}
```

`changes` 可修改 `title`、`taskDocumentPath` 或 `milestoneId`；没有文档路径的历史任务还可修改 `description` 和 `acceptanceCriteria`。历史未开始任务首次设置文档路径时转为文档模式。新写的任务文档放在项目仓库的 `docs/tasks/`，按[任务文档模板](../codrive-work/references/task-document.md)填写并读回，再登记 `taskDocumentPath`。归属只能指向同项目开放里程碑，解除归属使用 `null`。只发送需要改变的字段：

```text
node <skill-directory>/scripts/codrive-control.mjs task-update <task-id> --json '<task-update-json>'
```

任务变化同时改变当前产品事实时，先读取项目 context 并保存 `productFacts.revision` 和 `productFacts.acceptedDigest`，再局部编辑 `PROJECT.md`，然后在同一任务修改中增加：

```json
{
  "productDocumentChange": {
    "expectedRevision": 3,
    "expectedDigest": "sha256:<修改前哈希>"
  }
}
```

脚本读取磁盘上的 `PROJECT.md` 并计算新哈希；Codrive 在一个序列化命令中接受产品事实和任务登记信息，记录决定摘要，替换失效的任务选择并推进一个规划版本。任务版本、产品文档版本或生命周期已经变化时，重新读取当前状态并根据最新事实整理修改。任务 JSON 保存登记信息与运行状态；已有路径文档的正文变化以原文件当前内容为准。

## 修改已确认的里程碑目标

阶段范围或验收确实改变时，先由 `$codrive-work` 核实已有授权。读取当前里程碑定义版本，再提交明确的变化与决定摘要：

`--json` 对象包含 `expectedDefinitionVersion`、`decisionSummary` 和完整的 `changes: { title, description, acceptanceCriteria }`。

```text
node <skill-directory>/scripts/codrive-control.mjs milestone-update <milestone-id> --json '<definition-update-json>'
```

新事实与调查结论属于里程碑活动，不用于暗中重写目标。需要继续评估时，由负责人使用 `$codrive-task` 的里程碑流程处理；产品长期规则确实改变才同步 `PROJECT.md`。

## 取消判断

取消是永久终态。先读取目标项目或任务的当前状态、完整进展记录和对话上下文，再判断取消是否依赖用户意图：

- 需要产品取舍、停止范围或现场保留决定时，通过当前任务或项目报告提交 `needs_input`，在 `question` 中写清建议取消的原因和需要用户回答的问题。用户在原 Codex 对话明确答复后，以 `user_confirmed` 执行取消。
- 当前事实已经证明目标重复、已被替代或不再可执行，并且取消不需要新的产品选择或外部授权时，以 `agent_decision` 直接执行取消。

项目和任务的取消命令都通过唯一的 `--json` 参数接收判断依据与取消理由：

```json
{
  "decisionBasis": "<user_confirmed|agent_decision>",
  "reason": "<具体取消理由及其事实或用户决定>"
}
```

```text
node <skill-directory>/scripts/codrive-control.mjs project-control <project-id> cancel --json '{"decisionBasis":"agent_decision","reason":"<具体取消理由>"}'
node <skill-directory>/scripts/codrive-control.mjs task-control <task-id> cancel --json '{"decisionBasis":"agent_decision","reason":"<具体取消理由>"}'
```

`user_confirmed` 的取消理由概括用户同意的范围和原因；`agent_decision` 的取消理由写明支持直接取消的事实。取消命令作为这次处理的最后一个副作用，完成后报告新的终态。

## 更新当前产品事实

`PROJECT.md` 是 Agent 读取的唯一当前产品事实。修改前读取 project context，保存 `productFacts.revision` 和 `productFacts.acceptedDigest`；使用普通文件编辑工具局部修改返回的 `projectDocument`，然后立即发送轻量通知：

```text
node <skill-directory>/scripts/codrive-control.mjs product-document-changed <project-id> --json '{"decisionSummary":"<本次决定>","expectedRevision":3,"expectedDigest":"sha256:<修改前哈希>"}'
```

`--json` 只传文档修改前的身份和本次决定摘要，不传完整文档：

```json
{
  "decisionSummary": "当前产品事实发生了什么变化",
  "expectedRevision": 3,
  "expectedDigest": "sha256:<修改前 context 返回的哈希>"
}
```

脚本读取当前磁盘文件并计算新哈希；Codrive 再次读取并验证非空文档、预期版本、预期哈希和新哈希，随后记录决定摘要、推进规划修订、终止失效的项目选择并重新调度。版本或哈希冲突时重新读取项目，不覆盖磁盘内容，并根据当前事实重新整理修改。文件内容没有变化时不创建新的产品事实版本。

任务级问题可以在原开发或审查对话中回答，也可以通过当前 Slack 待决定消息答复。Codex 在对应原执行继续处理并通过 `$codrive-task` 汇报；原始聊天留在原生会话中。

所有写命令只在 Codrive 返回成功响应后输出 `ok: true` 和 `result`，并以退出码 `0` 结束；HTTP 或 JSON 校验失败时以非零状态退出。读取命令继续直接输出查询结果。

## 结果交接

作为其他工作流的查询步骤时，把所需事实返回当前工作流并继续完成用户目标。独立查询或控制完成后，按用户关心的项目或任务报告当前结果、仍待处理的事项及有用的 `codex://threads/<id>` 对话入口；本次操作实际触发后续执行时，说明已经交给 Codrive 的工作。
