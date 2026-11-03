# 在 Mac mini 安装和启动 Codrive

可以把本页链接和末尾的安装指令交给 Mac mini 上的 AI。目标是使用 npm 正式包安装 Codrive，复用这台 Mac 已配置好的 Codex，接通 Slack 并取得实际验收结果。Slack 能力需要 Codrive 0.15.0 或以上。

## 安装前准备

- Mac 已登录用户，准备 Node.js 24+、npm 和 Git；缺少时使用这台机器已有的正常安装方式补齐。
- 这台 Mac 上的 Codex 能完成一次普通对话。Codrive 随包带有匹配版本的 Codex 命令行服务，使用本机 Codex 配置与凭据；已有 API 服务配置可以继续使用。
- 准备 Slack 工作区 ID、本人授权成员 ID、Bot Token `xoxb-…` 和 Socket Mode App Token `xapp-…`。需要新建应用时，按[Slack 接入说明](slack.md)导入[模板](slack-app-manifest.json)；已有机器人可以复用。
- 从旧 Mac 迁移同一个机器人时，先在旧机器执行 `codrive stop`；旧机器运行源码版时使用它的源码 CLI 停止。让一台机器负责该机器人的消息接收。

## 安装和启动

在 Mac mini 的终端依次执行：

```bash
node --version
git --version
npm install --global codrive@latest
codrive --version
codrive setup
codrive
codrive status
```

确认 Node 主版本至少为24，Codrive 版本至少为0.15.0。`setup` 安装四个 Skills 和一份活动 Hook；首次安装可能提示四条 Hook 定义待审阅，这表示资源已安装、信任尚未完成。在 Codex 中运行 `/hooks`，由本人审阅四条 Codrive 活动定义，再运行：

```bash
codrive doctor
```

账号登录或 Hook 审阅确实需要本人操作时，报告具体缺少的一步，保留已完成安装。继续使用正常登录和审阅入口，使 `doctor` 能确认实际状态。

`codrive` 在后台启动服务，终端输出本机看板地址，例如 `http://127.0.0.1:<port>`。每次登录 Mac 后运行 `codrive` 即可启动；重复执行会复用已经运行的服务。保持机器唤醒和联网。Codex 原生定时计划由桌面应用管理和触发，需要该应用按其运行条件保持可用。

## 在网页填写 Slack Token

1. 在 Mac mini 的本机浏览器打开启动命令给出的看板地址。
2. 打开 **运行设置 → Slack**。
3. 填写工作区 ID 和本人的授权成员 ID。
4. 填写 Bot Token `xoxb-…`、App Token `xapp-…`，启用并保存连接。
5. 页面应显示已连接；失败时依据页面实际错误核对 Token、工作区和 Socket Mode 设置。

两个 Token 分别在 Slack 应用的 OAuth & Permissions / Install App 和 Basic Information → App-Level Tokens 获取；App Token 需要 `connections:write`。它们不是 Client Secret 或 Signing Secret。成员 ID 在本人个人档案菜单中复制，使用本人 ID，不填机器人 ID。

Token 保存在本机 `~/.codrive/config.json`，文件权限为 `0600`。使用 `CODEDRIVE_HOME` 时改为该目录下的配置文件。页面不回显 Token，保存成功后清空密码框；同工作区再次保存时留空会保留已配置 Token，切换工作区则填写新 Token。仓库和安装文档没有真实凭据。

页面在 Mac mini 本机打开；远程日常工作通过 Slack，无需把本机设置页公开到互联网。

## 让 AI 通过私有文件配置

也可以先把配置准备在 Mac mini 的本机私有文件中，再让 AI 读取该文件并执行配置。样例只含占位值：

```json
{
  "enabled": true,
  "teamId": "T_WORKSPACE_ID",
  "authorizedUserId": "U_YOUR_MEMBER_ID",
  "botToken": "xoxb-your-bot-token",
  "appToken": "xapp-your-app-token"
}
```

例如保存为 `~/.codrive/slack-setup.json`，然后执行：

```bash
chmod 600 "$HOME/.codrive/slack-setup.json"
node "$HOME/.agents/skills/codrive-control/scripts/codrive-control.mjs" slack-configure --json-file "$HOME/.codrive/slack-setup.json"
node "$HOME/.agents/skills/codrive-control/scripts/codrive-control.mjs" slack-status
```

以成功回执和 `connected: true` 确认连接；保持私有文件与 Token 在本机，命令行参数只传文件路径。两个配置入口写入同一份本机设置。

## 绑定项目和实际验收

将机器人邀请到准备使用的频道。先在新 Mac 上登记真实仓库目录；已有项目用现有 Codrive 项目，只做日常查询的新项目可以先登记空项目。直接私信机器人说明“把这个频道绑定到这个本机项目”，它会核对项目和频道后完成绑定。

依次验证：

1. 私信机器人发送一条简单消息，再追问上一条内容，确认连续会话。
2. 在绑定频道直接发消息，确认无需艾特、机器人回复原讨论串；同串追问保留前文，另一条根消息使用独立会话。
3. 执行 `/models` 查看模型名称和 ID，执行 `/model` 打开切换菜单，使用 `/state` 查看明确会话的模型、推理强度、权限和实际用量。频道状态命令先选择会话。
4. 上传一张测试图片或 CSV，让机器人读取并把结论保存成文件发回原讨论串。普通查询不创建工程任务。
5. 运行 `codrive status`、`codrive doctor`，记录服务地址、版本、连接和实际结果；将普通 Slack 验收与后续真实工程发布验收分别报告。

新机器上的仓库路径重新登记；保留旧机器状态作为原记录，不把含旧路径和旧本机访问凭据的 `config.json` 整份覆盖到新机器。

## 可以直接交给 AI 的安装指令

```text
请按这份 Mac mini 安装文档在当前机器安装 Codrive 正式版并完成验收。

先检查 Node.js 24+、Git、Codex 当前配置与对话能力，再通过 npm 安装 codrive@latest，确认版本至少0.15.0，运行 setup、启动服务和 doctor。

我会在本机设置页输入 Slack 连接资料，或提供本机私有 JSON 文件的路径。使用该入口配置；真实 Token 只留在本机私有配置，不写进仓库、文档或聊天回复。已有机器人从旧 Mac 迁移时，先确认旧服务已经停止，再让当前机器接收消息。

需要本人完成账号登录、Slack 安装授权或 Codex Hook 审阅时，明确给出具体操作，其余安装与检查继续推进。通过正常入口完成这些步骤。

登记当前机器的真实项目目录并绑定频道，实际验证私信、免艾特讨论串、模型和状态命令，以及图片/文件收发。最后报告实际版本、服务状态、配置入口、验收结果和剩余步骤。
```
