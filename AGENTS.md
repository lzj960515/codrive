# Codrive Agent Guide

Codrive is a local, single-user orchestration service that connects filesystem-backed product state, Codex App Server conversations, and reusable Skills.

## Architecture

- `src/domain` owns project, task, execution, report, and event contracts.
- `src/application` owns deterministic workflow decisions and dispatch coordination.
- `ProjectExecutionCoordinator` owns temporary task-selection and product-evaluation turns.
- `src/infrastructure` owns filesystem persistence, App Server transport, and Skill installation.
- `src/interfaces` owns the HTTP API, CLI, and local board.
- `skills` contains the product's installable Codex Skills.

Project-level Codex turns decide which backlog tasks should start from current product and repository facts. Codrive validates IDs, task availability, each project's concurrency budget, and the repository integration lease. Codex reevaluates task relationships during every selection.

The HTTP surface has three boundaries: board reads, Skill context reads, and the unified `/api/commands` write endpoint. State transitions belong to `WorkflowEngine`, not route handlers.

Keep Git worktree creation, coding, review, conflict resolution, commits, merges, and cleanup inside Codex task instructions. Codrive persists state and dispatches conversations; it does not implement those Git workflows.

## Commands

```text
pnpm test
pnpm typecheck
pnpm build
pnpm dev
```

Use Node.js 24 for development. Keep the published package compatible with Node.js 20 or newer.
