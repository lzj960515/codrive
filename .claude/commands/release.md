---
description: Verify, version, publish, and push the Codrive npm package
argument-hint: [patch|minor]
allowed-tools: Bash, Read
---

# Codrive Release Command

Codrive is an npm-only release. It has no database migration or deployment step.

## Version input

`$ARGUMENTS` must be one of:

- `patch` for backward-compatible fixes.
- `minor` for backward-compatible features.

Use `patch` when no argument is provided. Commit the release candidate before starting this workflow so `npm version` creates a dedicated version commit and tag.

## Execution steps

### 1. Confirm repository state

```bash
git fetch origin
git status --short --branch
git merge-base --is-ancestor origin/main HEAD
```

Run the release from `main` with a clean worktree. The local branch may be ahead of `origin/main`, but it must contain the current remote branch.

### 2. Confirm npm access and current version

```bash
npm whoami
npm view codrive version --json
```

The local `package.json` version must equal the published npm version before bumping. Resolve authentication or version drift before creating a release commit.

### 3. Verify the package

```bash
pnpm test
pnpm typecheck
pnpm build
npm pack --dry-run --silent
```

Read the command results and stop before versioning when any check fails.

### 4. Bump the version

```bash
npm version <patch|minor> -m "chore(release): bump version to %s"
```

This updates `package.json`, creates a Conventional Commit, and creates the matching `v<version>` Git tag.

### 5. Publish to npm

```bash
npm publish --access public
```

### 6. Push the release commit and tag

```bash
git push origin main --follow-tags
```

### 7. Verify the published release

```bash
npm view codrive@<version> version dist-tags.latest --json
git ls-remote --tags origin refs/tags/v<version>
git status --short --branch
```

## Failure semantics

- When npm authentication fails, stop before `npm version`.
- When `npm publish` fails before the registry accepts the version, preserve the local version commit and tag, fix the cause, and retry the same version.
- When npm accepts the version but Git push fails, retry the same push. Keep npm and Git on one version instead of bumping again.

---

**Now execute the Codrive release using `$ARGUMENTS`.**
