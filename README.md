<div align="center">
  <h1>Codrive</h1>
  <p><strong>Turn product work into a continuous stream of visible Codex tasks.</strong></p>
  <p>Local-first orchestration for planning, work, independent review, and completion-aware integration.</p>

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

Codrive is a lightweight local service that connects Codex App conversations, a product board, filesystem-backed state, and reusable Skills. Describe a product goal in Codex App, confirm the plan, and Codrive keeps each task moving through general work, independent review, and integration until the entire task is complete.

Codex still understands the repository, writes and reviews code, runs tests, resolves conflicts, and makes product decisions. Codrive provides the durable workflow around that work: task state, isolated conversations, scheduling, recovery, and a clear activity history.

> **One command, local state, no infrastructure.** Codrive does not require Docker, PostgreSQL, Redis, or a hosted service.

## Why Codrive?

- **Visible work.** Every work and review execution appears in Codex App.
- **Focused context.** Work and Review use separate conversations; each task's Review conversation continues across review rounds.
- **Continuous delivery.** Approved results move to integration, which either completes the task, opens the next work round, or sends a newly changed candidate back to Review.
- **Dynamic planning.** Codex selects useful work from current product and repository facts instead of following a fixed dependency graph.
- **Local ownership.** Product documents, task state, execution history, and credentials stay on your machine.

## Quick start

You need Node.js 24 or newer, Git, and a Codex login available in `~/.codex`.

```bash
npm install --global codrive@latest
codrive setup
codrive
```

`setup` initializes an empty state directory at schema v4 and installs the exact package's managed Skills and Hook. Codrive then prints the local board URL and log location. After setup:

1. In Codex, run `/hooks`, review the four Codrive activity Hook definitions, and trust their current hashes.
2. Open the target project directory in Codex App.
3. Describe the product work and ask Codex to use Codrive.

```text
Use Codrive to add a leaderboard to this project, then start development after I confirm the plan.
```

While the service is running, Codrive checks the npm latest stable release about once per hour. An open board receives the result without a page refresh and shows an update prompt when a newer version is available. **Check again** refreshes the status immediately and starts a new hourly interval.

The update window shows the installed version, the latest stable release, the last check time, and separate status rows for Codrive's four managed Skills and one managed Codex Hook. Automatic checks only update this status: installation still requires your confirmation. The update worker installs the exact release, stops Codrive and its App Server, migrates and validates local state, synchronizes all five bundled resources while stopped, starts the new service, and verifies the running version before recording success. The command-line equivalent is:

```bash
codrive upgrade
```

Ordinary startup never performs a historical state migration. It creates schema v4 only for an empty state directory, then requires both current v4 state and exact-version managed resource markers before starting App Server or Recovery. A manual package replacement or failed resource synchronization therefore remains stopped; use `codrive upgrade` for an existing installation, or `codrive setup` to initialize a fresh installation or repair resources whose state is already current.

Codex owns Hook review and trust. After setup or any release that changes the Hook definition, use `/hooks` in Codex to review and trust the new hash. Codex does not expose a public per-Hook API that lets Codrive persist that decision on the user's behalf; the process-wide bypass would also trust unrelated user and project Hooks, so Codrive does not use it. The update window shows an action prompt until all four Codrive definitions are enabled and trusted, and `codrive doctor` reports static installation and runtime trust as separate checks.

The board also provides runtime settings for per-project concurrency, the primary model, the fallback model, and optional Semantic Atlas automatic maintenance. When the public `semantic-atlas` command is installed and the user enables it, Codrive checks actionable business-map candidates after ordinary task integration and creates a normal independently reviewed maintenance task per project and business domain. Codrive does not install or diagnose Semantic Atlas. Each project inherits the global models by default and can override both from its product detail page; the override applies when the project's next Codex turn starts. The completed and cancelled board columns can be sorted by their terminal time, newest first or oldest first. See [Semantic Atlas automatic maintenance](./docs/architecture/semantic-atlas-maintenance.md).

Projects can be archived without changing their `active`, `idle`, or `cancelled` lifecycle status. Archiving is available only when the project and all of its tasks have no active, retrying, reporting, input-waiting, or scheduled-wait execution. It pauses future scheduling, hides the project from the default board, and keeps `PROJECT.md`, tasks, activity history, execution evidence, and Codex conversation references on disk. The archived drawer provides historical access and restore controls. Restoring a project leaves it paused until you explicitly continue it; Codrive never permanently deletes the project or archives its Codex conversations.

