<div align="center">
  <h1>Codrive</h1>
  <p><strong>把产品工作，持续变成你可以看见的 Codex 任务。</strong></p>
  <p>在本机自动推进产品规划、开发、独立审查、返工与合入。</p>

  <p>
    <a href="https://www.npmjs.com/package/codrive"><img alt="npm 版本" src="https://img.shields.io/npm/v/codrive?style=flat-square&color=cb3837"></a>
    <a href="https://github.com/lzj960515/codrive/actions/workflows/ci.yml"><img alt="持续集成" src="https://img.shields.io/github/actions/workflow/status/lzj960515/codrive/ci.yml?branch=main&style=flat-square&label=ci"></a>
    <a href="https://www.npmjs.com/package/codrive"><img alt="Node.js 版本" src="https://img.shields.io/node/v/codrive?style=flat-square&color=43853d"></a>
    <a href="./LICENSE"><img alt="MIT 许可证" src="https://img.shields.io/github/license/lzj960515/codrive?style=flat-square&color=2d5b46"></a>
  </p>

  <p><a href="./README.md">English</a> · <strong>简体中文</strong></p>
</div>

<p align="center">
  <img src="https://raw.githubusercontent.com/lzj960515/codrive/main/docs/images/codrive-board.jpg" alt="包含示例项目和任务详情的 Codrive 本地产品看板">
</p>

## Codrive 是什么？

Codrive 是一个轻量的本机服务，用来连接 Codex App 任务、产品看板、文件系统状态和可复用 Skills。你在 Codex App 中描述产品目标并确认计划后，Codrive 会持续推动任务完成开发、独立审查、返工和合入。

Codex 仍然负责理解仓库、编写和审查代码、运行测试、解决冲突与做出产品判断。Codrive 为这些工作提供持久流程：任务状态、隔离对话、调度、恢复和清晰的活动历史。

> **一个命令，所有状态留在本机，不需要基础设施。** Codrive 不依赖 Docker、PostgreSQL、Redis 或云端服务。

## 为什么使用 Codrive？

- **工作过程可见。** 每个开发和审查任务都会出现在 Codex App 中。
- **上下文保持专注。** 开发和审查使用独立对话；同一任务的 Review 对话会跨审查轮次延续。
- **交付持续推进。** 审查通过后进入合入，要求修改时回到原开发对话返工。
- **规划随事实变化。** Codex 根据当前产品与仓库事实选择工作，不依赖固定依赖图。
- **数据留在本机。** 产品文档、任务状态、执行历史和访问凭据都由用户持有。

## 快速开始

你需要 Node.js 24 或更高版本、Git，以及 `~/.codex` 中可用的 Codex 登录状态。

```bash
npm install --global codrive@latest
codrive
```

Codrive 会输出本地看板地址和日志位置。打开看板后：

1. 在 **Codrive 更新**窗口中点击**补齐托管 Skills**。
2. 用 Codex App 打开目标项目目录。
3. 描述产品工作，并让 Codex 使用 Codrive 推进。

```text
用 Codrive 的方式给这个项目增加排行榜功能，我确认计划后开始开发。
```

Codrive 常驻运行时会约每小时检查一次 npm latest 稳定版。已经打开的看板无需刷新就能收到检查结果；发现新版本后会显示更新提示。点击**重新检查**可以立即刷新状态，并从本次检查重新开始一小时周期。

更新窗口会展示当前版本、最新稳定版、最后检查时间和四个托管 Skills 的状态。自动检查只更新这些状态，安装仍需用户明确确认。确认后，窗口可以安装指定版本、重启本地服务、同步随包 Skills，并验证升级结果。对应的终端命令是：

```bash
codrive upgrade
```

看板还提供运行设置，用于调整每个项目的并发上限、默认模型和 fallback 模型。

## 工作方式

![Codrive 产品轮转与调度架构](https://raw.githubusercontent.com/lzj960515/codrive/main/docs/architecture/codrive-orchestration.png)

1. **规划。** Codex 把产品目标整理为任务，并根据最新产品与仓库事实选择下一批工作。
2. **开发。** 每个选中任务在自己的长期 Codex 对话和隔离 Git 工作树中推进。
3. **审查。** 第一轮审查创建独立 Review 对话，后续复审继续该对话；发现问题后，原开发对话依据证据返工。
4. **合入。** 审查通过后由原任务对话完成合入，同一个仓库每次只合入一个任务。

Codrive 持久化生命周期状态并执行调度边界，Codex 负责需要判断的工作。各项目拥有独立并发上限；只有规划事实变化时才重新选择任务，而不是每次出现空闲位置都询问模型。

Review finding 表达受支持产品与运维路径中的真实交付阻塞，不是要求开发无条件执行的返工指令。开发对话会修复成立的问题，或为不适用的 finding 记录反证；同一个独立 Review 对话随后结合当前候选与这些证据重新判断。

等待与恢复也属于同一套流程。任务可以等待到指定时间而不占用项目容量；模型容量不足时可以切换 fallback；中断的工作可以从持久化的原对话和执行状态继续。任务时间线会记录这些变化，只把需要用户处理的决定或失败置顶展示。

## Codex 任务关系

| 工作阶段 | Codex 任务行为 |
| --- | --- |
| 开发 | 每个看板任务拥有一个长期 Codex 任务 |
| 返工 | 继续原开发任务 |
| 合入 | 继续原开发任务 |
| 审查 | 每个看板任务拥有一个独立且长期的 Review 任务 |
| 任务选择 | 使用临时任务，不占据最近任务列表 |

任务详情会把每次执行和活动链接到来源对话，并在同一条时间线中展示阻塞、计划继续、请求决定、测试证据、审查发现和 Git 结果。

## 内置 Skills

| Skill | 用途 |
| --- | --- |
| `$codrive-forge` | 把产品想法整理为经过确认的计划和初始任务 |
| `$codrive-task` | 选择项目工作，或执行任务当前阶段 |
| `$codrive-work` | 为现有产品增加需求、里程碑或下一轮工作 |
| `$codrive-control` | 查看进度并控制项目或任务执行 |

Skills 会从 Codrive 读取实时上下文，因此任务消息保持简短，不同对话中的产品状态也能保持一致。

## 常用命令

```text
codrive                         在后台启动 Codrive 和本地看板
codrive start                   在后台启动 Codrive
codrive stop                    停止 Codrive
codrive restart                 重启 Codrive
codrive upgrade                 安装最新版本并重启
codrive status                  查看本地服务状态
codrive setup                   安装或补齐托管 Skills
codrive doctor                  检查 Node.js、Codex 和登录状态
codrive import <project.json>   导入产品
codrive serve                   在前台运行
codrive --version               显示当前安装版本
```

## 本地数据与安全

Codrive 默认把状态和日志保存在 `~/.codrive`。产品事件日志只追加写入；`codrive.log` 记录运行生命周期，不包含 prompt、聊天正文或报告正文。

HTTP API 只监听 `127.0.0.1`，并使用随机访问令牌。自动 Codex 任务拥有完整本机访问权限，可以连续修改、测试、提交、合入和清理代码，无需等待终端审批。请只注册你信任的仓库和产品指令。

## 参与开发

Codrive 使用 Node.js 24 或更高版本和 pnpm 11.5.1。

```bash
corepack enable
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm dev
```

## 许可证

[MIT](./LICENSE)
