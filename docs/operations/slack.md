# Slack 接入与 Mac 运行

Codrive 使用 Slack Socket Mode 接收消息，通过本机 Codex 直接处理普通请求，需要工程交付时使用现有 Codrive 任务链路。机器人私信用于全局交流；已绑定频道对应项目，直接发普通消息即可，每条根消息的讨论串是一个独立会话。

## 准备本机

Slack 功能需要 Codrive 0.15.0 或以上。先确认目标 Mac 的 Codex 能正常对话，再安装并启动：

```bash
npm install --global codrive@latest
codrive --version
codrive setup
codrive
codrive status
```

需要 Node.js 24+ 和 Git。`setup` 安装随包 Skills 和活动 Hook；首次提示 Hook 待审阅时，在 Codex 中运行 `/hooks` 审核四条 Codrive 活动定义，再执行 `codrive doctor`。看板地址由启动命令输出。完整交接步骤见[Mac mini 安装与验收说明](mac-mini-install.md)。

开发源码时，准备 Node.js 24 和项目声明的 pnpm 版本，在仓库目录执行：

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm exec codex login
node dist/interfaces/cli/index.js setup
node dist/interfaces/cli/index.js start
node dist/interfaces/cli/index.js status
```

源码运行使用 `node dist/interfaces/cli/index.js` 替代下文的 `codrive`。目标 Mac 使用 Codex 桌面应用管理原生定时计划。

`setup` 默认将四个既有 Skills 安装到 `~/.agents/skills/`。下文直接调用其中的脚本，也可以在 Codex 对话中要求它使用对应 Skill 完成配置。普通查询与报告直接由当前会话完成，工程工作才登记到看板。

## 创建自己的 Slack 应用

在 [Slack 应用管理](https://api.slack.com/apps) 创建应用并选择自己的工作区，可直接导入[JSON 模板](slack-app-manifest.json)，或使用下面的 manifest。应用头像可以使用[随包头像](../assets/codrive-slack-avatar.png)。

```yaml
display_information:
  name: Codrive
  description: 本机 Codex 助理与工程工作交付
features:
  bot_user:
    display_name: Codrive
    always_online: false
  app_home:
    home_tab_enabled: false
    messages_tab_enabled: true
    messages_tab_read_only_enabled: false
  slash_commands:
    - command: /new
      description: 在私信中开启一个全新的会话
      should_escape: false
    - command: /model
      description: 查看或切换当前项目使用的模型
      usage_hint: '[model-id]'
      should_escape: false
    - command: /models
      description: 列出当前可切换模型及当前、备用模型
      should_escape: false
    - command: /state
      description: 查看当前会话模型、权限和上下文用量
      should_escape: false
  shortcuts:
    - name: 查看 Codrive 状态
      type: message
      callback_id: codrive-status
      description: 查看这条消息所属会话的模型与上下文状态
oauth_config:
  scopes:
    bot:
      - chat:write
      - im:history
      - channels:history
      - groups:history
      - channels:read
      - groups:read
      - channels:manage
      - groups:write
      - commands
      - files:read
      - files:write
settings:
  socket_mode_enabled: true
  interactivity:
    is_enabled: true
  event_subscriptions:
    bot_events:
      - message.im
      - message.channels
      - message.groups
