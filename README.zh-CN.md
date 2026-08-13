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

Codrive 是一个轻量的本机服务，用来连接 Codex App 任务、本地任务看板、文件系统产品状态和可复用 Skills。

无论是从一个想法开始，还是为现有项目增加功能、重构代码或安排显式验收，你只需要在 Codex App 里描述想完成的产品工作。Codex 会结合目标与仓库现状整理计划并注册到 Codrive，然后在独立、可见的任务中逐项推进。每一轮审查都会启动全新的独立任务；审查要求修改时，Codrive 让原开发任务继续返工；审查通过后，Codex 自己完成合入，Codrive 再启动下一项真正有价值的工作。

Codrive 不是另一个大模型，也没有重新实现编码智能体。它只是在普通 Codex 主智能体周围提供一个小而可靠的长期产品开发工作流。

> **一个命令，所有状态留在本机，不需要基础设施。** Codrive 不依赖 Docker、PostgreSQL、Redis 或云端服务。

## 为什么使用 Codrive？

- **工作过程可见。** 开发和审查任务会出现在 Codex App 中，而不是藏在后台工作进程里。
- **上下文保持专注。** 每个任务只有一个长期开发任务，每轮审查都使用全新的独立上下文。
- **判断继续交给 Codex。** Codex 决定哪些工作可以并行，并负责理解仓库、开发、测试、审查、解决冲突和合入。
- **流程自动向前推进。** 已选任务会连续进入开发、审查、返工和合入；规划事实变化后，Codrive 再判断新的 backlog 工作。
- **所有信息留在本机。** 产品文档、任务状态、执行历史和访问凭据都保存在用户电脑上。

## 快速开始

你需要 Node.js 24 或更高版本、Git，以及 `~/.codex` 中可用的 Codex 登录状态。

先把 Codrive 安装为当前 Node.js 版本下的全局命令，然后启动后台服务：

```bash
npm install --global codrive@latest
codrive
```

如果你以前一直使用 `npx codrive@latest`，也可以用一次临时命令完成全局安装、升级和重启：

```bash
npx codrive@latest upgrade
```

Codrive 会输出本地看板地址和日志文件位置。用浏览器打开后，使用左下角的 **Codrive 更新**窗口完成初始化：

1. 点击 **补齐托管 Skills**，把四个 Codrive Skills 安装到本机智能体技能目录。
2. 用 Codex App 打开现有项目目录；从零开始时，先创建并打开新的项目目录。
3. 直接用自然语言描述要推进的产品工作，例如：

```text
用 Codrive 的方式给这个项目增加排行榜功能，我确认计划后开始开发。
```

同一个窗口会展示当前运行版本、npm latest 稳定版、按浏览器本地时区显示的完整检查时间，以及四个托管 Skills 的对齐状态。页面加载只读取缓存；只有手动重新检查才等待 npm，因此 npm 超时、离线或返回无效响应不会阻塞看板和任务调度。

发现稳定版更新后，一次确认会固定本次目标版本，并启动独立的本机升级进程。窗口使用一条连续进度展示精确版本安装、新版 CLI 使用同一个 `CODEDRIVE_HOME` 重启服务和随包 Skills 同步；重启期间短暂断线是正常现象，页面会自动重连。只有 `/api/health` 回读到目标版本，并且四个托管 Skills 都与新包一致时，Codrive 才会报告整体成功。首次安装或历史升级中断造成 Skills 缺失时，也在这个窗口补齐。未托管的本地同名 Skill 永远不会被覆盖；窗口会显示具体冲突路径，供你先移动处理。

升级失败时，窗口保留可操作的失败原因和重试入口。也可以用同一套升级核心执行手动回退命令：

```bash
codrive upgrade
```

看板提供**运行设置**页面，可以配置每个项目的并发上限、默认模型和 fallback 模型。点击产品标题可以进入产品详情页，查看注册仓库、完整 `PROJECT.md`、最小规划状态、产品上下文、任务清单和当前执行信息。

## 工作方式

