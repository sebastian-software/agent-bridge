# Releasing

`harness-relay` releases are automated. Nothing is published by hand.

## First usable public release

The target for the first usable public release is **0.1.0**, retaining the
Developer Preview scope in [ADR-0007](adr/0007-typescript-and-unix-first.md).
The existing npm version `0.0.0` reserves the package name and contains no CLI.

The release must provide a working CLI and installable skills for general
delegation, an independent second opinion, and a review with multiple models
from public sources. Documented installation steps are sufficient; a custom
installer is not a release requirement. The skill boundary is recorded in
[ADR-0023](adr/0023-ship-caller-side-delegation-and-workflow-skills.md).

The version bootstrap below defines how the release pull request reaches this
target without treating the reserved npm placeholder as a prior release.

## First-release acceptance

The release candidate must pass the repository's existing macOS and Linux
checks and demonstrate the following:

The latest runtime qualification evidence and its limits are recorded in the
[0.1.0 qualification record](qualification/2026-09-16-release-0.1.0.md).

- The packed CLI installs and runs outside the development checkout, with all
  required runtime files included.
- All three skills are discoverable and usable in Claude Code and Codex through
  documented installation steps. The documentation identifies the public skill
  source and version as well as Node.js, harness installation, and native login
  prerequisites.
- Real Claude and Codex invocations exercise the delegation path. Second-opinion
  and multi-model review reports identify their contributors, retain differing
  findings, and expose failed or incomplete contributions.
- Regression checks cover process cleanup after errors, incomplete native
  output, policy argument mapping, and configured model aliases.
- The generated release candidate consistently identifies version `0.1.0`.
- npm Trusted Publishing is configured for the actual repository and workflow
  before the publish job is enabled for the release.

After publication, repeat the documented installation from the public npm
registry and the versioned public skill source. Successful tests against a local
tarball alone do not establish public installability.

## How a release happens

1. Every pull request lands with a Conventional Commit title. CI checks the
   title, because release-please derives the next version and the changelog
   entry from the squashed commit.
2. On every push to `main`, `.github/workflows/publish.yml` runs release-please.
   It maintains a single release pull request that bumps `package.json`,
   regenerates `src/version.ts`, moves the version pins in `docs/skills.md`
   and the caller skills (marked with `x-release-please-version`), and
   prepends a `CHANGELOG.md` entry.
3. Merging that pull request creates the tag (`v<version>`) and the GitHub
   Release, and the same workflow then publishes the tag to npm with the shared
   `publish-npm` action. The action derives `latest` for stable versions,
   preserves a prerelease dist-tag for candidates, and attaches provenance.

The publish job checks out the release tag, never `main`, and runs `pnpm check`
before publishing. It resolves the ref under `refs/tags/` and rejects a tag
unless its SemVer value exactly matches the checked-out `package.json` version.

## Configuration the automation depends on

- **npm Trusted Publishing** for `harness-relay`, bound to this repository and
  the `publish.yml` workflow, with the `npm-release` environment. Configuring
  it is the repository owner's one manual step. The job requests an OIDC token
  (`id-token: write`) and consumes no `NPM_TOKEN`. Until Trusted Publishing is
  configured, the publish step fails at authentication; the release itself is
  unaffected and the publish can be retried afterwards.
- **`RELEASE_PLEASE_TOKEN`** (optional). Events created with the built-in
  `GITHUB_TOKEN` do not start new workflow runs, so without this token the
  release pull request has no CI checks. Everything else works.

## Retrying a failed publish

Dispatch `publish.yml` manually with the release tag, for example `v0.1.1`. The
manual path skips release-please, checks out that tag and republishes it, so a
delayed retry can never publish newer sources under a version that already
exists.

## Version bootstrap

The first-release bootstrap is now represented by an empty
`.release-please-manifest.json` and an explicit top-level `initial-version` of
`0.1.0` in `release-please-config.json`. There is no `bootstrap-sha`: the first
candidate includes the repository history that belongs in the public release.
The hand-written versioned changelog entry was removed so Release Please owns
the first `0.1.0` entry and does not create duplicate release notes.

Before merging the first release pull request, inspect the generated candidate
and confirm all of the following:

1. There is one release PR for the root component and its proposed version is
   exactly `0.1.0` (not `1.0.0` or a second release).
2. The candidate keeps `package.json`, `src/version.ts`, and the generated CLI
   output on the same `0.1.0` version.
3. `CHANGELOG.md` has one generated `0.1.0` entry containing the intended CLI,
   broker, schema, and skill changes.
4. A package dry run contains `dist/src`, `schemas`, `skills`, and the public
   skill documentation, and the packed CLI runs outside the checkout.
5. The release commit creates tag `v0.1.0`; the publish job checks out that tag
   under `refs/tags/`, verifies its package-version match, and does not publish
   from `main`.

After the tag is published, repeat the installation smoke check from the
public registries. For example, install `harness-relay@0.1.0` from npm in a
fresh temporary directory, run `npx harness-relay --version`, and verify the
output is `0.1.0`. Then install each skill from the versioned public source and
confirm the three documented skill directories are discoverable. These checks
establish public installability; a local tarball check alone does not.

The shared [Release Please reference](https://github.com/sebastian-software/standards/tree/main/reference/release-please)
provides the single-product release pattern. The pinned Release Please action
uses the `release-please` 17.6.0 implementation, which supports the explicit
`initial-version` setting. The npm publisher is pinned to the
`standards-v0.12.0` `publish-npm` action. The repository does not verify the
external npm Trusted Publisher or environment configuration; the owner must
complete and validate that setup before publishing.