```

在应用设置中完成以下配置：

1. 开启 Socket Mode，在 Basic Information 的 App-level tokens 中生成带 `connections:write` 的 app token，形如 `xapp-…`。
2. 将应用安装到工作区，取得 Bot User OAuth Token，形如 `xoxb-…`。事件和权限变化后重新安装或授权，使新权限生效。
3. 保持 App Home 的 Messages 页开启且允许用户输入，使你能直接给机器人发私信。
4. 已有项目频道中邀请机器人；也可以私信机器人创建频道，它会通过 API 创建、邀请本人并完成绑定。公开和私有频道分别使用对应的普通消息事件，频道成员关系决定机器人能看到哪些消息。

Socket Mode 由 Mac 主动建立出站连接，不需要为本机暴露公网回调地址。`app_mention` 不是免艾特接收的前提，本配置用 `message.*` 处理普通消息。

通过 API 创建并邀请成员到公开频道需要 `channels:manage`，私有频道需要 `groups:write`。已有应用补上权限后重新安装授权，原 Token 是否继续有效以 Slack 的实际返回为准；需要更换时在本机设置页更新。权限不足时按具体错误补授权，创建频道本身不需要屏幕录制、辅助功能权限或解锁 Mac。

## 配置本地连接

打开本机看板的 **运行设置 → Slack**，填写并保存连接配置。页面可显示已配置、连接成功或实际错误，Token 输入框使用密码样式，保存成功后清空；同工作区修改设置时，空白 Token 保留本机原值。切换工作区时输入新的两个 Token。

| 设置项 | 去哪里取得 |
| --- | --- |
| 工作区 ID | Slack 客户端链接中的 `T…` |
| 授权成员 ID | 本人 Slack 个人档案菜单中的“复制成员 ID”，形如 `U…`；使用本人身份 |
| Bot Token | Slack 应用的 OAuth & Permissions / Install App，形如 `xoxb-…` |
| App Token | Basic Information → App-Level Tokens，权限 `connections:write`，形如 `xapp-…` |

真实 Token 只在本机私有配置 `~/.codrive/config.json` 中保存（`0600`）；自定义 `CODEDRIVE_HOME` 时位于该状态目录。读取设置的 API 和页面只返回脱敏状态。Git 仓库与随包模板保存占位值。

让 AI 自动配置时，也可以用本地编辑器准备仅自己可读的文件，例如 `~/.codrive/slack-setup.json`：

```json
{
  "enabled": true,
  "teamId": "T_WORKSPACE_ID",
  "authorizedUserId": "U_YOUR_MEMBER_ID",
  "botToken": "xoxb-your-bot-token",
  "appToken": "xapp-your-app-token"
}
```

通过文件传入凭据，避免 Token 出现在命令行参数和 shell 历史中：

```bash
chmod 600 "$HOME/.codrive/slack-setup.json"
node "$HOME/.agents/skills/codrive-control/scripts/codrive-control.mjs" slack-configure --json-file "$HOME/.codrive/slack-setup.json"
node "$HOME/.agents/skills/codrive-control/scripts/codrive-control.mjs" slack-status
```

配置命令发送到本机已鉴权的 Codrive 服务；返回脱敏连接状态和项目绑定，不打印 Token。设置文件和本机状态目录保存在自己的 Mac，项目仓库只保存操作说明。

迁移到 Mac mini 时，可复用已创建的 Slack 应用；先停止旧机器上的 Codrive，再在新机器填写连接配置。一个机器人由一台服务接收消息，避免两台机器同时连接后分走事件。项目目录在新 Mac 上重新登记和绑定，不整份覆盖含旧路径的本机配置。

## 登记项目与绑定频道

已有 Codrive 项目可以直接绑定。仅准备查询数据或接收报告的新项目，可以先用 `codrive-forge` 登记产品事实、仓库目录和默认分支，传入 `tasks: []` 并省略 `milestones`；它不会因此生成开发目标。需要工程工作时再用 `codrive-work` 追加任务。

私信是全局会话，使用独立的 `~/.codrive/assistant` 作为工作目录；自定义 `CODEDRIVE_HOME` 时使用该目录下的 `assistant/`。每轮获得分开的本机工作空间目录与 Codrive 产品登记，定位目标后再读取对应 README、AGENTS 和本地 Skills；涉及 Codrive 项目管理时使用现有控制命令。同目录里的不同产品分别保留身份，例如工作空间 `pietra-ai-workspace` 与产品 `Pietra Social / Pulse`。只有对应工作空间尚未登记时，才为它登记空任务项目。

项目资料中的 **Slack 频道** 显示该项目实际保存的绑定和频道链接；未绑定时显示“此项目尚未绑定 Slack 频道”。运行设置只展示连接生命周期的错误，单次频道命令被拒绝时在原命令中说明。

可以直接私信机器人：

> 把 `#my-project` 绑定到本机的“我的项目”。

