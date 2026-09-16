<div align="center">
  <h1>Codrive</h1>
  <p><strong>交代目标，让 Codex 持续推进。</strong></p>

  <p>
    <a href="https://www.npmjs.com/package/codrive"><img alt="npm version" src="https://img.shields.io/npm/v/codrive?style=flat-square&color=cb3837"></a>
    <a href="https://github.com/lzj960515/codrive/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/lzj960515/codrive/ci.yml?branch=main&style=flat-square&label=ci"></a>
    <a href="https://www.npmjs.com/package/codrive"><img alt="Node.js version" src="https://img.shields.io/node/v/codrive?style=flat-square&color=43853d"></a>
    <a href="./LICENSE"><img alt="MIT License" src="https://img.shields.io/github/license/lzj960515/codrive?style=flat-square&color=2d5b46"></a>
  </p>

  <p><a href="./README.md">English</a> · <strong>简体中文</strong></p>
</div>

Codrive 让 **Codex App** 围绕目标持续工作。你确认范围，Codex 负责规划、执行、审查和验收；你通过本地看板了解进度，在需要决定时参与对话。

<p align="center">
  <img src="https://raw.githubusercontent.com/lzj960515/codrive/main/docs/images/codrive-board.jpg" alt="Codrive 看板：里程碑、任务与活动记录">
</p>

## 如何推进工作

- **围绕目标规划。** 里程碑明确结果与验收标准，由 Codex 调查并拆解任务；小改动可以独立推进。
- **随发现调整计划。** 在已确认范围内补充调查、追加任务或调整计划，超出范围的决定交给你。
- **独立审查，按证据验收。** 每份工作结果都经过独立审查，里程碑满足验收标准后才完成。
- **随时参与。** 规划、执行和审查都保留在项目对话中，你可以查看过程、补充背景或接手讨论。

## 开始使用

需要 **Node.js 24+、Git、Codex App**，并完成 Codex 登录。

```bash
npm install --global codrive@latest
codrive setup
codrive
```

`setup` 安装随包提供的 Skills 和活动 Hook，启动后终端会显示看板地址。

1. 在 Codex 中运行 `/hooks`，审核并信任四条 Codrive 活动 Hook 定义。
2. 用 Codex App 打开项目，说明你的目标：

   > 用 Codrive 规划并推进这项工作，开始前先和我确认范围与验收标准。

后续也可以直接通过对话追加任务、调整计划、查询进度或暂停调度。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `codrive` | 启动本地服务 |
| `codrive status` | 查看服务状态 |
| `codrive stop` / `codrive restart` | 停止或重启 |
| `codrive upgrade` | 更新到最新版本 |
| `codrive doctor` | 检查环境与安装配置 |

## 本地运行

Codrive 安装后即可在本机使用，项目与任务记录保存在本机。AI 请求由你配置的 Codex 模型服务处理。

**自动任务拥有完整本机访问权限**，可以修改文件、执行命令和 Git 操作，无需逐次终端审批。请在可信仓库中使用，并明确工作的授权范围。

## 参与开发

使用 Node.js 24+ 和 pnpm 11.5.1：

```bash
corepack enable
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm dev
```

进一步了解：[里程碑与规划](./docs/architecture/milestones.md) · [产品事实](./docs/architecture/product-facts.md) · [看板同步](./docs/architecture/realtime-sync.md) · [Semantic Atlas 集成](./docs/architecture/semantic-atlas-maintenance.md)。

[MIT 许可证](./LICENSE)
