<div align="center">
  <h1>Codrive</h1>
  <p><strong>Turn a product idea into a continuous stream of visible Codex tasks.</strong></p>
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

Codrive is a lightweight local service that connects Codex App conversations, a task board, filesystem-backed product state, and reusable Skills.

Describe the product you want in Codex App. Codex turns the idea into a product plan, registers the work with Codrive, and then handles each task in its own visible conversation. Every review starts in a separate clean conversation. When review asks for changes, Codrive returns the work to the original development conversation; when review approves it, Codex integrates the result and Codrive starts the next useful work.

Codrive is not another model or coding agent. It gives the regular Codex agent a small, reliable workflow around long-running product development.

> **One command, local state, no infrastructure.** Codrive does not require Docker, PostgreSQL, Redis, or a hosted service.

## Why Codrive?

- **Work stays visible.** Development and review tasks appear in Codex App instead of disappearing into a background worker.
- **Context stays focused.** Each task has one long-lived development conversation, while every review receives a fresh independent context.
- **Codex keeps the judgment.** Codex decides what can run in parallel, understands the repository, writes code, tests, reviews, resolves conflicts, and integrates changes.
- **The workflow keeps moving.** Project and task events immediately trigger the next selection, review, rework, integration, or product evaluation step.
- **Everything stays local.** Product documents, task state, execution history, and credentials remain on your machine.

## Quick start

You need Node.js 20 or newer, Git, and a Codex login available in `~/.codex`.

```bash
npx codrive
```

Codrive prints the local board URL and log file location. Open it in your browser and follow the first-run prompt:

1. Click **Install Skills** to add the four bundled Codrive Skills to your local agent library.
2. For the usual local workflow, create the product folder and open it in Codex App.
3. Describe the product naturally, for example:

```text
Help me plan this snake game with Codrive, then start development after I confirm.
```

Choosing **Later** keeps a small Skills setup button in the lower-left corner of the board. When a future Codrive release changes its bundled Skills, the board offers the update again.

## How it works

![Codrive product loop and scheduling architecture](https://raw.githubusercontent.com/lzj960515/codrive/main/docs/architecture/codrive-orchestration.png)

[Open the editable draw.io source](https://github.com/lzj960515/codrive/blob/main/docs/architecture/codrive-orchestration.drawio)

Codrive owns the deterministic parts: persisted lifecycle state, execution attempts, conversation IDs, the global concurrency limit, and the rule that one repository integrates only one task at a time. Codex owns the judgment-heavy parts: selecting work, implementation, review, rework, Git operations, conflict resolution, integration, and product evaluation.

Task selection is dynamic rather than a fixed dependency graph. Whenever capacity becomes available, a temporary Codex task reads the current product, task, and repository facts and can choose several tasks that are useful to start now. Codrive validates the result and gives every selected task its own top-level development conversation and isolated worktree. The default limit is four active tasks across all projects; integration remains serial within each repository.

Project registration, added work, stage reports, completed or failed Codex turns, project controls, and service startup immediately trigger the next workflow decision. The concurrency limit is part of that decision, so changing it invalidates an earlier selection result. When Codrive starts, it upgrades local configurations created with the original one-task default to four.

Once a minute, Codrive also runs a narrow recovery check. It sends task messages that were waiting for their conversation to become idle, resumes AI work that has gone a long time without a result, and restarts task selection when an active project still has unstarted tasks but no Codex work at all. A turn that App Server still reports as `inProgress` keeps its current attempt and receives a renewed lease. Only a confirmed missing or terminal turn is replaced. Startup recovery completes before the command API becomes ready, so user retries cannot race with it.

## Codex conversations

| Work | Conversation behavior |
| --- | --- |
| Development | One persistent Codex conversation per task |
| Rework | Continues the original development conversation |
| Integration | Continues the original development conversation |
| Review | Starts a fresh independent conversation for every round |
| Task selection and product evaluation | Uses temporary conversations that do not crowd the recent-task list |

Persistent task conversations stay attached to the product repository in Codex App. Codex reads the task's recorded worktree from `$codrive-task` and performs implementation, review, rework, and integration there, so App visibility and isolated code execution remain separate concerns.

Each task conversation runs one Codex turn at a time. Before development, rework, integration, recovery, or a report reminder continues an existing conversation, Codrive waits until that conversation is idle; an idle event resumes it immediately, with the minute recovery check as a fallback.

The board links directly to development and review conversations. If Codex needs a product decision, the board shows the question and sends you back to the relevant Codex task; Codrive does not create a second chat interface.

## Built-in Skills

| Skill | Purpose |
| --- | --- |
| `$codrive-forge` | Shape a product idea into a confirmed product plan and initial task set |
| `$codrive-task` | Execute the current development, review, rework, integration, or evaluation stage |
| `$codrive-work` | Add a requirement, milestone, or new round of work to an existing product |
| `$codrive-control` | Inspect progress and pause, resume, retry, cancel, or record a product decision |

Skills read the current project and task context from Codrive, so automated task messages stay short and do not repeat the full product specification.

Retry and cancel have different lifecycle meanings. Retry creates a new attempt for a failed task or project execution that still has a requested action. A task waiting for input continues the same attempt in its original conversation. Cancel permanently ends the task or project.

## Commands

```text
npx codrive          Start Codrive and the local board
npx codrive status   Check whether the local service is running
npx codrive doctor   Check Node.js, Codex, and login readiness
npx codrive setup    Install Skills without using the Web prompt
```

Runtime logs are written to `~/.codrive/codrive.log`. The terminal and log file use the same local-time timestamps and include structured lifecycle events alongside HTTP errors and Codex App Server stderr. Lifecycle events record command and correlation IDs, source, task/project IDs, attempt/thread/turn IDs, recovery observations and decisions, concise state transitions, outcomes, and durations. They omit prompts, chat messages, and report bodies. Each project's append-only `events.ndjson` remains the durable audit history.

## Security

Codrive binds its HTTP API to `127.0.0.1` and protects local API calls with a random access token. Automated Codex tasks run with `approvalPolicy: "never"` and full local access so they can create worktrees, edit files, test, commit, resolve conflicts, merge, and clean up without waiting for terminal approval.

Only register repositories and product instructions you trust. Codrive does not open a remote listener or send its task database to a hosted Codrive service.

## Development

Codrive uses Node.js 24 and pnpm 11.5.1 for development while keeping the published package compatible with Node.js 20 and newer.

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
