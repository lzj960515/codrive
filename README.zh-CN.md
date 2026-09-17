<div align="center">
  <h1>Codrive</h1>
  <p><strong>面向 Codex App 的自动任务管理工具。</strong></p>

  <p>
    <a href="https://www.npmjs.com/package/codrive"><img alt="npm version" src="https://img.shields.io/npm/v/codrive?style=flat-square&color=cb3837"></a>
    <a href="https://github.com/lzj960515/codrive/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/lzj960515/codrive/ci.yml?branch=main&style=flat-square&label=ci"></a>
    <a href="https://www.npmjs.com/package/codrive"><img alt="Node.js version" src="https://img.shields.io/node/v/codrive?style=flat-square&color=43853d"></a>
    <a href="./LICENSE"><img alt="MIT License" src="https://img.shields.io/github/license/lzj960515/codrive?style=flat-square&color=2d5b46"></a>
  </p>

  <p><a href="./README.md">English</a> · <strong>简体中文</strong></p>
</div>

## Codrive 是什么？

Codrive 是运行在本机的 **Codex App** 任务管理工具。它将已确认的目标组织成里程碑和任务，自动推进执行、独立审查与验收，并通过看板展示进度。

<p align="center">
  <img src="https://raw.githubusercontent.com/lzj960515/codrive/main/docs/images/codrive-board.jpg" alt="Codrive 看板：里程碑、任务与活动记录">
</p>

## 为什么使用 Codrive？

- **自动推进：** 根据目标拆解和安排任务，小改动也可独立执行。
- **动态规划：** 根据新发现补充任务、调整计划，超出授权范围时请求你的决定。
- **独立审查：** 每份工作结果经过独立审查，里程碑按验收证据确认完成。
- **过程可见：** 看板汇总进度，项目对话保留规划、执行和审查过程，支持随时参与。

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

需要你决定时，可以点击看板上的 **在此回复**，填写意见并发送到原对话。发送成功后弹窗关闭，任务继续执行；也可以使用旁边的对话入口查看完整上下文。

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
