# Releasing

`@sebastian-software/agent-bridge` releases are automated. Nothing is published
by hand.

## How a release happens

1. Every pull request lands with a Conventional Commit title. CI checks the
   title, because release-please derives the next version and the changelog
   entry from the squashed commit.
2. On every push to `main`, `.github/workflows/publish.yml` runs release-please.
   It maintains a single release pull request that bumps `package.json`,
   regenerates `src/version.ts` and prepends a `CHANGELOG.md` entry.
3. Merging that pull request creates the tag (`v<version>`) and the GitHub
   Release, and the same workflow then publishes the tag to npm with
   `pnpm publish --provenance --access public`.

The publish job checks out the release tag, never `main`, and runs `pnpm check`
before publishing.

## Configuration the automation depends on

- **npm Trusted Publishing** for `@sebastian-software/agent-bridge`, bound to
  repository `sebastian-software/agent-bridge` and workflow `publish.yml`. The
  job requests an OIDC token (`id-token: write`) and consumes no `NPM_TOKEN`.
  Until Trusted Publishing is configured, the publish step fails at
  authentication; the release itself is unaffected and the publish can be
  retried afterwards.
- **`RELEASE_PLEASE_TOKEN`** (optional). Events created with the built-in
  `GITHUB_TOKEN` do not start new workflow runs, so without this token the
  release pull request has no CI checks. Everything else works.

## Retrying a failed publish

Dispatch `publish.yml` manually with the release tag, for example `v0.1.1`. The
manual path skips release-please, checks out that tag and republishes it, so a
delayed retry can never publish newer sources under a version that already
exists.

## Version bootstrap

`.release-please-manifest.json` starts at `0.1.0`, the hand-written
`CHANGELOG.md` entry for the never-published first version. The
`bootstrap-sha` in `release-please-config.json` marks the last commit that
entry covers; the next generated changelog starts after it. Remove
`bootstrap-sha` once the first generated release pull request has merged.
