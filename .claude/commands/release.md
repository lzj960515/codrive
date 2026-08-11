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

### 5. Publish through npm's interactive authentication lifecycle

Run the publish command in a persistent interactive TTY with stdin and stdout
attached. Enable the execution tool's PTY/TTY option and retain its session so
input and later output continue through the same `npm publish` process.

```bash
npm publish --access public
```

npm 11 handles publish-time Web OTP only when both streams are TTYs. When the
live process prints `Press ENTER to open in the browser...`, write one newline
to that same session. npm owns the authentication URL, opens the exact URL in
the system browser, polls its completion URL, and then retries the registry
request with the returned one-time token.

Keep waiting on the same `npm publish` process while the user completes any
required npm login or authorization in the opened browser. Treat
`+ codrive@<version>` and a zero exit code as the publish result. Browser
automation is not part of this release flow: authentication URLs are opaque
runtime state and tool output can redact their identity before another browser
receives them.

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

- When `npm whoami` fails, restore npm access before `npm version`.
- When a publish attempt reports Web OTP without waiting, rerun `npm publish` for the same version in an interactive TTY and complete npm's in-process browser flow.
- When browser authorization needs user interaction, keep the publish session alive and ask the user to finish that exact npm page.
- When `npm publish` exits ambiguously, query `npm view codrive@<version> version --json` before deciding whether the registry accepted it.
- When the registry has not accepted the version, preserve the local version commit and tag, fix the cause, and retry the same version.
- When npm accepts the version but Git push fails, retry the same push. Keep npm and Git on one version instead of bumping again.

---

**Now execute the Codrive release using `$ARGUMENTS`.**
