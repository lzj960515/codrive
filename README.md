<div align="center">
  <h1>Codrive</h1>
  <p><strong>Turn product work into a continuous stream of visible Codex tasks.</strong></p>
  <p>Local-first orchestration for planning, development, independent review, rework, and integration.</p>

  <p>
    <a href="https://www.npmjs.com/package/codrive"><img alt="npm version" src="https://img.shields.io/npm/v/codrive?style=flat-square&color=cb3837"></a>
    <a href="https://github.com/lzj960515/codrive/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/lzj960515/codrive/ci.yml?branch=main&style=flat-square&label=ci"></a>
    <a href="https://www.npmjs.com/package/codrive"><img alt="Node.js version" src="https://img.shields.io/node/v/codrive?style=flat-square&color=43853d"></a>
    <a href="./LICENSE"><img alt="MIT License" src="https://img.shields.io/github/license/lzj960515/codrive?style=flat-square&color=2d5b46"></a>
  </p>

  <p><strong>English</strong> · <a href="./README.zh-CN.md">简体中文</a></p>
</div>

<p align="center">
  <img src="https://raw.githubusercontent.com/lzj960515/codrive/main/docs/images/codrive-board.jpg" alt="Codrive local product board with sample projects and task details">
</p>

## What is Codrive?

Codrive is a lightweight local service that connects Codex App conversations, a product board, filesystem-backed state, and reusable Skills. Describe a product goal in Codex App, confirm the plan, and Codrive keeps the resulting tasks moving through development, independent review, rework, and integration.

Codex still understands the repository, writes and reviews code, runs tests, resolves conflicts, and makes product decisions. Codrive provides the durable workflow around that work: task state, isolated conversations, scheduling, recovery, and a clear activity history.

> **One command, local state, no infrastructure.** Codrive does not require Docker, PostgreSQL, Redis, or a hosted service.

## Why Codrive?

- **Visible work.** Every development and review task appears in Codex App.
- **Focused context.** Development and review use separate conversations; each task's review conversation continues across review rounds.
- **Continuous delivery.** Approved work moves to integration, while requested changes return to the original development conversation.
- **Dynamic planning.** Codex selects useful work from current product and repository facts instead of following a fixed dependency graph.
- **Local ownership.** Product documents, task state, execution history, and credentials stay on your machine.

## Quick start

You need Node.js 24 or newer, Git, and a Codex login available in `~/.codex`.

```bash
npm install --global codrive@latest
codrive
```

Codrive prints the local board URL and log location. Open the board, then:

1. Click **Complete managed Skills** in the **Codrive update** window.
2. Open the target project directory in Codex App.
3. Describe the product work and ask Codex to use Codrive.

```text
Use Codrive to add a leaderboard to this project, then start development after I confirm the plan.
```

While the service is running, Codrive checks the npm latest stable release about once per hour. An open board receives the result without a page refresh and shows an update prompt when a newer version is available. **Check again** refreshes the status immediately and starts a new hourly interval.

The board loads authoritative snapshots over authenticated HTTP, then follows changes through one authenticated WebSocket connection. Live events carry a schema version, a connection-local sequence, and the smallest affected project, task, settings, or system scope. Reconnects and sequence gaps resynchronize only the relevant HTTP projections while preserving the selected project, open task detail, scroll position, update dialog, focus, and unfinished input.

The update window shows the installed version, the latest stable release, the last check time, and the status of the four managed Skills. Automatic checks only update this status: installation still requires your confirmation. The window can then install an exact release, restart the local service, synchronize the bundled Skills, and verify the new version. The command-line equivalent is:

```bash
codrive upgrade
```

The board also provides runtime settings for per-project concurrency, the primary model, and the fallback model.

## How it works

![Codrive product loop and scheduling architecture](https://raw.githubusercontent.com/lzj960515/codrive/main/docs/architecture/codrive-orchestration.png)

1. **Plan.** Codex turns a product goal into tasks and selects the next work from the latest product and repository facts.
2. **Develop.** Each selected task runs in its own persistent Codex conversation and isolated Git worktree.
3. **Review.** The first review starts an independent conversation, and later review rounds continue it. Findings return to the development conversation for evidence-based rework.
4. **Integrate.** Approved work is merged through the original task conversation, with one integration at a time per repository.

HTTP remains the authority for initial board, product, task, settings, and system reads, and `/api/commands` remains the idempotent write boundary. The `/api/live` WebSocket only signals scoped changes; it does not carry commands or replace authoritative snapshots. See [Live sync architecture](./docs/architecture/live-sync.md) for the protocol and recovery model.

Codrive persists lifecycle state and enforces scheduling boundaries; Codex handles the work that requires judgment. Projects have independent concurrency limits, and planning runs again when its facts change rather than whenever a slot happens to become free.

Review findings represent real delivery blockers in supported product and operational paths, not unconditional rework instructions. The development conversation fixes valid issues or records evidence for findings that do not apply; the same independent review conversation then reevaluates the current candidate and that evidence.

Waiting and recovery are part of the same workflow. A task can pause until a specific time without holding project capacity, capacity errors can move work to a fallback model, and interrupted work can resume from its persisted conversation and execution state. The task timeline records these transitions and surfaces only decisions or failures that need attention.

## Codex conversations

| Work | Conversation behavior |
| --- | --- |
| Development | One persistent Codex conversation per task |
| Rework | Continues the development conversation |
| Integration | Continues the development conversation |
| Review | Uses one independent persistent review conversation per task |
| Task selection | Uses temporary conversations that stay out of the recent-task list |

Task details link each execution and activity to its source conversation. They also show blockers, scheduled continuation, decision requests, test evidence, review findings, and Git results in one chronological timeline.

## Built-in Skills

| Skill | Purpose |
| --- | --- |
| `$codrive-forge` | Turn a product idea into a confirmed plan and initial task set |
| `$codrive-task` | Select project work or execute the current task stage |
| `$codrive-work` | Add requirements, milestones, or another round of work |
| `$codrive-control` | Inspect progress and control project or task execution |

Skills read live context from Codrive, so task messages stay short and product state remains consistent across conversations.

## Commands

```text
codrive                         Start Codrive and the local board in the background
codrive start                   Start Codrive in the background
codrive stop                    Stop Codrive
codrive restart                 Restart Codrive
codrive upgrade                 Install the latest release and restart
codrive status                  Show local service status
codrive setup                   Install or complete managed Skills
codrive doctor                  Check Node.js, Codex, and login readiness
codrive import <project.json>   Import a product
codrive serve                   Run in the foreground
codrive --version               Show the installed version
```

## Local data and security

Codrive stores its state and logs under `~/.codrive` by default. The product event log is append-only, while `codrive.log` contains operational lifecycle records without prompts, chat messages, or report bodies.

The HTTP API and WebSocket listen only on `127.0.0.1` and use the same random access token. Automated Codex tasks run with full local access so they can edit, test, commit, merge, and clean up without terminal approval. Register only repositories and product instructions you trust.

## Development

Codrive uses Node.js 24 or newer and pnpm 11.5.1.

```bash
corepack enable
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm dev
```

## License

[MIT](./LICENSE)