需要新建频道时，可以说：

> 为本机工作空间 `pietra-ai-workspace` 创建同名私有频道，并把我邀请进去、绑定到这个工作空间。

机器人会用现有项目和可访问频道核对目标，有歧义时请你选择。也可以通过脚本取得实际 ID 后绑定：

```bash
node "$HOME/.agents/skills/codrive-control/scripts/codrive-control.mjs" local-projects
node "$HOME/.agents/skills/codrive-control/scripts/codrive-control.mjs" board
node "$HOME/.agents/skills/codrive-control/scripts/codrive-control.mjs" slack-channels
node "$HOME/.agents/skills/codrive-control/scripts/codrive-control.mjs" slack-bind project_id --json '{"channelId":"C_CHANNEL_ID"}'
node "$HOME/.agents/skills/codrive-control/scripts/codrive-control.mjs" slack-create-channel project_id --json '{"name":"my-project","isPrivate":true}'
```

创建命令先核实 Codrive 项目，再创建频道、邀请已配置的授权用户，最后保存绑定。回执返回实际频道和绑定；重复执行已成功的同名绑定会复用原频道。重名时先核实可访问频道，避免误绑其他项目。若频道已创建但后续邀请或绑定失败，保留错误回执中的 `channelId`，在同一命令 JSON 中附上它继续办理。

绑定后，在项目频道直接发一条文字消息。机器人在这条消息下面的讨论串回复；在串内追问会继续同一会话，频道内另一条新的根消息建立另一个会话。私信保持全局交流，你可以在其中查询整体情况、管理绑定或明确指定项目办事。

## Slack 命令与文件传输

`/new` 在机器人私信中开启新的原生会话，后续消息从新上下文开始，旧原生会话仍保留。当前私信有待处理或运行中的消息时先等其结束。频道里每条新的根消息已经是独立会话，直接发新消息即可。

`/models` 列出本机 Codex 当前目录中可切换的主模型，给出模型名称和 ID，标明当前模型与备用模型。列表仅本人可见；私信按全局默认、绑定频道按项目显示。

`/model` 打开原生模型下拉菜单，也可输入 `/model <model-id>`。私信中设置全局默认模型，已绑定频道中设置该项目模型；当前正在运行的回合保持原模型，下一回合生效。模型来自本机 Codex 的实际目录，备用模型保留，旧菜单遇到频道改绑会要求重新打开。

Slack 拒绝将自定义命令命名为 `/status`，状态入口采用不带前缀的 `/state`。`/state` 在私信中显示全局会话；频道中让你选择具体讨论串。也可从任意已关联消息的菜单执行「查看 Codrive 状态」，直接定位该消息所属会话。它显示模型、推理强度、实际访问权限及审批策略，以及取得的累计和最近一轮 token 用量。用量、窗口和权限没有实际快照时显示暂无；上下文余量有依据时标为估算，服务重启后等待新的用量事件，不伪装成桌面端的精确余额。

在机器人私信或绑定频道上传图片、文档、表格等文件即可。纯文件消息也会接收；授权和频道身份核实后下载到本机状态目录的 `slack/files/`，消息中的本机路径交给 Codex 读取。图片使用原生看图工具，其余文件按类型处理；用户资料继续留在本机，Slack 私有下载地址不会写入会话收件记录。

AI 生成文件后，通过现有 Control 脚本发回原私信或讨论串：

```text
node <codrive-control-skill>/scripts/codrive-control.mjs slack-send-file --json '<file-json>'
```

```json
{
  "replyTarget": { "kind": "slack", "teamId": "T_WORKSPACE_ID", "channelId": "C_CHANNEL_ID", "threadTs": "原根消息位置" },
  "filePath": "/absolute/path/report.csv",
  "title": "数据报告",
  "comment": "本次查询结果。"
}
```

