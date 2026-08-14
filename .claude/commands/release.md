---
description: Verify, version, push, and monitor the Codrive npm release
argument-hint: [patch|minor]
allowed-tools: Bash, Read
---

# Codrive Release Command

Codrive is an npm-only release. It has no database migration or deployment
step. The local command verifies and versions the release, then pushes its Git
commit and tag. The `Release` GitHub Actions workflow owns npm authentication
and publication through the protected `npm` environment.

## Version input

`$ARGUMENTS` must be one of:

- `patch` for backward-compatible fixes.
- `minor` for backward-compatible features.

Use `patch` when no argument is provided. Commit the release candidate before
starting this workflow so `npm version` creates a dedicated version commit and
tag.

## Execution steps

### 1. Confirm repository state

```bash
git fetch origin
git status --short --branch
git merge-base --is-ancestor origin/main HEAD
```

Run the release from `main` with a clean worktree. The local branch may be
ahead of `origin/main`, but it must contain the current remote branch.

### 2. Confirm the current version

```bash
npm view codrive version --json
```

The local `package.json` version must equal the published npm version before
bumping. Resolve version drift before creating a release commit.

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
version="$(node -p "require('./package.json').version")"
```

This updates `package.json`, creates a Conventional Commit, and creates the
matching `v<version>` Git tag.

### 5. Push the release commit and tag

```bash
git push origin main --follow-tags
```

The tag push triggers the `Release` GitHub Actions workflow. That workflow
checks that the tag matches `package.json`, repeats package verification, and
publishes with `NPM_TOKEN` from the `npm` environment.

### 6. Follow the automated publication

```bash
release_commit="$(git rev-parse "v${version}^{commit}")"
gh run list --workflow release.yml --commit "$release_commit" --limit 1 --json databaseId,status,conclusion,url
run_id="$(gh run list --workflow release.yml --commit "$release_commit" --limit 1 --json databaseId --jq '.[0].databaseId')"
gh run watch "$run_id" --exit-status
```

GitHub can take a few seconds to expose a newly triggered run. Repeat the two
`gh run list` commands until they return its database ID, then watch that exact
run to completion.

### 7. Verify the published release

```bash
gh run view "$run_id" --json status,conclusion,url,headSha
npm view "codrive@${version}" version dist-tags.latest --json
git ls-remote --tags origin "refs/tags/v${version}"
git status --short --branch
```

Confirm that the workflow succeeded, npm reports the new version as `latest`,
the remote tag points to the release commit, and the local worktree is clean.

## Failure semantics

- When local verification fails, fix the release candidate and repeat the
  checks before `npm version`.
- When the Git push fails, retry the same push so the existing release commit
  and tag stay paired.
- When the workflow fails, run `gh run view "$run_id" --log-failed` and query
  `npm view "codrive@${version}" version --json` before choosing recovery.
- When npm has not accepted the version and the failure is transient or comes
  from environment configuration, repair that boundary and rerun the same
  workflow with `gh run rerun "$run_id" --failed`.
- When a failure requires changing tagged source, keep the version commit and
  pushed tag unchanged while defining an explicit tag-recovery plan.
- When npm already reports the version, preserve that version and reconcile
  Git and workflow evidence without creating another version bump.

---

**Now execute the Codrive release using `$ARGUMENTS`.**
