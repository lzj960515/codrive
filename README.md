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

1. Click **Complete managed resources** in the **Codrive update** window.
2. In Codex, run `/hooks`, review the four Codrive activity Hook definitions, and trust their current hashes.
3. Open the target project directory in Codex App.
4. Describe the product work and ask Codex to use Codrive.

```text
Use Codrive to add a leaderboard to this project, then start development after I confirm the plan.
```

While the service is running, Codrive checks the npm latest stable release about once per hour. An open board receives the result without a page refresh and shows an update prompt when a newer version is available. **Check again** refreshes the status immediately and starts a new hourly interval.

The update window shows the installed version, the latest stable release, the last check time, and separate status rows for Codrive's four managed Skills and one managed Codex Hook. Automatic checks only update this status: installation still requires your confirmation. The window can then install an exact release, restart the local service, synchronize and verify all five bundled resources, and verify the new version before recording success. The command-line equivalent is:

```bash
codrive upgrade
```

Codex owns Hook review and trust. After setup or any release that changes the Hook definition, use `/hooks` in Codex to review and trust the new hash. Codex does not expose a public per-Hook API that lets Codrive persist that decision on the user's behalf; the process-wide bypass would also trust unrelated user and project Hooks, so Codrive does not use it. The update window shows an action prompt until all four Codrive definitions are enabled and trusted, and `codrive doctor` reports static installation and runtime trust as separate checks.

The board also provides runtime settings for per-project concurrency, the primary model, and the fallback model. Each project inherits those models by default and can override both from its product detail page; the override applies when the project's next Codex turn starts. The completed and cancelled board columns can be sorted by their terminal time, newest first or oldest first.

An open board uses an authenticated Socket.IO connection to watch only the selected project, the open task, and system updates. Realtime events are small invalidation signals: the browser rereads the matching HTTP snapshot instead of accepting state over the socket. Switching projects or tasks changes rooms, while reconnecting restores the current rooms and scoped reads without reloading the page or discarding the current UI state. See [Realtime synchronization](./docs/architecture/realtime-sync.md) for the full contract.

While a task turn is running, its detail panel also shows one replaceable current-activity signal. The managed Codex Hook reports lifecycle activity to `/api/hooks/activity`; that accepted request is the only live activity and renewal source. Tool events display the canonical safe tool name, such as `apply_patch`, `Bash`, or an MCP tool name. Opening a task reads only the latest Hook activity and otherwise waits for the next signal. All activity stays in process memory and contains only a category, safe tool label, and execution identity, never prompts, reasoning, command arguments, output, paths, transcripts, or environment values.

The same in-memory bridge keeps a Hook `lastSeen` window for the exact task execution. A service restart starts a fresh window instead of guessing that a quiet turn has stopped. After ten minutes without an accepted Hook request, Codrive checks the saved thread and turn through App Server once per minute: a running turn starts a new ten-minute window, a completed turn enters the normal report path, and only an unambiguously interrupted or failed turn is eligible to resume. App Server may report a persisted thread as not loaded after restart; its exact terminal turn remains authoritative when no turn is active. Missing, unreadable, contradictory, superseded, paused, or capacity-blocked work stays unchanged and is checked again later; Codrive does not create a persisted presence state.

## How it works

![Codrive product loop and scheduling architecture](https://raw.githubusercontent.com/lzj960515/codrive/main/docs/architecture/codrive-orchestration.png)

1. **Plan.** Codex turns a product goal into tasks and selects the next work from the latest product and repository facts.
2. **Develop.** Each selected task runs in its own persistent Codex conversation and isolated Git worktree.
3. **Review.** The first review starts an independent conversation, and later review rounds continue it. Findings return to the development conversation for evidence-based rework.
4. **Integrate.** Approved work is merged through the original task conversation, with one integration at a time per repository.

Codrive persists lifecycle state and enforces scheduling boundaries; Codex handles the work that requires judgment. Projects have independent concurrency limits, and planning runs again when its facts change rather than whenever a slot happens to become free.

`PROJECT.md` is the single current product-facts source for every project and task turn. After registration, Agents edit that local file directly and send a small change notification containing document revisions and digests instead of retransmitting the full document. Codrive validates the file, records the decision summary in its append-only event history, replaces stale task selection, and replans. When an existing schema-v2 installation first starts this release, Codrive backs it up and upgrades its projects to the current schema-v3 contract before recovery begins. See [Product facts lifecycle](./docs/architecture/product-facts.md).

Review findings represent real delivery blockers in supported product and operational paths, not unconditional rework instructions. The development conversation fixes valid issues or records evidence for findings that do not apply; the same independent review conversation then reevaluates the current candidate and that evidence.

Waiting and recovery are part of the same workflow. A task can pause until a specific time without holding project capacity, capacity errors can move work to a fallback model, and an authoritatively interrupted task can resume from its persisted conversation and execution state. Recovery rechecks the exact action, attempt, thread, turn, project capacity, and integration lease before starting one replacement turn. The task timeline records actual recovery transitions and surfaces only decisions or failures that need attention.

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
| `$codrive-work` | Edit the local product document and add confirmed work in one planning revision |
| `$codrive-control` | Inspect progress, record local product-document changes, and control execution |

Skills read live context from Codrive, so task messages stay short and product state remains consistent across conversations.

## Commands

```text
codrive                         Start Codrive and the local board in the background
codrive start                   Start Codrive in the background
codrive stop                    Stop Codrive
codrive restart                 Restart Codrive
codrive upgrade                 Install the latest release and restart
codrive status                  Show local service status
codrive setup                   Install or complete managed Skills and Hook
codrive doctor                  Check runtime, Codex, login, and managed resources
codrive import <project.json>   Import a product
codrive serve                   Run in the foreground
codrive --version               Show the installed version
```

## Local data and security

Codrive stores its state and logs under `~/.codrive` by default. The product event log is append-only, while `codrive.log` contains operational lifecycle records without prompts, chat messages, or report bodies.

The HTTP API and Socket.IO endpoint listen only on `127.0.0.1` and use the same random access token. Automated Codex tasks run with full local access so they can edit, test, commit, merge, and clean up without terminal approval. Register only repositories and product instructions you trust.

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
