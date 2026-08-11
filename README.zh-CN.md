<div align="center">
  <h1>Codrive</h1>
  <p><strong>把一个产品想法，持续变成你可以看见的 Codex 任务。</strong></p>
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

Codrive 是一个轻量的本机服务，用来连接 Codex App 任务、本地任务看板、文件系统产品状态和可复用 Skills。

你只需要在 Codex App 里描述想做的产品。Codex 会把想法整理成产品计划并注册到 Codrive，然后在独立、可见的任务中逐项开发。每一轮审查都会启动全新的独立任务；审查要求修改时，Codrive 让原开发任务继续返工；审查通过后，Codex 自己完成合入，Codrive 再启动下一项真正有价值的工作。

Codrive 不是另一个大模型，也没有重新实现编码智能体。它只是在普通 Codex 主智能体周围提供一个小而可靠的长期产品开发工作流。

> **一个命令，所有状态留在本机，不需要基础设施。** Codrive 不依赖 Docker、PostgreSQL、Redis 或云端服务。

## 为什么使用 Codrive？

- **工作过程可见。** 开发和审查任务会出现在 Codex App 中，而不是藏在后台工作进程里。
- **上下文保持专注。** 每个任务只有一个长期开发任务，每轮审查都使用全新的独立上下文。
- **判断继续交给 Codex。** Codex 决定哪些工作可以并行，并负责理解仓库、开发、测试、审查、解决冲突和合入。
- **流程自动向前推进。** 已选任务会连续进入开发、审查、返工和合入；规划事实变化后，Codrive 再判断新的 backlog 工作。
- **所有信息留在本机。** 产品文档、任务状态、执行历史和访问凭据都保存在用户电脑上。

## 快速开始

你需要 Node.js 20 或更高版本、Git，以及 `~/.codex` 中可用的 Codex 登录状态。

先把 Codrive 安装为当前 Node.js 版本下的全局命令，然后启动后台服务：

```bash
npm install --global codrive@latest
codrive
```

如果你以前一直使用 `npx codrive@latest`，也可以用一次临时命令完成全局安装、升级和重启：

```bash
npx codrive@latest upgrade
```

Codrive 会输出本地看板地址和日志文件位置。用浏览器打开后，按照首次运行提示完成初始化：

1. 点击 **安装 Skills**，把四个 Codrive Skills 安装到本机智能体技能目录。
2. 通常可以先创建产品目录，再用 Codex App 打开这个目录。
3. 直接用自然语言描述产品，例如：

```text
用 Codrive 的方式帮我把这个贪吃蛇游戏整理成计划，我确认后开始开发。
```

选择 **Later** 后，看板左下角会保留一个 Skills 初始化按钮。未来版本内置的 Skills 发生变化时，看板也会再次提示更新。

看板提供**运行设置**页面，可以配置每个项目的并发上限、默认模型和 fallback 模型。点击产品标题可以进入产品详情页，查看注册仓库、完整 `PROJECT.md`、规划决定、产品上下文、任务清单和当前执行信息。

## 工作方式

