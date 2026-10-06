# Caller skill

Harness Relay ships one caller-side skill, `harness-relay`. Each release pins it
to the CLI of the same version. Its `SKILL.md` holds the shared procedure and
routes by intent to reference files that the agent loads only when needed:

| The user wants                                              | Where the skill continues |
| ----------------------------------------------------------- | ------------------------- |
| One bounded analysis or implementation task delegated       | `SKILL.md` core procedure |
| A route and effort chosen from route guidance and billing   | `references/routing.md`   |
| An independent second opinion or a review by several models | `references/review.md`    |
| To steer a running delegate or continue a finished one      | `references/dialogue.md`  |
| To register or prepare a named login for a harness          | `references/setup.md`     |

The skill runs in the caller's context. The caller remains the root, owns the
working directory and user constraints, and makes the final decision. The skill
uses `describe --json` to discover the installed contract and preserves failed
or incomplete outcomes.

Earlier releases shipped separate skills (`harness-relay`,
`harness-relay-second-opinion`, `harness-relay-review`, `harness-relay-routing`,
and `harness-relay-setup`). After updating, remove the retired ones from your
agents, for example with `npx skills remove`, so they do not compete with the
combined skill.

## Install the CLI

The CLI requires Node.js 22 or newer. Install the public release globally or
run it without a global install:

<!-- x-release-please-start-version -->

```sh
npm install --global harness-relay@0.5.1
harness-relay describe --json

# Or, for one-off use:
npx --yes harness-relay@0.5.1 describe --json
```

<!-- x-release-please-end -->

Without a selected connection, the CLI uses the harness's default native
session. The `connection.*` operations described below add explicitly selected
native contexts. The CLI never accepts credentials as arguments.

## Harness prerequisites

Harness Relay supervises an installed harness; it does not install the harness
or create its native login. Install at least one supported harness and
complete its native sign-in before expecting a qualified default route:

| Harness     | Install                                          | Native login/setup                                                                                                                             |
| ----------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex CLI   | `npm install --global @openai/codex`             | Run `codex login` and complete the browser sign-in. See the [Codex CLI documentation](https://developers.openai.com/codex/cli/).               |
| Claude Code | `npm install --global @anthropic-ai/claude-code` | Run `claude` and complete the authentication flow. See [Anthropic's Claude Code setup guide](https://code.claude.com/docs/en/getting-started). |
| Grok Build  | Install Grok Build from xAI                      | Run `grok login`; `grok models` shows whether the account is signed in.                                                                        |

Confirm the native executable is on `PATH` (`command -v codex` or
`command -v claude`), then restart the relay broker if the harness was added or
its environment changed. Check the qualified result with
`harness-relay routes --json`. A missing login, adapter, or qualified route is
reported as unavailable; the relay does not silently substitute a different
model or harness. Local models run through the optional Pi SDK instead of a
harness CLI; see [local model setup](local-models.md).

## Set up another native context

Ask the `harness-relay` skill to set up a login, or use the same CLI/MCP operations to
register a context the user already configured or prepare a separate private
context. For example:

```sh
harness-relay connections discover --refresh --json
harness-relay connections prepare --id implementation --harness codex --json
harness-relay connections inspect implementation --json
```

`prepare` creates an empty private context and returns structured login
instructions (`executable`, `args`, and `env`). The user runs the native
authentication flow. Relay never asks for credentials, copies login files,
starts a login command, or changes the default account. A context label and a
ready route do not prove which account is signed in. Use a stable ID when
repeating setup; an identical prepare or registration reuses the existing
revision instead of adding a duplicate.

## Install the skills with the public Skills CLI

The [Vercel Skills CLI](https://github.com/vercel-labs/skills) installs public
Git skills for Codex, Claude Code, and other supported agents. A project
install is the default; add `--global` for a user-level install. The command
below reads the published release tag into a temporary checkout and copies the
skills so cleanup cannot leave broken symlinks:

<!-- x-release-please-start-version -->

```sh
skill_checkout="$(mktemp -d)"
trap 'rm -rf "$skill_checkout"' EXIT
git clone --branch v0.5.1 --depth 1 \
  https://github.com/sebastian-software/harness-relay.git \
  "$skill_checkout/harness-relay"
npx skills add "$skill_checkout/harness-relay" \
  --skill harness-relay \
  --agent codex claude-code --global --copy --yes
```

<!-- x-release-please-end -->

Omit `--global` to install into the current project. Omit `claude-code` when
only Codex should receive the skill. To inspect the installed result:

```sh
npx skills list --global --agent codex
```

Before setting up a login, run `harness-relay describe --json` and confirm
that `connection.discover`, `connection.list`, `connection.inspect`,
`connection.register`, `connection.prepare`, `connection.update`, and
`connection.remove` are all marked `implemented`; releases before 0.2.0 lack
them. Because `describe` is answered locally, an older broker that is still
running can lack the operations even when the CLI has them. If an operation
reports unsupported, inspect it with `broker status --json` and
`list --active --json`, then run `broker restart` without `--force` only when
no invocations are active; otherwise wait for them to finish.

## Optional Dalo catalog installation

Dalo can manage the skill as an untrusted catalog. The standalone catalog
command pins the catalog checkout itself and intentionally has no `--version`
option. Inspect, select, approve, and sync explicitly:

```sh
dalo source add-catalog harness-relay \
  https://github.com/sebastian-software/harness-relay.git
dalo source inspect harness-relay
dalo source select harness-relay harness-relay
dalo approve skill harness-relay:harness-relay
dalo sync
```

For a Dalo team catalog, `team catalog add` does support an exact version
reference. Team members still select, approve, and sync the skill:

<!-- x-release-please-start-version -->

```sh
dalo team catalog add relay \
  https://github.com/sebastian-software/harness-relay.git \
  --version v0.5.1 \
  --skill +harness-relay
dalo approve skill relay:harness-relay
dalo sync
```

<!-- x-release-please-end -->

Use `dalo target link codex` before syncing if the Codex target has not been
linked in the Dalo store. Dalo's audit and approval records describe what was
selected and accepted; they do not change the Harness Relay route or model
resolution rules.

## Discover the contract and skill

After installation, ask the CLI for the live operation surface and routes:

```sh
harness-relay describe --json
harness-relay routes --json
```

Use `npx skills list` for project skills or `npx skills list --global` for
user-level skills. The skill files are also visible in the versioned
[`skills/`](../skills/) source tree. The bridge contract remains in
[`docs/contract.md`](contract.md), and the command examples and flags remain
in [`docs/cli.md`](cli.md); the skill intentionally does not duplicate those
manuals.
