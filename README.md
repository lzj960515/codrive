<div align="center">
  <h1>Codrive</h1>
  <p><strong>Automated task management for Codex App.</strong></p>

  <p>
    <a href="https://www.npmjs.com/package/codrive"><img alt="npm version" src="https://img.shields.io/npm/v/codrive?style=flat-square&color=cb3837"></a>
    <a href="https://github.com/lzj960515/codrive/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/lzj960515/codrive/ci.yml?branch=main&style=flat-square&label=ci"></a>
    <a href="https://www.npmjs.com/package/codrive"><img alt="Node.js version" src="https://img.shields.io/node/v/codrive?style=flat-square&color=43853d"></a>
    <a href="./LICENSE"><img alt="MIT License" src="https://img.shields.io/github/license/lzj960515/codrive?style=flat-square&color=2d5b46"></a>
  </p>

  <p><strong>English</strong> · <a href="./README.zh-CN.md">简体中文</a></p>
</div>

## What is Codrive?

Codrive is a local task manager for **Codex App**. It organizes agreed goals into milestones and tasks, coordinates execution, independent review, and acceptance, and displays progress on a board.

<p align="center">
  <img src="https://raw.githubusercontent.com/lzj960515/codrive/main/docs/images/codrive-board.jpg" alt="Codrive board with milestones, tasks, and activity">
</p>

## Why Codrive?

- **Automatic execution:** Break down goals and schedule tasks, including independent work for small changes.
- **Adaptive planning:** Add tasks and revise plans as new findings emerge. Decisions beyond the authorized scope come back to you.
- **Independent review:** Review every work result independently and verify milestone completion against acceptance evidence.
- **Visible progress:** Follow the board and revisit planning, execution, and review in project conversations. Join at any time.

## Get started

Requires **Node.js 24+, Git, and Codex App** with a working Codex login.

```bash
npm install --global codrive@latest
codrive setup
codrive
```

`setup` installs the bundled Skills and activity Hook. The terminal prints your board URL.

1. In Codex, run `/hooks` and review and trust the four Codrive activity Hook definitions.
2. Open your project in Codex App and describe your goal:

   > Use Codrive to plan and carry out this work. Confirm the scope and acceptance criteria with me before starting.

Continue in conversation to add work, adjust plans, check progress, or pause scheduling.

## Everyday commands

| Command | Purpose |
| --- | --- |
| `codrive` | Start the local service |
| `codrive status` | Check service status |
| `codrive stop` / `codrive restart` | Stop or restart |
| `codrive upgrade` | Update to the latest version |
| `codrive doctor` | Check the environment and setup |

## Local operation

Codrive runs on your computer after installation and keeps its project and task records locally. AI requests use your configured Codex model service.

**Automatic tasks have full local access**, including file edits, commands, and Git operations without individual terminal approvals. Use trusted repositories and define the work's authorization boundaries.

## Development

Use Node.js 24+ and pnpm 11.5.1:

```bash
corepack enable
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm dev
```

Read more: [Milestones and planning](./docs/architecture/milestones.md) · [Product facts](./docs/architecture/product-facts.md) · [Board synchronization](./docs/architecture/realtime-sync.md) · [Semantic Atlas integration](./docs/architecture/semantic-atlas-maintenance.md).

[MIT License](./LICENSE)
