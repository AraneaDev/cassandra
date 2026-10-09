<div align="center">

# Cassandra

**She spoke truly and no one checked.**
**Cassandra remembers the tool calls that already failed you.**

[![Release](https://img.shields.io/github/v/release/AraneaDev/cassandra?label=release&include_prereleases)](https://github.com/AraneaDev/cassandra/releases)
[![Tool page](https://img.shields.io/badge/tool%20page-aranea--development.nl-0b7285)](https://aranea-development.nl/en/tools/cassandra)
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

**TL;DR:** Cassandra remembers failed `Bash` and `mcp__*` calls and warns before an agent
repeats one without a project change. When a subagent starts or a conversation compacts, it
also hands over one note listing the project's live dead ends. It hooks the tool-call
lifecycle, fingerprints structured call data, and keeps one record per distinct failure.
Agents can also ask Cassandra whether a call already failed, or tell it that something was
fixed elsewhere.

Inside one intact context window an agent can usually see the failure itself, a few
thousand tokens back in its own transcript, and correct course without help. Cassandra
earns its place at the boundaries where that transcript is gone: compaction, a new
session, or a subagent spawned fresh with no idea the parent already burned several calls
on this exact command. Outside those boundaries it deliberately stays quiet.

> **Status:** pre-release. On Claude Code builds that load plugin mods, Cassandra runs in
> process from the first session and needs no Bun. On older builds it falls back to the
> compiled hook binary, which needs [Bun](https://bun.sh/) 1.1 or newer and is active from
> the second session, which [Install](#install) covers. On those builds, without Bun on
> `PATH` it stays inert and says so at session start.

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

At two of those boundaries, a subagent starting and a conversation being compacted,
Cassandra also hands over one note listing the project's live dead ends: at most five,
only those whose workspace stamp still matches, worded like the per-call warning. A fork
subagent gets no note, since it inherits the transcript. Nothing is said at a plain new
session or after a `/clear`.

## Scope: what it watches

Only `Bash` and `mcp__*` calls. `Edit` and `Write` payloads never repeat byte for byte,
even when the edit is functionally the same fix twice, so they are deliberately left out
of the index rather than indexed and never matching.

Cassandra never reads your prompts, and it fingerprints `tool_name` plus
`tool_input`, both structured JSON, so the match is deterministic and says nothing about
which language you or the agent are working in. A `Bash` command is trimmed and has runs
of whitespace collapsed before hashing, nothing else: no path canonicalization, no flag
reordering, no stripping of trailing pipes or redirects, since each of those can quietly
merge two different commands into one. An `mcp__*` call is hashed on the raw `tool_input`
as delivered.

There is one piece of free text it reads from the call's outcome, and it is worth knowing
about (the `resolve` reason, below, is the other). When a call
fails or is denied, Cassandra keeps a 240-character excerpt of that tool's own
`error_message` or `denial_reason`, writes it to the record on disk, and quotes it back in
the warning so you can see why the call died last time. That excerpt is output from a
command, not from you and not from the model, and it is treated as untrusted: control
characters are stripped before it is stored, and the warning fences it and labels it as
tool output rather than as an instruction.

## Install

<!-- aranea-install:start -->
Install from the Aranea marketplace:

```sh
claude plugin marketplace add https://github.com/AraneaDev/aranea-marketplace
claude plugin install cassandra@aranea
```
<!-- aranea-install:end -->

On the classic path, hooks bind when a session starts, so the first session after install
finds no hook binary yet, builds it in the background, and says so. Cassandra becomes
active from the second session onward. Where the mod loads, none of this applies. The binary is around 79MB, because `bun build --compile` embeds the Bun
runtime to produce it, which is why it is gitignored rather than committed and built on
first use instead.

## Is it working? `cassandra stats`

Two numbers matter, plus a third block for briefings. The false-positive rate is the share of resolved warnings where the
warned call went on to succeed anyway, meaning the freshness probe missed a real change.
The `same_context` share is the share of warnings where nothing crossed a boundary at
all, so the model could plausibly have already seen the failure in its own transcript.

A high false-positive rate means the freshness probe needs work. A high `same_context`
share is not a tuning problem. It means Cassandra is mostly telling the model things it
could already see, and the signal to act on is to uninstall it, not to adjust it.

The briefed block counts the briefings handed over, by boundary (subagent or compaction),
and the "repeated after briefing" share: briefed hashes that were then retried across a
boundary anyway. A high share means notes are handed over but not heeded. Like a high
`same_context` share, that is a reason to doubt the feature, not to tune it.

A line reads `resolved by an agent N, failed again M`. N counts records an agent cleared
with `resolve`. M counts those resolved failures that were recorded again after the
resolve. A high M means `resolve` is used to silence warnings rather than to report fixes.
Like the other two, that is a reason to distrust the feature, not to tune it.

The `fix notes` block reads `fixes remembered N, offered again M`. N counts fix notes
recorded. M counts warnings that carried a fix sentence.

## How it decides whether to warn

On `PreToolUse`:

1. Fingerprint the call and look up the hash. A miss, the overwhelming majority of calls,
   exits silently.
2. On a hit, run the freshness probe. If the workspace has moved since the failure, the
   retry is legitimate and Cassandra stays silent.
3. If the workspace is unchanged, it emits one line of `additionalContext` and exits.

A briefing uses the same rule: a record goes into the note only if the workspace is
provably unchanged since it failed.

Any success of a remembered call now forgets it, not only a success after a warning.

### Fix notes

In a git repository, when a remembered failure later succeeds, Cassandra keeps which
files changed in between: committed changes since the failure's `HEAD`, plus files whose
uncommitted state flipped. It then forgets the failure. If nothing inside the repository
changed, the note says the fix was elsewhere. If the failure's commit is no longer
reachable, the note says history was rewritten. There is one note per call (the latest),
at most 10 names, sanitised. Outside git there are no fix notes.

If the call fails again, the warning, the briefing line and `query` add one sentence, for
example: "Last time this started working after `package.json` and `bun.lock` changed
(2026-10-09)." At most 3 names are shown, then "and N more".

## Asking and telling

On the mod path, Cassandra registers two tools, which the engine lists as
`mcp__cassandra__query` and `mcp__cassandra__resolve`. Subagents can call them too. Both
answer only when asked, and Cassandra never records calls to its own tools.

- **`query`** writes nothing. With a `command`, it answers whether that `Bash` command
  already failed in this project, how often and when, the fenced last reason, and whether
  anything in this repository or directory tree changed since. Without a command, it lists
  the live dead ends, at most five plus "…and N more live failures.", each with an 8-character id.
- **`resolve`** is for a fix that happened outside the repository, which the freshness
  probe cannot see. It takes exactly one of `command` or `id`, plus a `reason`. Cassandra
  forgets the record, the same as `cassandra forget` (any fix note stays), and logs a `resolved` stats line with
  the sanitised reason, capped at 240 characters. If the call fails again it is remembered
  again, so a wrong claim costs one failure.

These are mod-only. The classic binary cannot register tools.

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

As a mod, Cassandra's own work costs p50 0.15ms on a miss and 22.77ms on a hit (p95
0.28ms and 24.77ms), measured with `bun run bench:mod` over a node-backed stand-in for
the engine's `$`, 500 calls each. The engine's own `$` dispatch is extra and is not
included, so treat these as a floor. A miss spawns no process. A hit runs `git` for the
freshness probe, which is where its time goes.

For comparison, the binary was timed with `hyperfine` (`-N`, 50 warm runs) against a
temporary data directory and an unchanged repo: a hit is p50 48.20ms (p95 54.41ms) and a
miss p50 31.47ms (p95 33.75ms). The mod figure is an in-process floor that excludes the engine's `$` dispatch, while the
binary figure is a full process measurement, so the two are not like for like. Timing the
same miss payload with 60 runs, `main`'s binary measured
31.6 ± 2.3ms and this branch's 33.8 ± 2.6ms, so the mod port did not cause the binary's
figure.

The binary does not meet the 20ms per-invocation design budget here. Earlier
measurements of roughly 12ms per invocation (17ms under load, 12.9ms before a call and
12.2ms after it) were not reproduced on this machine and should be read as unconfirmed.

A tool call is not one invocation. `PreToolUse` and `PostToolUse` are wired to the same
matcher, so a call that succeeds spawns the binary twice. At the measured miss cost of
about 31ms each, that is roughly 63ms per successful call.

That second invocation is deliberate and worth being plain about. `PostToolUse` is what
resolves the pending marker, and the marker is the only way Cassandra can tell that a call
it warned about then went on to succeed. Remove the hook and the false-positive rate in
`cassandra stats` stops existing, which is the number that tells you whether the freshness
probe is working at all. You pay about 31ms on every successful call to keep the tool
measurable, and that is the trade being made.

## Two front ends

- The mod (`mod/`) runs inside Claude Code and hooks `tool.call`, `agent.spawn`,
  `session.compact` and `session.append`. Its `tool.call` hook sees the call and its
  outcome together and attaches the warning as the tool result's `context`. A spawn or a
  compaction owes the loop a note, which the `session.append` hook hands over at that
  loop's next qualifying row.
- The binary (`src/hook.ts`) is the classic `PreToolUse`, `PostToolUse*`,
  `PermissionDenied` and `PostCompact` path, plus `SubagentStart` and
  `SessionStart` (`source: compact`) for the briefings.
- Both share `src/core/` and one data directory. Where the mod loads, it writes
  `sessions/<id>.mod` under the data directory and the binary stands down for that
  session. The session-start script leaves a pointer to the data directory in
  `~/.cassandra/data-root`, because the mod cannot see `CLAUDE_PLUGIN_DATA`.
- `mod/install.ts` reaches `$` only through a top-level `hostOf($)`, because the engine's
  validator refuses `$` passed anywhere else.

Known gaps and differences:

- A fix note does not name an edit to a file that already had uncommitted changes when
  the call failed.
- A user MCP server named `cassandra` that itself exposes a `query` or `resolve` tool
  would clash with Cassandra's own tools. Its other tools are tracked as usual.
- Mod timing: the mod hands a new subagent its note after the subagent's first tool
  result, when its loop is running and is sure to make another request. A subagent that
  never uses a tool gets no note. If that subagent's very first action repeats a dead end,
  the existing per-call warning still catches it.
- Mod compaction: the mod's compaction note is added just after the compaction, on the
  conversation's next row, never before the compaction boundary, where it would be
  summarised away.
- Binary briefings: the binary uses the classic `SubagentStart` and `SessionStart`
  (`source: compact`) context channels. Both were verified to reach the model, but the
  binary cannot confirm delivery, so it records the `briefed` stat line when it prints the
  note.
- Fork subagents get no note on either front end.
- On a denied repeat, the mod records the warning but cannot show it to the model, since a
  denied result carries no context. The binary shows it.
- A call refused by a permission rule, or one whose approval was not granted, is not
  recorded by either front end. The mod recognises these by the engine's error text.
- The mod detects an interrupt by the dispatch's abort signal. This was verified with
  SIGINT on a headless run, not with Esc in the interactive UI.
- On the mtime path, outside git, a record is matched only by the front end that wrote it.
  The mod's listing is whole-millisecond and the binary's is fractional, so after
  switching front ends the existing non-git records go silent.
- The mod's file listing reports whole milliseconds, so on the mtime path a same-length
  rewrite within the same millisecond as the previous stamp is not detected by the mod.
  The binary detects it.
- If a hot reload of the mod fails mid-session after it claimed the session, nothing
  records for the rest of that session. That only affects development folders, not an
  installed plugin.
- The `/cassandra` slash command and the `cassandra` CLI still run on Bun
  (`bun src/cli.ts`). On a machine with the mod and no Bun they do not work yet.
- The engine smoke tests (`mod/smoke.test.ts`) prove routing. One checks that a tool call
  passes through once, unchanged. One checks that a `query` call reaches Cassandra's own
  tool hook and is answered without being passed on. Neither reaches a real store, because
  the test kit's `$` has no filesystem or process access. The behaviour itself is covered
  by the bun suites against a node-backed stand-in for `$`.

## Commands

| Command | Does |
| --- | --- |
| `cassandra list` | records remembered for this project |
| `cassandra why <hash>` | one record in full, including the error excerpt and its `fix` line |
| `cassandra forget <hash>` | drop one record (its fix note stays) |
| `cassandra forget --all` | drop every record and fix note for this project |
| `cassandra stats` | whether the warnings are earning their place |
| `cassandra export` | the whole index as JSON |

All of them accept an optional `--cwd <path>` to act on a project other than the current
directory. A `/cassandra` slash command runs `list` inside a session, and switches to
`why <hash>` or `stats` when you ask it to.

## What Cassandra does not do

- It never blocks, denies, or rewrites a call. On a call it adds one line of
  `additionalContext`. On the mod path it also answers its own two tools, `query` and
  `resolve`, when the model calls them, and adds the boundary notes. A briefing is a note
  added to a conversation, not a change to the call or compaction that triggered it.
- It never reads your prompts. The match is on structured `tool_name` and `tool_input`
  JSON. The one place the model's own words reach it is the `reason` it passes to
  `resolve`.
- It does keep two pieces of free text. One is a 240-character excerpt of the failing
  tool's own error output or denial reason, stored with the record and quoted back,
  fenced, in the warning. The other is the `resolve` reason, which is model-written: it is
  stored sanitised and capped at 240 characters in the project's stats log. Those are the
  whole of what it reads beyond the call itself.
- It never leaves the machine. There is no network request, no telemetry, no API key.
- It stores nothing outside its own data directory.

## A note on the hook contract

Both web renderings of the official Claude Code hooks reference state that
`additionalContext` is not supported on `PreToolUse`. That is wrong. The changelog adds it
in 2.1.9 and fixes a delivery bug in 2.1.110. Cassandra's entire read path depends on that
field reaching the model, so if you are touching this, verify hook output fields against
the changelog, not the reference page.

## Requirements

Bun 1.1.0 or newer for the classic path, the CLI and the slash command. None for the mod.

## Development

```bash
bun install
bun run check      # lint, lint:docs, typecheck, knip, then the full suite with coverage
bun run fp         # synthetic freshness-probe harness
bun run fp:real    # freshness probe against real repositories on this machine
bun run fp:mod     # the same harness through the mod's I/O
bun run validate:mod  # claude plugin validate (needs the claude CLI)
bun run test:mod   # claude plugin test, the engine smoke test (needs the claude CLI)
```

## License

MIT.

---

Built by [Tim Schipper](https://tim-schipper.nl/en) and released as open source under
[Aranea Development](https://aranea-development.nl).