![Codrive 产品轮转与调度架构](https://raw.githubusercontent.com/lzj960515/codrive/main/docs/architecture/codrive-orchestration.png)

[查看可编辑的 draw.io 源图](https://github.com/lzj960515/codrive/blob/main/docs/architecture/codrive-orchestration.drawio)

Codrive 负责确定性的部分：持久化生命周期状态、执行尝试、Codex 任务 ID、每个项目的并发上限，以及同一个仓库一次只合入一个任务。Codex 负责需要判断的部分：选择任务、实现、审查、返工、Git 操作、冲突解决和合入。

任务选择不是预先固定的依赖图。项目注册、完整任务完成、任务取消、新增工作、产品决定、并发配置变化或人工重新规划时，Codrive 为项目创建新的规划版本。一个临时 Codex 任务读取当时全部 backlog、活动任务、产品和仓库事实，并可在该项目当轮固定容量内一次选中多个适合独立开始的任务。少于容量的选择也代表全部 backlog 已经检查完毕；单纯出现空闲位置不会重复询问 AI。

Codrive 先推进已有任务的下一阶段，再为未评估的规划版本选择 backlog。开发完成会立即创建独立审查，审查后的返工或合入继续原任务流水线。任务等待输入或阻塞时保留当前规划版本，同轮已经选中的其他任务仍可开始。全部任务进入完成或取消状态并且项目没有活动执行后，项目进入 `idle`，看板显示“当前无待办”；新增工作会让它重新进入 `active`。最终产品验收只在产品计划明确需要时作为普通任务加入，并沿用开发、审查和合入流水线。正常的任务选择和等待结果不显示提示；只有项目请求决定或发生阻塞时，才显示置顶提醒。每个项目默认最多同时运行四个任务，互不占用其他项目的容量；同一个仓库仍然一次只合入一个任务。

任务可以报告普通阻塞或计划阻塞。普通阻塞结束当前执行，后续人工重试会创建新 attempt；计划阻塞持久化 RFC 3339 绝对时间 `resumeAt` 和 AI 编写的 `resumePrompt`，在释放项目容量和合入资格的同时保留原阶段、attempt、对话与模型路由。到期、服务重启补偿或提前继续时，Codrive 重新检查同一套并发与合入资格，并在原对话唯一启动一个新 turn。重新安排只改变恢复时间；项目暂停会保留等待。

模型容量不足现在是可恢复的执行状态，不会立即把任务标记为阻塞。Codrive 保留当前阶段、attempt 和原对话，分别在 5 秒、10 秒、20 秒后使用默认模型重试；仍无容量时，打开主模型熔断器并切换到配置的 fallback 模型，fallback 拥有独立的三次重试预算。熔断状态会传递给后续任务阶段和项目规划版本，不会随着新 attempt 被重置。冷却 5 分钟后，下一次自然启动的 turn 会成为 half-open 主模型探测；正在正常运行的 fallback turn 不会为了探测被打断。探测遇到容量错误时立即重新熔断，并带着 fallback 原有的连续失败计数返回 fallback；探测正常运行满 5 分钟后关闭熔断器、清零主模型失败并让后续 turn 继续使用主模型。fallback turn 稳定运行满 5 分钟会清零自己的连续失败计数，熔断器仍保持打开直到自然探测发生。只有 fallback 也耗尽后才进入阻塞。重试和熔断状态会跨服务重启持久化，继续占用所属项目的容量，并在项目暂停期间保持等待。

Codrive 每分钟还会进行一次范围很小的自动恢复检查：发送正在等待对话空闲的任务消息，并恢复长时间没有结果的 AI 工作。模型容量重试和计划阻塞都按照持久化的精确截止时间执行，不依赖分钟扫描。运行中的项目完全没有 Codex 工作时，恢复器只启动尚未评估的规划版本；已经保存的选择、等待决定或阻塞结果不会重复调用 AI。App Server 仍报告为 `inProgress` 的任务回合会保留当前 attempt 并续租；中断或不存在的任务回合会重新挂载已持久化的原对话，并在相同 attempt、action 和模型 route 中启动新 turn，成功恢复会写入任务进展时间线。原对话无法重新挂载时，任务会带明确恢复失败原因进入阻塞。服务启动时会先完成恢复，再开放控制命令，避免用户重试与启动恢复竞争。

## Codex 任务关系

| 工作阶段 | Codex 任务行为 |
| --- | --- |
| 开发 | 每个看板任务拥有一个长期 Codex 任务 |
| 返工 | 继续原开发任务 |
| 合入 | 继续原开发任务 |
| 审查 | 每一轮都创建全新的独立任务 |
| 任务选择 | 使用临时任务，不占据最近任务列表 |

所有持久任务都归属到 Codex App 中的产品仓库。Codex 通过 `$codrive-task` 读取任务记录的工作树，并在其中完成开发、审查、返工和合入，让 App 中的项目可见性与隔离代码执行各自保持清晰。

同一个任务对话同一时间只运行一个 Codex 回合。Codrive 在已有对话中继续开发、返工、合入、恢复或请求汇报前，会先等待对话空闲；对话空闲后立即继续，每分钟的自动恢复检查负责补上遗漏的触发。

任务详情把会话入口放在它所属的生命周期事实旁：顶部“当前对话”展示当前执行的阶段、状态和 Codex App 入口；计划阻塞会展示等待原因、按浏览器本地时区格式化的完整恢复日期时间与时区名称或 UTC 偏移，并提供提前继续和重新安排操作；每条有来源对话的持久活动链接到自己的 thread，因此多轮审查分别保留各自入口。当前有效的请求决定通过当前执行已提交的活动精确识别，并提供直接回复操作；已解决的问题只作为历史活动保留。看板不提供回复输入，也不生成临时活动。

暂停后的项目明确显示“已暂停”；已有 turn 尚未结束时显示“执行中 · 后续已暂停”。任务详情使用一条不可变、旧到新的“进展记录”时间线：开发、返工、审查、合入、请求决定、阻塞、失败和取消采用同一种记录结构，测试、findings 与 Git 事实作为对应记录的证据。

## 内置 Skills

| Skill | 用途 |
| --- | --- |
| `$codrive-forge` | 把产品想法整理为经过确认的产品计划和初始任务 |
| `$codrive-task` | 选择项目任务，或执行当前开发、审查、返工与合入阶段 |
| `$codrive-work` | 为现有产品增加新需求、里程碑或下一轮工作 |
| `$codrive-control` | 查看进度，暂停、恢复、重试、重新规划或取消，并记录产品决策 |

Skills 会主动从 Codrive 读取当前项目和任务上下文，因此自动任务消息保持简短，不会反复注入完整产品说明。

重试、计划继续、重新规划和取消表达不同的生命周期语义。普通失败或阻塞任务的重试会创建新的 attempt；计划继续会在持久化截止时间到达或用户提前继续时复用同一 attempt 和 AI 检查点；规划事实明确变化后，重新规划会增加规划版本；等待用户输入的任务在原对话中继续同一个 attempt；取消会永久终止任务或项目。

Codex 会在执行取消前判断取消依据。取消涉及产品取舍、停止范围或现场保留方式时，Codex 先提交 `needs_input`，在原对话中提问；用户明确答复后，再以 `user_confirmed` 取消。仓库和任务事实已经足以支持取消时，Codex 可以用 `agent_decision` 直接取消。每次取消都必须提供具体理由，并记录执行者、判断依据和时间。看板不承担取消审批，只展示取消终态事实，并保留此前的活动时间线。

## 常用命令

```text
codrive                         在后台启动 Codrive 和本地看板
codrive restart                 重启 Codrive
codrive stop                    停止 Codrive
codrive upgrade                 更新 Codrive 与托管 Skills，并验证健康状态
codrive status                  查看本地服务状态
codrive doctor                  检查 Node.js、Codex 和登录状态
codrive setup                   不经过 Web 窗口，直接补齐托管 Skills
codrive serve                   在前台运行，供开发和进程托管器使用
```

运行日志写入 `~/.codrive/codrive.log`。终端和日志文件使用同一份本机时区时间，除 HTTP 错误和 Codex App Server 标准错误外，还会记录结构化生命周期事件，包括命令与关联 ID、来源、项目和任务 ID、attempt/thread/turn ID、恢复器观测与决策、精简的状态迁移、结果和耗时。高频文本与命令输出 delta 不进入 lifecycle 日志。当前日志达到约 10 MB 时轮转；一份 `codrive.log.1` 归档最多保留最近 10 MB 的完整日志行，最长保留 7 天，默认总占用约 20 MB。日志不复制 prompt、聊天正文或报告正文。每个项目的 `events.ndjson` 继续作为持久审计历史。

## 安全模型

Codrive 的 HTTP API 只监听 `127.0.0.1`，本地 API 请求使用随机访问令牌保护。自动 Codex 任务使用 `approvalPolicy: "never"` 和完整本机访问权限运行，从而可以连续创建工作树、修改文件、测试、提交、解决冲突、合入并清理现场，无需等待终端审批。

请只注册你信任的仓库和产品指令。Codrive 不开放远程监听地址，也不会把任务数据库发送到 Codrive 云端服务。

## 参与开发

Codrive 使用 Node.js 24 或更高版本和 pnpm 11.5.1 进行开发与运行。

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
