# Cassandra: design

Date: 2026-08-28
Status: approved, ready for implementation planning

## What it is

A Claude Code plugin that remembers failed tool calls across context boundaries and
warns the model when it is about to repeat one having changed nothing.

Cassandra spoke truly and was never believed. The plugin only ever advises. It cannot
block, deny, or rewrite a call.

## The problem

When a Bash command or MCP tool call fails, the model frequently retries it, or a near
variant, without having changed anything relevant. Inside one context window this is
mostly self-correcting, because the failure is visible in the transcript a few thousand
tokens back.

It stops being self-correcting at three boundaries:

1. **Compaction.** The failed call is dropped from context. The index is not.
2. **Session boundaries.** Yesterday's dead end is invisible today.
3. **Subagent isolation.** A freshly spawned agent has no knowledge that the main agent
   already burned four calls on this exact command.

Those three cases are the entire product. Anything Cassandra says inside an intact
context window is close to redundant, and the design is built to stay quiet there.

## Prior art and why the earlier attempt died

An earlier idea under the same name (25 Aug 2026) verified the agent's *claims*: catch
an assertion like "tests pass" and check whether evidence backed it. That required
detecting claims in natural language, across two languages, against phrasing that varies
per user. It was dropped for being nondeterministic and language-dependent.

This design shares only the name. It reads no prose. It keys on `tool_name` and
`tool_input`, both structured JSON emitted by the harness, so it is deterministic and
language-independent by construction.

## Feasibility

Verified against the Claude Code changelog rather than the hooks reference page, which
is wrong on the critical field.

| Requirement | Status |
| --- | --- |
| `PostToolUseFailure` exposes `tool_name`, `tool_input`, `error_message` | available |
| `PermissionDenied` exposes `tool_input`, `denial_reason` | available |
| `PreToolUse` returns `hookSpecificOutput.additionalContext` | added 2.1.9, fixed 2.1.110 |
| `PreToolUse` matcher on tool name | available |
| Persistent state across invocations via `${CLAUDE_PLUGIN_DATA}` | available |
| `tool_use_id` present on both `PreToolUse` and `PostToolUse` | available |

Both web renderings of the official hooks reference state that `additionalContext` is
not supported on `PreToolUse`. The changelog contradicts this twice. Verify hook fields
against the changelog.

## Design decisions

| Decision | Choice | Rejected |
| --- | --- | --- |
| Behaviour on match | Advisory only | Escalating to `ask`; enforcing `deny` |
| Invalidation | Warn only when workspace state is unchanged | Success-clears plus TTL; never clear |
| Tool scope | `Bash` and `mcp__*` | Bash only; all tools including Edit/Write |
| Hot path runtime | Compiled Bun binary, built on first run | `jq`/`python3`; hand-rolled `sh` |

Advisory-only sets the bar: Cassandra cannot make the agent worse. A wrong match costs
one line of context and nothing else.

## Architecture

### Event wiring

| Event | Matcher | Path | Frequency |
| --- | --- | --- | --- |
| `PreToolUse` | `Bash`, `mcp__*` | read: hash, look up, maybe emit | every call |
| `PostToolUseFailure` | `Bash`, `mcp__*` | write: record failure | on failure |
| `PermissionDenied` | `Bash`, `mcp__*` | write: record denial | on denial |
| `PostToolUse` | `Bash`, `mcp__*` | clear a record that just succeeded | every call |
| `SessionStart` | (none) | ensure binary exists, else build or report | once |

### Read path

1. Parse stdin. Extract the significant input.
2. Hash it. One `test -f` against the sharded record path.
3. Miss, which is the overwhelmingly common case: exit 0, emit nothing.
4. Hit: run the freshness probe. If workspace state moved since the failure, exit 0
   silently. The retry is legitimate.
5. State unchanged: write a marker file named by `tool_use_id`, emit
   `additionalContext`, exit 0.

### Write path

On `PostToolUseFailure` or `PermissionDenied`, generate the key set, capture the
workspace state stamp, truncate `error_message` to 240 characters, and write or
increment one record stored under every key.

### Clearing without cost

`PostToolUse` fires on every call, so re-hashing to find a record to clear would put the
whole fingerprint cost on a second hot path. It does not need to. When the read path
warns, it writes `pending/<tool_use_id>`. `PostToolUse` checks that single path. If the
marker exists and the call succeeded, the record is deleted and the marker removed.
Calls that were never warned about cost one `test -f`.

## The freshness probe

The gate is: warn only when nothing has changed since the failure.

An epoch counter bumped on `Edit` and `Write` was considered and rejected. Auto mode
pushes work toward `sed -i`, heredocs and redirects, which are `Bash` calls, so the
counter misses real edits. Bumping on every successful `Bash` is worse, because an
intervening `ls` would silently clear a genuine warning.

Instead the probe runs **only on a hit**, which is rare, so it can afford to be accurate:

- In a git repo: hash of `git rev-parse HEAD` plus `git status --porcelain`.
- Otherwise: hash of the maximum mtime across the working directory, excluding ignored
  and dot directories.

This catches `sed -i`, heredocs, edits made in your own editor, and a `git pull`, none of
which a counter sees. It costs roughly 20ms, and only when Cassandra has something to say.

