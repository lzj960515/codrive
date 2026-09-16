<div align="center">
  <h1>Codrive</h1>
  <p><strong>交代目标，让 Codex 持续推进。</strong></p>
  <p>从规划、执行到独立审查和验收，在本地管理你的 AI 开发工作。</p>

  <p>
    <a href="https://www.npmjs.com/package/codrive"><img alt="npm version" src="https://img.shields.io/npm/v/codrive?style=flat-square&color=cb3837"></a>
    <a href="https://github.com/lzj960515/codrive/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/lzj960515/codrive/ci.yml?branch=main&style=flat-square&label=ci"></a>
    <a href="https://www.npmjs.com/package/codrive"><img alt="Node.js version" src="https://img.shields.io/node/v/codrive?style=flat-square&color=43853d"></a>
    <a href="./LICENSE"><img alt="MIT License" src="https://img.shields.io/github/license/lzj960515/codrive?style=flat-square&color=2d5b46"></a>
  </p>

  <p><a href="./README.md">English</a> · <strong>简体中文</strong></p>
</div>

## 把目标交给 AI，把精力留给决定

和 AI 一起开发，常常需要你不断分配下一步、追问进度、检查结果。事情一多，每个对话都要盯着。

Codrive 为 Codex App 提供持续推进工作的流程：你确认目标和边界，Codex 拆解任务、开展工作、独立审查，并根据执行中的发现调整计划。需要新的业务取舍时，它会提出问题；你可以在看板查看进度，也可以回到对应的 Codex 对话继续讨论。

**本地运行，无需单独部署数据库、Redis 或 Docker。** Codrive 管理任务与调度，Codex 负责理解项目和完成工作。

<p align="center">
  <img src="https://raw.githubusercontent.com/lzj960515/codrive/main/docs/images/codrive-board.jpg" alt="Codrive 看板示例：项目、任务状态与任务详情">
</p>

## 从一个目标，到经过验收的结果

| 你关心的事 | Codrive 如何推进 |
| --- | --- |
| 想做一件大事，还不知道有哪些任务 | 建立里程碑，写清目标、范围和验收标准，由 Codex 调查并形成初始任务。小改动也可以直接创建独立任务。 |
| 做到一半，发现计划漏了东西 | 根据新发现重新评估，在已确认目标内补充调查、追加任务或调整尚未开始的工作。 |
| 有些问题需要你拍板 | 提出具体问题，限制受影响的工作；无关任务和必要调查仍可继续。 |
| AI 说做完了，结果可靠吗 | 每份工作结果进入独立审查。需要返工时回到原任务，修改后再次审查。 |
| 代码合入了，事情却还没结束 | 根据任务目标继续发布、迁移或验证。里程碑还会逐项核对验收证据，缺少交付就补任务。 |

### 计划可以变化，目标始终清楚

例如，你想完成一次 Social 迁移。可以先建立里程碑，让 Codex 调查现有调用方、拆分迁移任务。执行中发现遗漏的调用方，就补充迁移工作；如果涉及改变业务行为，则先向你说明影响并请求决定。

所有任务结束后，Codex 还会检查迁移是否满足验收标准。缺少实际运行证据，就继续安排验证，而不是仅凭任务数量判定完成。

项目资料中的 `PROJECT.md` 保存长期产品事实与规则；里程碑描述阶段目标，任务描述具体交付。**日常追加任务不需要改写产品契约。**

## 开始使用

准备好 **Node.js 24 或更高版本、Git、Codex App**，并完成 Codex 登录（默认使用 `~/.codex` 中的登录信息）。

```bash
npm install --global codrive@latest
codrive setup
codrive
```

`setup` 安装随包提供的 Skills 和活动 Hook；启动后，终端会显示本地看板地址。

1. 在 Codex 中运行 `/hooks`，审核并信任四条 Codrive 活动 Hook 定义。
2. 用 Codex App 打开目标项目目录。
3. 描述你要做的事情，让 Codex 使用 Codrive。确认计划后开始执行。

例如：

```text
用 Codrive 给这个项目增加排行榜功能。
先和我确认范围与验收标准，再建立里程碑并开始推进。
```

