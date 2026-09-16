<div align="center">
  <h1>Codrive</h1>
  <p><strong>Set the goal. Let Codex keep the work moving.</strong></p>
  <p>Local orchestration for planning, execution, independent review, and acceptance.</p>

  <p>
    <a href="https://www.npmjs.com/package/codrive"><img alt="npm version" src="https://img.shields.io/npm/v/codrive?style=flat-square&color=cb3837"></a>
    <a href="https://github.com/lzj960515/codrive/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/lzj960515/codrive/ci.yml?branch=main&style=flat-square&label=ci"></a>
    <a href="https://www.npmjs.com/package/codrive"><img alt="Node.js version" src="https://img.shields.io/node/v/codrive?style=flat-square&color=43853d"></a>
    <a href="./LICENSE"><img alt="MIT License" src="https://img.shields.io/github/license/lzj960515/codrive?style=flat-square&color=2d5b46"></a>
  </p>

  <p><strong>English</strong> · <a href="./README.zh-CN.md">简体中文</a></p>
</div>

## Give AI the goal. Save your attention for decisions.

Working with AI often means assigning the next step, asking for updates, and checking results yourself. As the work grows, every conversation needs your attention.

Codrive gives Codex App a workflow that keeps moving: you confirm the goal and boundaries, and Codex breaks down tasks, does the work, reviews results independently, and revises the plan as it learns. When a new product decision needs your input, it asks. Follow progress on the board or return to the relevant Codex conversation to discuss the details.

**Runs locally, with no separate database, Redis, or Docker deployment.** Codrive manages tasks and scheduling; Codex understands your project and performs the work.

<p align="center">
  <img src="https://raw.githubusercontent.com/lzj960515/codrive/main/docs/images/codrive-board.jpg" alt="Example Codrive board showing projects, task stages, and task details">
</p>

## From a goal to a verified result

| What you need | How Codrive helps |
| --- | --- |
| A substantial change, before you know all the tasks | Create a milestone with a goal, scope, and acceptance criteria. Codex investigates and builds the initial plan. Small changes can be independent tasks. |
| A plan that adapts when work uncovers something new | Reassess discoveries, add investigations or missing tasks, and revise work that has not started within the agreed goal. |
| Your input on the decisions that matter | Ask a specific question and restrict affected work while unrelated tasks and necessary investigations continue. |
| Confidence in an AI's completed work | Send every work result through independent review. Findings return to the original task for another work and review round. |
| Delivery that continues beyond a code merge | Continue release, migration, or verification when required by the task. Check milestone acceptance evidence and add tasks for anything still missing. |

### Plans evolve. Goals stay clear.

Suppose you want to complete a Social migration. Start with a milestone and let Codex investigate existing consumers and break down the migration. If execution uncovers a missed consumer, the plan can gain another migration task. If the change would alter product behavior, Codex explains the impact and asks for your decision first.

When all tasks finish, Codex checks whether the migration meets its acceptance criteria. Missing runtime evidence leads to more verification work; a completed task count alone does not complete the milestone.

The project's `PROJECT.md` holds lasting product facts and rules. Milestones describe stage goals; tasks describe concrete deliverables. **Adding everyday work does not require rewriting the product contract.**

## Get started

You need **Node.js 24 or newer, Git, and Codex App**, with a working Codex login (using credentials in `~/.codex` by default).

```bash
npm install --global codrive@latest
codrive setup
codrive
```

`setup` installs the bundled Skills and activity Hook. When Codrive starts, the terminal prints your local board URL.

1. Run `/hooks` in Codex, then review and trust the four Codrive activity Hook definitions.
2. Open your project directory in Codex App.
3. Describe the work and ask Codex to use Codrive. Confirm the plan to start execution.

For example:

```text
Use Codrive to add a leaderboard to this project.
Confirm the scope and acceptance criteria with me, then create a milestone and start the work.
```

Keep using ordinary conversation for follow-up work:

| Intent | Example request |
| --- | --- |
| Add a small task | Use Codrive to add an independent task: fix the settings page's return link and verify that it opens the project. |
| Adjust a plan | The leaderboard also needs weekly rankings. Assess the impact with me, then update the milestone plan. |
| Check progress | Check this project's Codrive progress. What needs a decision from me? |
| Pause scheduling | Pause scheduling of further tasks for this project. |

## Follow the board. Make decisions in context.

- **The task board** shows work across its stages, including completed and cancelled tasks. Active milestone cards filter the board; with none selected, all tasks remain visible.
- **The milestone page** brings together goals, acceptance criteria, open questions, and related tasks. Completed milestones remain available for reference.
- **Task details** show activity history, a current execution summary, review results, and conversation links. You can cancel unfinished tasks while no AI is executing. Recovery controls appear when applicable, and scheduled waits can be rescheduled or resumed early.
- **Project information** has its own page for product documentation and project model settings. Archiving preserves history; restoring a project leaves scheduling paused until you resume it.

Planning, milestone assessment, task execution, and independent review all use visible, persistent Codex conversations under the project. You can inspect the process, add context, and participate when a decision needs you.

## Work at your pace

Settings let you choose project concurrency, primary and fallback models, and each model's reasoning effort. Projects can inherit global model settings or override them. Changes take effect on the next execution turn.

When model capacity is unavailable, Codrive retries and can switch to the configured fallback. Scheduled waits release capacity and resume when due. Confirmed interruptions can recover through the original conversation. Issues requiring your attention stay recorded in the details.

If you already use Semantic Atlas, you can enable automatic maintenance in settings. After relevant code work completes, ordinary tasks maintain your project's business knowledge. See [Semantic Atlas automatic maintenance](./docs/architecture/semantic-atlas-maintenance.md).

### Updates and everyday commands

While running, Codrive periodically checks for new versions and shows an update prompt on the board. You initiate installation, either there or with `codrive upgrade`. The upgrade installs the new version, migrates supported local data, synchronizes Skills and the Hook, then restarts and verifies the service. If Hook definitions change, review and trust them again through Codex's `/hooks`.

| Command | Purpose |
| --- | --- |
| `codrive` | Start the service and local board in the background |
| `codrive status` | Check local service status |
| `codrive stop` / `codrive restart` | Stop or restart the service |
| `codrive upgrade` | Update to the latest version |
| `codrive setup` | Initialize or repair managed Skills and the Hook |
| `codrive doctor` | Check the environment, login, and managed resources |
| `codrive serve` | Run in the foreground |

## Local data and execution access

Codrive stores project state, activity history, and logs in `~/.codrive` by default. Its local service listens only on `127.0.0.1` and requires an access token. AI requests still use the model service configured through Codex.

Automatic tasks have full local access: they can edit files, execute commands, test, commit, and merge without individual terminal approvals. Use trusted repositories and give tasks clear goals and authorization boundaries.

## Learn more and contribute

Codrive ships four Skills with distinct roles:

| Skill | Purpose |
| --- | --- |
| `$codrive-forge` | Turn initial product goals into a project, milestones, and tasks |
| `$codrive-work` | Add work or adjust plans in an existing project |
| `$codrive-task` | Select work, assess milestones, and execute task stages |
| `$codrive-control` | Check progress, maintain product facts, and control execution |

For implementation details, read [Milestones and continuous planning](./docs/architecture/milestones.md), [Product facts lifecycle](./docs/architecture/product-facts.md), and [Board realtime synchronization](./docs/architecture/realtime-sync.md).

Local development uses Node.js 24 or newer and pnpm 11.5.1:

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