```
fail  bun test   @ state a3f1  -> record
sed -i src/parser.ts
retry bun test   @ state 9c02  -> silent, state moved

fail  bun test   @ state a3f1  -> record
                               -> compaction
retry bun test   @ state a3f1  -> warn, nothing changed
```

## Fingerprinting

Error costs are asymmetric. A miss costs silence, which is the status quo. A false match
costs a confidently wrong warning, which is what trains you to ignore the tool.
Normalization is therefore deliberately stingy.

**v1 normalization is trim plus whitespace collapse. Nothing else.** No path
canonicalisation, no flag reordering, no stripping of trailing pipes or redirects. Each
of those can merge two genuinely different commands.

Two extractors:

- `Bash`: take `tool_input.command`, trim, collapse runs of whitespace, hash.
- `mcp__*`: hash the raw `tool_input` as delivered. The same serializer produces the
  bytes for `PreToolUse` and `PostToolUseFailure`, so identical calls yield identical
  bytes with no canonicalisation.

Key-set expansion happens at write time, so the hot path never learns new normalization
rules. On day one the set holds one key. When flag-order-insensitivity earns its place,
it is added to the writer alone.

## Storage

```
$CLAUDE_PLUGIN_DATA/<project-slug>/
  records/<hash[0:2]>/<hash>.json
  pending/<tool_use_id>
  stats.jsonl
```

The filesystem is the hash table. Lookup is one `test -f`. There is no index file to
read, scan, or parse.

Record shape:

```json
{
  "tool": "Bash",
  "display": "bun test --coverage",
  "kind": "failure",
  "count": 3,
  "state_stamp": "a3f1c8",
  "first_seen": "2026-08-27T09:14:02Z",
  "last_seen": "2026-08-28T11:20:41Z",
  "error_excerpt": "3 tests failing in parser.test.ts"
}
```

`kind` is `failure` or `denial`. Records are project-scoped: a command failing in one
repository says nothing about another.

## Distribution

`bun build --compile` embeds the runtime, producing binaries around 90MB. Committing
four platform builds is not viable in a git-cloned plugin, so the build moves to install
time:

1. `bin/cassandra-hook` present: use it, roughly 7ms per call.
2. Absent and `bun` on `PATH`: build once in the background at `SessionStart`. Cassandra
   stays inert until it lands.
3. No `bun`: the plugin is inert and `SessionStart` says so once.

`bin/` is gitignored. Cassandra requires Bun, which is already true of Kanon and
Talanton.

## Failure behaviour

Cassandra sits on the hot path of every tool call, so any bug is a bug in your ability to
work. The governing rule is that it must never be able to break a session.

- Every hook exits 0. There is no code path that returns non-zero.
- `timeout: 2` in `hooks.json`, so a hung hook cannot stall a call.
- Unparseable stdin, corrupt record, missing binary, unwritable data directory: swallow,
  exit 0, emit nothing.
- A corrupt record is deleted, not repaired.
- Nothing reaches stdout except a valid `hookSpecificOutput` object.

## Testing

Unit tests cover the parts that can be quietly wrong:

- Bash extraction against escaped quotes, heredocs, embedded newlines, unicode.
- MCP payloads matching byte-for-byte across `PreToolUse` and `PostToolUseFailure`.
- Freshness probe in a git repo, in a dirty git repo, and outside git.
- Record lifecycle: create, increment, clear via marker, delete when corrupt.

Integration tests feed captured real hook payloads on stdin to the compiled binary and
assert on stdout, with fixtures generated from actual sessions following Talanton's
`make-fixtures` precedent rather than from guesses about the schema.

The load-bearing test fuzzes stdin with arbitrary bytes and asserts exit 0 with
empty-or-valid stdout, every time.

## Measuring whether it helps

Advisory tools are easy to believe in and hard to evaluate. The honest read is that
inside an intact context window the model can often already see the failure, so the value
rests entirely on the three boundary cases.

Cassandra therefore records its own efficacy in `stats.jsonl`: every warning issued, and
whether a call carrying that fingerprint ran anyway. `cassandra stats` reports how often
a warning preceded a change of approach. If that number sits near zero after a few weeks,
the tool has told you it is not worth keeping.

## CLI surface

| Command | Does |
| --- | --- |
| `cassandra list` | records for this project |
| `cassandra why <hash>` | full record including error excerpt |
| `cassandra forget <hash>` or `--all` | prune |
| `cassandra stats` | warnings issued, and how often they changed the next action |
| `cassandra export` | emit the index as JSON |

Plus a `/cassandra` slash command for viewing in session.

## Conventions

Follows Kanon and Talanton: Bun with TypeScript, ESM, `bun test` with coverage, eslint,
markdownlint, knip, `bun run check`, release-please with conventional commits, MIT,
`.claude-plugin/plugin.json` and `marketplace.json`, `hooks/hooks.json`, git hooks under
`.githooks`.

## Out of scope for v1

- Flag-order-insensitive fingerprints. The architecture supports adding them at write
  time later.
- `Edit` and `Write` fingerprints. Their payloads never repeat byte-identically, so they
  would sit in the index without ever matching.
- Escalation to `ask` or `deny`. Revisit only if `cassandra stats` shows warnings are
  being ignored at a high rate.
- Sharing an index between machines or users.