![Codrive 产品轮转与调度架构](https://raw.githubusercontent.com/lzj960515/codrive/main/docs/architecture/codrive-orchestration.png)

[查看可编辑的 draw.io 源图](https://github.com/lzj960515/codrive/blob/main/docs/architecture/codrive-orchestration.drawio)

Codrive 负责确定性的部分：持久化生命周期状态、执行尝试、Codex 任务 ID、每个项目的并发上限，以及同一个仓库一次只合入一个任务。Codex 负责需要判断的部分：选择任务、实现、审查、返工、Git 操作、冲突解决、合入和产品验收。

任务选择不是预先固定的依赖图。项目注册、完整任务完成、任务取消、新增工作、产品决定、并发配置变化或人工重新规划时，Codrive 为项目创建新的规划版本。一个临时 Codex 任务读取当时全部 backlog、活动任务、产品和仓库事实，并可在该项目当轮固定容量内一次选中多个适合独立开始的任务。少于容量的选择也代表全部 backlog 已经检查完毕；单纯出现空闲位置不会重复询问 AI。

Codrive 先推进已有任务的下一阶段，再进行产品验收，最后才为未评估的规划版本选择 backlog。开发完成会立即创建独立审查，审查后的返工或合入继续原任务流水线。任务等待输入或阻塞时保留当前规划版本；同轮已经选中的其他任务仍可开始，没有其他已选任务时看板会显示等待原因和下一行动。每个项目默认最多同时运行四个任务，互不占用其他项目的容量；同一个仓库仍然一次只合入一个任务。

模型容量不足现在是可恢复的执行状态，不会立即把任务标记为阻塞。Codrive 保留当前阶段、attempt 和原对话，分别在 5 秒、10 秒、20 秒后使用默认模型重试；仍无容量时，为该执行切换到配置的 fallback 模型，并提供同样的三次重试预算。只有 fallback 也耗尽后才进入阻塞。等待重试的状态会跨服务重启持久化，继续占用所属项目的容量，并在项目暂停期间保持等待。

Codrive 每分钟还会进行一次范围很小的自动恢复检查：发送正在等待对话空闲的任务消息，并恢复长时间没有结果的 AI 工作。模型容量重试按照持久化的精确截止时间执行，不依赖分钟扫描。运行中的项目完全没有 Codex 工作时，恢复器只启动尚未评估的规划版本；已经保存的选择、等待决定或阻塞结果不会重复调用 AI。App Server 仍报告为 `inProgress` 的回合会保留当前 attempt 并续租；只有确认不存在或已经终止的回合才会创建替代 attempt。服务启动时会先完成恢复，再开放控制命令，避免用户重试与启动恢复竞争。

## Codex 任务关系

| 工作阶段 | Codex 任务行为 |
| --- | --- |
| 开发 | 每个看板任务拥有一个长期 Codex 任务 |
| 返工 | 继续原开发任务 |
| 合入 | 继续原开发任务 |
| 审查 | 每一轮都创建全新的独立任务 |
| 任务选择与产品验收 | 使用临时任务，不占据最近任务列表 |

所有持久任务都归属到 Codex App 中的产品仓库。Codex 通过 `$codrive-task` 读取任务记录的工作树，并在其中完成开发、审查、返工和合入，让 App 中的项目可见性与隔离代码执行各自保持清晰。

同一个任务对话同一时间只运行一个 Codex 回合。Codrive 在已有对话中继续开发、返工、合入、恢复或请求汇报前，会先等待对话空闲；对话空闲后立即继续，每分钟的自动恢复检查负责补上遗漏的触发。

看板会提供开发和审查任务的直接入口。暂停后的项目明确显示“已暂停”；已有 turn 尚未结束时显示“执行中 · 后续已暂停”。Planner 输出作为完整的“调度说明”独立展示，不再与产品状态混在一起。如果 Codex 需要产品决策，看板会显示问题并引导你回到对应的 Codex 任务；Codrive 不会再造一个聊天界面。

## 内置 Skills

| Skill | 用途 |
| --- | --- |
| `$codrive-forge` | 把产品想法整理为经过确认的产品计划和初始任务 |
| `$codrive-task` | 执行当前开发、审查、返工、合入或验收阶段 |
| `$codrive-work` | 为现有产品增加新需求、里程碑或下一轮工作 |
| `$codrive-control` | 查看进度，暂停、恢复、重试、重新规划或取消，并记录产品决策 |

Skills 会主动从 Codrive 读取当前项目和任务上下文，因此自动任务消息保持简短，不会反复注入完整产品说明。

重试、重新规划和取消表达不同的生命周期语义。任务或项目执行失败且仍保留待执行动作时，重试会创建新的 attempt；规划事实明确变化后，重新规划会增加规划版本；等待用户输入的任务在原对话中继续同一个 attempt；取消会永久终止任务或项目。

Codex 会在执行取消前判断取消依据。取消涉及产品取舍、停止范围或现场保留方式时，Codex 先提交 `needs_input`，在原对话中提问；用户明确答复后，再以 `user_confirmed` 取消。仓库和任务事实已经足以支持取消时，Codex 可以用 `agent_decision` 直接取消。每次取消都必须提供具体理由，并记录执行者、判断依据和时间。看板不承担取消审批，只展示取消终态事实，并把此前的报告保留为“取消前进展”。

## 常用命令

```text
codrive                         在后台启动 Codrive 和本地看板
codrive restart                 重启 Codrive
codrive stop                    停止 Codrive
codrive upgrade                 全局安装最新版本并用新版本重启
codrive status                  查看本地服务状态
codrive doctor                  检查 Node.js、Codex 和登录状态
codrive setup                   不经过 Web 提示，直接安装 Skills
codrive serve                   在前台运行，供开发和进程托管器使用
```

运行日志写入 `~/.codrive/codrive.log`。终端和日志文件使用同一份本机时区时间，除 HTTP 错误和 Codex App Server 标准错误外，还会记录结构化生命周期事件，包括命令与关联 ID、来源、项目和任务 ID、attempt/thread/turn ID、恢复器观测与决策、精简的状态迁移、结果和耗时。高频文本与命令输出 delta 不进入 lifecycle 日志。当前日志达到约 10 MB 时轮转；一份 `codrive.log.1` 归档最多保留最近 10 MB 的完整日志行，最长保留 7 天，默认总占用约 20 MB。日志不复制 prompt、聊天正文或报告正文。每个项目的 `events.ndjson` 继续作为持久审计历史。

## 安全模型

Codrive 的 HTTP API 只监听 `127.0.0.1`，本地 API 请求使用随机访问令牌保护。自动 Codex 任务使用 `approvalPolicy: "never"` 和完整本机访问权限运行，从而可以连续创建工作树、修改文件、测试、提交、解决冲突、合入并清理现场，无需等待终端审批。

请只注册你信任的仓库和产品指令。Codrive 不开放远程监听地址，也不会把任务数据库发送到 Codrive 云端服务。

## 参与开发

Codrive 使用 Node.js 24 和 pnpm 11.5.1 进行开发，发布包兼容 Node.js 20 及以上版本。

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