后续工作也可以直接在 Codex 中说明：

| 想做什么 | 可以这样说 |
| --- | --- |
| 追加小任务 | 用 Codrive 增加一个独立任务：修复设置页返回链接，并验证能正常返回项目。 |
| 调整计划 | 排行榜还需要支持周榜，先帮我评估影响，再调整这个里程碑的计划。 |
| 了解进展 | 看一下 Codrive 里这个项目的进度，有什么问题需要我决定？ |
| 暂停调度 | 暂停这个项目的后续任务调度。 |

## 在看板看进度，在对话里做决定

- **任务看板**展示各阶段的工作，保留已完成和已取消的任务。顶部的活动里程碑卡片用于筛选，不选时显示全部任务。
- **里程碑页面**集中查看阶段目标、验收标准、待决定的问题和关联任务，也能回顾已完成的里程碑。
- **任务详情**展示活动记录、当前执行摘要、审查结果和对话入口。AI 没有正在执行时，可以取消未完成任务；需要恢复的任务提供相应操作，计划等待也可调整时间或提前继续。
- **项目资料**单独维护产品文档和项目模型配置。归档项目会保留历史；恢复后仍保持暂停，由你决定何时继续。

规划、里程碑评估、任务执行和独立审查都使用项目下可见、可继续的 Codex 对话。你可以查看过程、补充背景，也可以在需要时参与决策。

## 按你的节奏运行

设置中可以调整项目并发上限、默认模型、备用模型及各自的推理强度。项目可以继承全局模型设置，也可以单独覆盖；修改从下一轮执行开始生效。

模型容量不足时，Codrive 会重试并按配置切换备用模型。计划等待会让出执行容量，到期后继续；确认中断的工作会尝试从原对话恢复。需要你处理的问题会在详情中保留记录。

如果已经安装 Semantic Atlas，可以在设置中启用自动维护，让相关代码工作完成后通过普通任务更新项目业务知识。详见 [Semantic Atlas 自动维护](./docs/architecture/semantic-atlas-maintenance.md)。

### 更新与常用命令

Codrive 运行时会定期检查新版本，并在看板提示。安装由你发起，也可以使用 `codrive upgrade`：它会安装新版本、迁移受支持的本地数据、同步 Skills 和 Hook，并重启验证服务。Hook 定义发生变化后，需要再次通过 Codex 的 `/hooks` 审核并信任。

| 命令 | 用途 |
| --- | --- |
| `codrive` | 在后台启动服务和本地看板 |
| `codrive status` | 查看本地服务状态 |
| `codrive stop` / `codrive restart` | 停止或重启服务 |
| `codrive upgrade` | 更新到最新版本 |
| `codrive setup` | 初始化或修复托管 Skills 和 Hook |
| `codrive doctor` | 检查运行环境、登录和托管资源 |
| `codrive serve` | 在前台运行 |

## 本地数据与执行权限

Codrive 默认把项目状态、活动历史和日志保存在 `~/.codrive`。本地服务只监听 `127.0.0.1`，并使用访问令牌保护。AI 请求仍通过 Codex 使用所配置的模型服务。

自动任务拥有完整本机访问权限，可以修改文件、执行命令、测试、提交和合入代码，无需逐次终端审批。请在你信任的仓库中使用，并明确任务的目标和授权范围。

## 了解更多与参与开发

Codrive 随包提供四个 Skills，分别承接不同工作：

| Skill | 用途 |
| --- | --- |
| `$codrive-forge` | 将初始产品目标整理为项目、里程碑和任务 |
| `$codrive-work` | 为已有项目追加工作或调整计划 |
| `$codrive-task` | 执行任务选择、里程碑评估和任务各阶段 |
| `$codrive-control` | 查询进度、维护项目事实和控制执行 |

想了解实现细节，可以阅读[里程碑与持续规划](./docs/architecture/milestones.md)、[产品事实生命周期](./docs/architecture/product-facts.md)和[看板实时同步](./docs/architecture/realtime-sync.md)。

本地开发使用 Node.js 24 或更高版本和 pnpm 11.5.1：

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
