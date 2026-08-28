<div align="center">

# Cassandra

**She spoke truly and no one checked.**
**Cassandra remembers the tool calls that already failed you.**

[![Release](https://img.shields.io/github/v/release/AraneaDev/cassandra?label=release&include_prereleases)](https://github.com/AraneaDev/cassandra/releases)
[![Project page](https://img.shields.io/badge/project%20page-aranea--development.nl-0b7285)](https://aranea-development.nl/en/projects/cassandra)
[![Tests](https://img.shields.io/badge/tests-145%20passing-2b8a3e)](test/)
[![License](https://img.shields.io/github/license/AraneaDev/cassandra?label=license&color=yellow)](./LICENSE)
[![Language](https://img.shields.io/github/languages/top/AraneaDev/cassandra)](https://github.com/AraneaDev/cassandra)
[![Last commit](https://img.shields.io/github/last-commit/AraneaDev/cassandra?label=last%20commit)](https://github.com/AraneaDev/cassandra/commits/main)
[![Conventional Commits](https://img.shields.io/badge/commits-conventional-fe5196?logo=conventionalcommits&logoColor=white)](https://www.conventionalcommits.org/)
[![Status](https://img.shields.io/badge/status-pre--release-orange)](#install)

</div>

---

> Cassandra (Κασσάνδρα) was given true prophecy by Apollo, and the curse that came with
> refusing him: everyone would hear her, and no one would believe her. This tool does the
> smaller, duller version. It does not prophesy anything, it only remembers what already
> happened, and it only ever advises. It cannot block a call, deny one, or rewrite one.

Cassandra is a Claude Code plugin that remembers the `Bash` and `mcp__*` tool calls that
already failed in a project, and says so before your agent runs one of them again with
nothing in the project changed. It hooks the tool-call lifecycle, fingerprints the call
rather than reading it as prose, and keeps one record per distinct failure.

Inside one intact context window an agent can usually see the failure itself, a few
thousand tokens back in its own transcript, and correct course without help. Cassandra
earns its place at the boundaries where that transcript is gone: compaction, a new
session, or a subagent spawned fresh with no idea the parent already burned several calls
on this exact command. Outside those boundaries it deliberately stays quiet.

> **Status:** pre-release. Cassandra installs from source and requires
> [Bun](https://bun.sh/) 1.1 or newer on the machine running Claude Code. The first
> session after install builds the hook binary and the plugin is active from the second
> one, which [Install](#install) covers. Without Bun on `PATH` it stays inert for good and
> says so once, at session start.

---

## Why it exists

Three boundaries, and they are the whole reason this exists:

- **Compaction.** The failed call drops out of context. The record does not.
- **A new session.** Yesterday's dead end is invisible today.
- **Subagent isolation.** A freshly spawned agent has no knowledge that the main agent
  already burned four calls on this exact command.

Anything Cassandra says inside an intact context window is close to redundant, since the
model can usually already see the failure a few messages back. It is built to stay quiet
there, not to narrate what you can already see.

## Scope: what it watches

Only `Bash` and `mcp__*` calls. `Edit` and `Write` payloads never repeat byte for byte,
even when the edit is functionally the same fix twice, so they are deliberately left out
of the index rather than indexed and never matching.

Cassandra never reads your prompts or the model's prose. It fingerprints `tool_name` plus
`tool_input`, both structured JSON, so the match is deterministic and says nothing about
which language you or the agent are working in. A `Bash` command is trimmed and has runs
of whitespace collapsed before hashing, nothing else: no path canonicalization, no flag
reordering, no stripping of trailing pipes or redirects, since each of those can quietly
merge two different commands into one. An `mcp__*` call is hashed on the raw `tool_input`
as delivered.

There is one piece of free text it does read, and it is worth knowing about. When a call
fails or is denied, Cassandra keeps a 240-character excerpt of that tool's own
`error_message` or `denial_reason`, writes it to the record on disk, and quotes it back in
the warning so you can see why the call died last time. That excerpt is output from a
command, not from you and not from the model, and it is treated as untrusted: control
characters are stripped before it is stored, and the warning fences it and labels it as
tool output rather than as an instruction.

## Install

```bash
claude plugin marketplace add AraneaDev/cassandra
claude plugin install cassandra@cassandra
```

Hooks bind when a session starts, so the first session after install finds no hook binary
yet, builds it in the background, and says so. Cassandra becomes active from the second
session onward. The binary is around 79MB, because `bun build --compile` embeds the Bun
runtime to produce it, which is why it is gitignored rather than committed and built on
first use instead.

## Is it working? `cassandra stats`

Two numbers matter. The false-positive rate is the share of resolved warnings where the
warned call went on to succeed anyway, meaning the freshness probe missed a real change.
The `same_context` share is the share of warnings where nothing crossed a boundary at
all, so the model could plausibly have already seen the failure in its own transcript.

A high false-positive rate means the freshness probe needs work. A high `same_context`
share is not a tuning problem. It means Cassandra is mostly telling the model things it
could already see, and the signal to act on is to uninstall it, not to adjust it.

## How it decides whether to warn

On `PreToolUse`:

1. Fingerprint the call and look up the hash. A miss, the overwhelming majority of calls,
   exits silently.
2. On a hit, run the freshness probe. If the workspace has moved since the failure, the
   retry is legitimate and Cassandra stays silent.
3. If the workspace is unchanged, it emits one line of `additionalContext` and exits.

## The freshness probe

In a git repository, the workspace stamp is a hash of `HEAD` plus
`git status --porcelain`. Outside git it falls back to a bounded mtime walk of the working
directory. If the probe cannot tell either way, it stays silent rather than guess: a wrong
warning is worse than a missed one.

A false-positive harness applies nine mutation shapes across both the git and mtime paths
and currently detects 18 of 18, at a 0.0% false-positive rate. A separate check against a
headless repository, one with no commits at all, passes 9 of 9.

One gap is inherent to a metadata-only probe rather than a bug in it: a file rewritten to
different content of the same length, with its mtime restored afterward, is not detected
on the mtime path. The harness reports it.

A second gap is inherent to stamping a directory at all: the probe only ever sees the
project. A fix that lands somewhere else, a package installed globally, an environment
variable, a service started, a credential refreshed, leaves the stamp identical, so
Cassandra reads the state as unchanged and warns about a call that would now succeed. The
warning names the scope it actually checked, `Nothing in this repository has changed
since`, or `Nothing in this directory tree has changed since` on the mtime path, so the
claim stays true even where the probe is blind.

The mtime walk is bounded at depth 6 and 5000 entries, so a tree exceeding either could
yield a stamp covering only part of it. Measured across 71 real repositories on the
development machine, zero project directories actually truncated; the only tree that did
was a `node_modules` directory. The full numbers are in
[`docs/freshness-baseline.md`](docs/freshness-baseline.md).

## Overhead

Roughly 12ms per hook invocation on an idle machine, 17ms under load, against a 20ms
design budget. That cost is paid on every `Bash` and `mcp__*` call, whether or not
Cassandra ever has anything to say.

A tool call is not one invocation. `PreToolUse` and `PostToolUse` are wired to the same
matcher, so a call that succeeds spawns the binary twice: about 12.9ms before the call and
12.2ms after it, roughly 25ms in total. Measured against a per-invocation budget of 20ms
each invocation fits; measured per successful call, it does not.

That second invocation is deliberate and worth being plain about. `PostToolUse` is what
resolves the pending marker, and the marker is the only way Cassandra can tell that a call
it warned about then went on to succeed. Remove the hook and the false-positive rate in
`cassandra stats` stops existing, which is the number that tells you whether the freshness
probe is working at all. You pay about 12ms on every successful call to keep the tool
measurable, and that is the trade being made.

## Commands

| Command | Does |
| --- | --- |
| `cassandra list` | records remembered for this project |
| `cassandra why <hash>` | one record in full, including the error excerpt |
| `cassandra forget <hash>` | drop one record |
| `cassandra forget --all` | drop every record for this project |
| `cassandra stats` | whether the warnings are earning their place |
| `cassandra export` | the whole index as JSON |

All of them accept an optional `--cwd <path>` to act on a project other than the current
directory. A `/cassandra` slash command runs `list` inside a session, and switches to
`why <hash>` or `stats` when you ask it to.

## What Cassandra does not do

- It never blocks, denies, or rewrites a call. The only thing it can add is one line of
  `additionalContext`.
- It never reads your prompts or the model's prose. The match is on structured
  `tool_name` and `tool_input` JSON.
- It does keep one piece of free text: a 240-character excerpt of the failing tool's own
  error output or denial reason, stored with the record and quoted back, fenced, in the
  warning. That is the whole of what it reads beyond the call itself.
- It never leaves the machine. There is no network request, no telemetry, no API key.
- It stores nothing outside its own data directory.

## A note on the hook contract

Both web renderings of the official Claude Code hooks reference state that
`additionalContext` is not supported on `PreToolUse`. That is wrong. The changelog adds it
in 2.1.9 and fixes a delivery bug in 2.1.110. Cassandra's entire read path depends on that
field reaching the model, so if you are touching this, verify hook output fields against
the changelog, not the reference page.

## Requirements

Bun 1.1.0 or newer. Without it, the plugin is inert and says so once, at session start.

## Development

```bash
bun install
bun run check      # lint, lint:docs, typecheck, knip, then the full suite with coverage
bun run fp         # synthetic freshness-probe harness
bun run fp:real    # freshness probe against real repositories on this machine
```

## License

MIT.