`replyTarget` 取自当前输入；一对一私信可没有 `threadTs`。成功回执提供真实文件 `id` 和可用的链接。文件上传为显式操作，失败后核实回执再重试；它不沿用文字报告的持久自动补送，失败不会重新运行开发工作。

## 用 Codex 原生定时任务检查和报告

定时计划在 Codex 原生界面创建和管理。本项目提供报告发送和工作登记能力，不保存第二份周期定义。定时提示词可以按下面的场景表达：

```text
每天北京时间上午九点，在“我的项目”的本机仓库中执行约定的服务检查。

只做本次检查需要的操作，记录操作、预期结果、实际结果以及已取得的直接证据。原因调查和代码修改交给后续 Codrive 开发工作。

使用 $codrive-control 把报告发送到这个项目绑定的 Slack 频道，为本次报告生成稳定 requestId，并在同次操作重试时复用。

如果检查观察到异常，先取得 Slack 报告成功回执，再使用 $codrive-work 以“调查异常并恢复既有行为”为目标登记任务；把报告回执中的 source 和 replyTarget 原样带入任务。任务文档保留客观现象，根因未知不影响登记。由 Codrive 开发、审查并完成后续交付。

如果检查正常，直接发报告后结束，不创建开发任务。
```

例如，检查结果写“使用测试账号提交登录，预期进入首页，实际仍停留在登录页”，并附已有的直接响应或截图链接；开发阶段再确认原因。

报告命令使用现有 Control 脚本：

```text
node <codrive-control-skill>/scripts/codrive-control.mjs slack-report <project-id> --json '<report-json>'
```

```json
{
  "requestId": "<stable-report-request-id>",
  "markdown": "## 服务检查\n\n使用测试账号提交登录。预期进入首页，实际仍停留在登录页。",
  "source": {
    "kind": "codex_native",
    "requestId": "<stable-report-request-id>"
  }
}
```

以退出码 `0`、`ok: true` 和 `result` 中真实的 `messageTs`、`source`、`replyTarget` 为发送成功依据。消息发送成功后才登记工程工作，`codrive-work` 的任务文档和登记命令沿用现有形式。消息已发送但登记失败时，保留并复用该位置；同次登记重试保留来源请求身份。

工程工作的进展、待决定问题、失败和最终交付结果由 Codrive 回到保存的 Slack 位置。明确 Bug 在既有授权内自主修复上线；需要你看效果的工作会先给出已审查候选的可用预览，收到有效确认后才合入发布。发布与线上核实属于该项工作的完成目标，单纯合入不会冒充已上线。

## 日常检查与运行条件

首次接入时，实际检查以下场景：

- 私信机器人查询已有项目，并完成一次频道绑定。
- 在两个已绑定频道分别发送未艾特的普通查询，结果在各自消息讨论串出现。
- 在一个讨论串继续追问，再发另一条根消息，确认上下文彼此独立。
- 用原生定时任务发送普通报告，确认没有产生开发任务；观察到异常时检查先有事实消息、后有带来源的工程任务。
- 验证明确故障的完整交付，以及需要预览确认的工作在确认前保持未合入。

Mac 保持用户登录、唤醒和联网，Codex 桌面应用及 Codrive 服务均运行。`codrive` 在后台启动服务；启动、停止、重启和升级由现有 CLI 管理。另接 `launchd` 时，应先统一停止与升级的生命周期，避免外部守护程序立即拉起正在主动停止的旧进程。

收不到频道消息时，用 `slack-status` 查看连接与绑定，核对授权成员、机器人是否已入频道、普通消息事件及安装后的实际权限。只有私信能收、频道必须艾特才能收时，优先检查 `message.channels` / `message.groups` 的订阅与相应 history 权限。应用权限变化需要重新授权，普通频道消息不能只依赖 `app_mention`。

通知发送失败与开发结果分别记录。恢复通知只补送结果，不重新修复或发布；已有工作的回复位置保持登记时的值，项目频道后来改绑不会搬走旧工作。