An open board uses an authenticated Socket.IO connection to watch only the selected project, the open task, and system updates. Archive and restore additionally publish a project-list invalidation to authenticated board connections. Realtime events are small invalidation signals: the browser rereads the matching HTTP snapshot instead of accepting state over the socket. Switching projects or tasks changes rooms, while reconnecting restores the current rooms and scoped reads without reloading the page or discarding the current UI state. See [Realtime synchronization](./docs/architecture/realtime-sync.md) for the full contract.

While a task turn is running, its detail panel also shows one replaceable current-activity signal. The managed Codex Hook reports lifecycle activity to `/api/hooks/activity`; that accepted request is the only live activity and renewal source. Tool events display the canonical safe tool name, such as `apply_patch`, `Bash`, or an MCP tool name. Opening a task reads only the latest Hook activity and otherwise waits for the next signal. All activity stays in process memory and contains only a category, safe tool label, and execution identity, never prompts, reasoning, command arguments, output, paths, transcripts, or environment values.

The same in-memory bridge keeps a Hook `lastSeen` window for the exact task execution. A service restart starts a fresh window instead of guessing that a quiet turn has stopped. After ten minutes without an accepted Hook request, Codrive checks the saved thread and turn through App Server once per minute: a running turn starts a new ten-minute window, a completed turn enters the normal report path, and only an unambiguously interrupted or failed turn is eligible to resume. App Server may report a persisted thread as not loaded after restart; its exact terminal turn remains authoritative when no turn is active. Missing, unreadable, contradictory, superseded, paused, or capacity-blocked work stays unchanged and is checked again later; Codrive does not create a persisted presence state.

## How it works

![Codrive product loop and scheduling architecture](https://raw.githubusercontent.com/lzj960515/codrive/main/docs/architecture/codrive-orchestration.png)

1. **Plan.** Codex turns a product goal into tasks and selects the next work from the latest product and repository facts.
2. **Work.** Each selected task runs in its own persistent Codex conversation. Code work uses an isolated Git worktree; releases, migrations, and verification can produce a reviewable result without a commit.
3. **Review.** The first Review starts an independent conversation, and later rounds continue it. Findings return to the work conversation for an evidence-based next result.
4. **Integrate.** The original task conversation merges a code-backed result or verifies a no-code result, then explicitly completes the task, requests more work, or sends a changed candidate back to Review. Each repository still has one integration lease.

Codrive persists lifecycle state and enforces scheduling boundaries; Codex handles the work that requires judgment. Projects have independent concurrency limits, and planning runs again when its facts change rather than whenever a slot happens to become free.

`PROJECT.md` is the single current product-facts source for every project and task turn. After registration, Agents edit that local file directly and send a small change notification containing document revisions and digests instead of retransmitting the full document. Codrive validates the file, records the decision summary in its append-only event history, replaces stale task selection, and replans.

Task state has three distinct layers: the board-visible business status, the next `work | review | integrate` action, and the attempt's runtime status. Every completed work result owns one immutable activity and an optional `candidateCommit`; Review and integration bind that exact activity instead of scanning older candidates. Integration completion is a separate decision from Git merge completion, so one task can continue into release, migration, or verification work after code is merged.

State schema v4 persists that model. Only the stopped upgrade command performs historical migration: Codrive backs up v3, migrates task snapshots and recovery events in a temporary tree, reconstructs work-activity bindings, validates counts and open execution identities, then atomically switches projects and the marker. Migration failure leaves v3 authoritative. A schema-v2 installation first performs the existing v3 upgrade and then this v4 migration. Ordinary startup only validates current state and managed-resource markers before recovery. See [Product facts lifecycle](./docs/architecture/product-facts.md).

Review findings represent real delivery blockers in supported product and operational paths, not unconditional instructions. The work conversation fixes valid issues or records evidence for findings that do not apply; the same independent Review conversation then reevaluates the newly recorded work result.

Waiting and recovery are part of the same workflow. A task can pause until a specific time without holding project capacity, capacity errors can move work to a fallback model, and an authoritatively interrupted task can resume from its persisted conversation and execution state. Recovery rechecks the exact action, attempt, thread, turn, project capacity, and integration lease before starting one replacement turn. The task timeline records actual recovery transitions and surfaces only decisions or failures that need attention.

## Codex conversations

| Work | Conversation behavior |
| --- | --- |
| Work | One persistent Codex conversation per task for code, release, migration, verification, and Review feedback |
| Integration | Continues the work conversation and decides whether the whole task is complete |
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
codrive upgrade                 Install the latest release through the stopped-state migration barrier
codrive status                  Show local service status
codrive setup                   Initialize fresh v4 state and install or repair managed resources
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
