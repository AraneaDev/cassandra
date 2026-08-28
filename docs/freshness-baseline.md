# Freshness probe baseline

Date: 2026-08-28
Bun version: 1.4.0
Branch: feat/cassandra-v1

This is checkpoint FP-4. Task 5 wrote `runReal()` in `scripts/fp-harness.ts` but never
ran it against real trees; this document is that run, recorded honestly. Every future
change to `src/freshness.ts` is compared against this file. If a change makes a number
here worse, that is a regression even if every test still passes.

The freshness probe is the tracked risk for this project. Two things below matter more
than the rest of the document: whether any probe was unstable, and whether the mtime
fallback's walk bounds (`MAX_DEPTH` and `MAX_ENTRIES`, both private to
`src/freshness.ts`) were ever reached on a real tree. Both are reported without
softening.

## Summary of findings

- **Stability**: 71/71 real repositories were stable across both `fp:real` runs. No
  git repository showed changing `git status --porcelain` output between two
  consecutive reads, and no mtime-fallback directory produced a moving stamp with
  nothing actually changed. This is the property the synthetic harness cannot test,
  and it held everywhere it was tried.
- **Timing**: one probe exceeded the 200ms budget: `/root/e-commerce-api`, at 375ms,
  a git-backed repository with 1,656 walked entries. Every other probe, real or
  synthetic, returned in well under 200ms.
- **Walk bounds (the parked question from Task 5)**: 16 of the 71 probed directories
  reached `MAX_DEPTH` or `MAX_ENTRIES` during the walk. This is a real finding, not a
  curiosity. Full detail and interpretation are in "Walk bounds: the parked question"
  below.

Per the task brief, an unstable probe, a probe over 200ms, or a walk-bound hit is
each independently a stop-and-report condition. The 200ms overrun and the 16
bound-hits both occurred. This baseline is recorded as **DONE_WITH_CONCERNS**. The
harness thresholds were not adjusted to make the run pass, and `src/freshness.ts`
was not touched.

## How this measurement was produced

Reporting-only counting was added to `scripts/fp-harness.ts`'s `runReal()`: a
function `probeMtimeBounds()` that mirrors `mtimeStamp`'s `SKIP` set, `MAX_DEPTH`
and `MAX_ENTRIES` bounds and walks each probed root independently, purely to count
entries and flag a bound hit. It does not feed the real stamp and it does not
change what `stateStamp()` returns. `MAX_DEPTH` and `MAX_ENTRIES` are private
constants in `src/freshness.ts`, not exported, so the values (6 and 5000) are
duplicated by hand in the harness rather than imported. No file under `src/` was
changed.

The bound-hit column applies to every probed directory, not only the ones whose
stamp actually came from the mtime fallback. For a directory whose stamp came from
`gitStamp()`, `mtimeStamp()` was never invoked to produce that stamp, so the walk
bounds did not affect the number you got today. What the bound-hit column tells
you for a git repository is a conditional fact: if git ever became unavailable
there, or if `.git` were ever missing, the fallback this project relies on would
silently truncate before covering the tree. That is exactly the residual Task 5
parked.

## Run 1: `bun run fp` (synthetic harness)

Verbatim output:

```text
$ bun run scripts/fp-harness.ts

freshness FP harness: 18/18 mutations detected, false-positive rate 0.0%
known blind spot [mtime] same size, same mtime, different content: NOT DETECTED (expected)
headless-repo check: 9/9 mutations detected in a zero-commit repo
```

Result: 18/18 mutations detected, false-positive rate 0.0%, across both a git
worktree and an mtime-fallback directory. The known blind spot (a same-size,
same-mtime, different-content rewrite) is reported as NOT DETECTED, which is the
expected outcome for a metadata-only probe and is excluded from the pass/fail
total by design. The zero-commit ("headless") git repository check passed 9/9.
This confirms the probe still reacts to every cataloged mutation shape; it says
nothing about real trees, which is what the next two runs are for.

## Run 2: `bun run fp:real` (default candidate set)

Default roots: `/root/talanton`, `/root/kanon`, `/root/claude-timestamp`,
`/root/aranea`.

Verbatim output:

```text
$ bun run scripts/fp-harness.ts --real
fp:real: probing real repositories

  stable    git      19ms  entries=96  /root/talanton
  stable    git      13ms  entries=51  /root/kanon
  stable    git      30ms  entries=42  /root/claude-timestamp
  stable    git       3ms  entries=184  /root/aranea

fp:real: 4/4 stable, 0 over the 200ms budget, 0 hit MAX_DEPTH or MAX_ENTRIES
```

Result: 4/4 stable, 0 over the 200ms budget, 0 walk-bound hits. This is the
narrow set Task 5 hardcoded and it looks clean on its own; the point of Step 3
below is that a set of four hand-picked repositories is not a representative
sample of what this machine actually holds.

## Run 3: widened sweep across every project directory on the machine

Command:

```bash
CASSANDRA_FP_ROOTS="$(ls -d /root/*/ | tr '\n' ',' | sed 's/,$//')" bun run fp:real
```

This expands the candidate set to all 71 directories directly under `/root`,
covering a real mix: small utility repos, large application repos, plain
non-git directories, and one raw `node_modules` tree probed as its own root.

Verbatim output:

```text
$ bun run scripts/fp-harness.ts --real
fp:real: probing real repositories

  stable    git      14ms  entries=136  /root/3d-wasm/
  stable    git      22ms  entries=177  /root/Argos-MCP/
  stable    git      40ms  entries=262  /root/Chaos-MCP/
  stable    mtime     0ms  entries=0  /root/Downloads/
  stable    git      93ms  entries=663  /root/Knossos-MCP/
  stable    git      24ms  entries=233  /root/Momus-MCP/
  stable    git      17ms  entries=169  /root/Sneaky-MCP/
  stable    mtime     2ms  entries=0  /root/YCI/
  stable    git      11ms  entries=921  [MAX_DEPTH HIT]  /root/Youbuntu/
  stable    mtime     0ms  entries=0  /root/ai-act/
  stable    mtime     1ms  entries=3  /root/aranea-brand/
  stable    git       5ms  entries=3  /root/aranea-claude-tools/
  stable    git       2ms  entries=184  /root/aranea/
  stable    git      45ms  entries=306  /root/araneadev/
  stable    git     106ms  entries=1085  /root/axiom/
  stable    git      54ms  entries=342  /root/bib/
  stable    git       2ms  entries=43  /root/cassandra/
  stable    mtime     2ms  entries=7  /root/claude-sql/
  stable    git       2ms  entries=42  /root/claude-timestamp/
  stable    mtime     1ms  entries=8  /root/didache-notes/
  stable    git      11ms  entries=145  /root/didache/
  stable    mtime     0ms  entries=0  /root/docs/
  stable    git      48ms  entries=881  /root/doom-engine/
  stable    git      10ms  entries=421  [MAX_DEPTH HIT]  /root/dungeon/
  stable    git     375ms  entries=1656  [MAX_DEPTH HIT]  /root/e-commerce-api/
  stable    mtime     5ms  entries=378  /root/edulink/
  stable    git      10ms  entries=104  /root/elementa/
  stable    mtime     1ms  entries=4  /root/elenchus/
  stable    mtime     2ms  entries=9  /root/error-logger/
  stable    git      16ms  entries=411  /root/expensis-laravel/
  stable    git      72ms  entries=4035  [MAX_DEPTH HIT]  /root/expensis/
  stable    git       8ms  entries=20  /root/glyphfall-landing/
  stable    git      16ms  entries=122  [MAX_DEPTH HIT]  /root/glyphfall-mail/
  stable    git      11ms  entries=472  /root/glyphfall-p6/
  stable    git       9ms  entries=56  /root/glyphfall-themes/
  stable    git      27ms  entries=650  /root/glyphfall/
  stable    mtime     9ms  entries=397  /root/grexx/
  stable    mtime     0ms  entries=0  /root/history/
  stable    git       2ms  entries=51  /root/kanon/
  stable    git       5ms  entries=95  /root/klussenmeternst/
  stable    mtime     0ms  entries=0  /root/lexifall/
  stable    git      54ms  entries=2612  [MAX_DEPTH HIT]  /root/lowkey/
  stable    git       5ms  entries=30  /root/mc-mcp/
  stable    git       9ms  entries=171  /root/mcp-sql-access-server/
  stable    git      60ms  entries=1019  [MAX_DEPTH HIT]  /root/mcpobservatory/
  stable    git      13ms  entries=101  [MAX_DEPTH HIT]  /root/nekyia/
  stable    mtime    79ms  entries=5000  [MAX_ENTRIES HIT]  /root/node_modules/
  stable    git      14ms  entries=810  [MAX_DEPTH HIT]  /root/oogactx/
  stable    mtime     0ms  entries=6  /root/panic-reports-backup/
  stable    mtime     0ms  entries=0  /root/password/
  stable    git       6ms  entries=66  /root/playwright-tests/
  stable    git      43ms  entries=5000  [MAX_DEPTH HIT, MAX_ENTRIES HIT]  /root/proxypilot/
  stable    git      38ms  entries=332  [MAX_DEPTH HIT]  /root/ratio-calculation/
  stable    mtime     0ms  entries=0  /root/ratio-playwright/
  stable    git      35ms  entries=2105  [MAX_DEPTH HIT]  /root/ratio/
  stable    git     137ms  entries=5000  [MAX_ENTRIES HIT]  /root/reefermanseeds/
  stable    mtime     0ms  entries=2  /root/schemas/
  stable    mtime     0ms  entries=1  /root/sonarqube/
  stable    mtime     5ms  entries=240  /root/sozjal/
  stable    mtime     2ms  entries=11  /root/strategy/
  stable    git       3ms  entries=96  /root/talanton/
  stable    git       6ms  entries=294  /root/termaxa/
  stable    mtime     0ms  entries=5  /root/test-kilo/
  stable    mtime     0ms  entries=0  /root/test-results/
  stable    git      64ms  entries=3503  /root/thin-ratio/
  stable    git      17ms  entries=2296  /root/tim-vitepress/
  stable    git      77ms  entries=3789  [MAX_DEPTH HIT]  /root/topolearn/
  stable    mtime     0ms  entries=0  /root/untitled/
  stable    git     125ms  entries=2225  /root/usage-tracker/
  stable    git      79ms  entries=5000  [MAX_ENTRIES HIT]  /root/workflow-dockerized/
  stable    git      52ms  entries=1349  /root/yielder-customer-insights/

fp:real: 71/71 stable, 1 over the 200ms budget, 16 hit MAX_DEPTH or MAX_ENTRIES
error: script "fp:real" exited with code 1
```

## Per-repository detail

One row per directory probed in the widened sweep (Run 3), which is a superset
of the default set (Run 2): `/root/talanton`, `/root/kanon`,
`/root/claude-timestamp` and `/root/aranea` appear in both runs with the same
result. "Entries" is the file count `probeMtimeBounds()` walked under the same
`SKIP`/depth/entry rules `mtimeStamp` uses, regardless of which probe kind
actually produced that row's stamp. "Depth hit" and "Entries hit" mark whether
that walk was cut short by `MAX_DEPTH` (6) or `MAX_ENTRIES` (5000) respectively;
"yes" there does not imply the run's actual stamp was affected unless the "kind"
column also reads `mtime` (see "Walk bounds" below).

| Path | Probe kind | Stable | Elapsed (ms) | Entries walked | Depth hit | Entries hit |
| --- | --- | --- | --- | --- | --- | --- |
| `/root/3d-wasm/` | git | stable | 14 | 136 | no | no |
| `/root/Argos-MCP/` | git | stable | 22 | 177 | no | no |
| `/root/Chaos-MCP/` | git | stable | 40 | 262 | no | no |
| `/root/Downloads/` | mtime | stable | 0 | 0 | no | no |
| `/root/Knossos-MCP/` | git | stable | 93 | 663 | no | no |
| `/root/Momus-MCP/` | git | stable | 24 | 233 | no | no |
| `/root/Sneaky-MCP/` | git | stable | 17 | 169 | no | no |
| `/root/YCI/` | mtime | stable | 2 | 0 | no | no |
| `/root/Youbuntu/` | git | stable | 11 | 921 | yes | no |
| `/root/ai-act/` | mtime | stable | 0 | 0 | no | no |
| `/root/aranea-brand/` | mtime | stable | 1 | 3 | no | no |
| `/root/aranea-claude-tools/` | git | stable | 5 | 3 | no | no |
| `/root/aranea/` | git | stable | 2 | 184 | no | no |
| `/root/araneadev/` | git | stable | 45 | 306 | no | no |
| `/root/axiom/` | git | stable | 106 | 1085 | no | no |
| `/root/bib/` | git | stable | 54 | 342 | no | no |
| `/root/cassandra/` | git | stable | 2 | 43 | no | no |
| `/root/claude-sql/` | mtime | stable | 2 | 7 | no | no |
| `/root/claude-timestamp/` | git | stable | 2 | 42 | no | no |
| `/root/didache-notes/` | mtime | stable | 1 | 8 | no | no |
| `/root/didache/` | git | stable | 11 | 145 | no | no |
| `/root/docs/` | mtime | stable | 0 | 0 | no | no |
| `/root/doom-engine/` | git | stable | 48 | 881 | no | no |
| `/root/dungeon/` | git | stable | 10 | 421 | yes | no |
| `/root/e-commerce-api/` | git | stable | 375 | 1656 | yes | no |
| `/root/edulink/` | mtime | stable | 5 | 378 | no | no |
| `/root/elementa/` | git | stable | 10 | 104 | no | no |
| `/root/elenchus/` | mtime | stable | 1 | 4 | no | no |
| `/root/error-logger/` | mtime | stable | 2 | 9 | no | no |
| `/root/expensis-laravel/` | git | stable | 16 | 411 | no | no |
| `/root/expensis/` | git | stable | 72 | 4035 | yes | no |
| `/root/glyphfall-landing/` | git | stable | 8 | 20 | no | no |
| `/root/glyphfall-mail/` | git | stable | 16 | 122 | yes | no |
| `/root/glyphfall-p6/` | git | stable | 11 | 472 | no | no |
| `/root/glyphfall-themes/` | git | stable | 9 | 56 | no | no |
| `/root/glyphfall/` | git | stable | 27 | 650 | no | no |
| `/root/grexx/` | mtime | stable | 9 | 397 | no | no |
| `/root/history/` | mtime | stable | 0 | 0 | no | no |
| `/root/kanon/` | git | stable | 2 | 51 | no | no |
| `/root/klussenmeternst/` | git | stable | 5 | 95 | no | no |
| `/root/lexifall/` | mtime | stable | 0 | 0 | no | no |
| `/root/lowkey/` | git | stable | 54 | 2612 | yes | no |
| `/root/mc-mcp/` | git | stable | 5 | 30 | no | no |
| `/root/mcp-sql-access-server/` | git | stable | 9 | 171 | no | no |
| `/root/mcpobservatory/` | git | stable | 60 | 1019 | yes | no |
| `/root/nekyia/` | git | stable | 13 | 101 | yes | no |
| `/root/node_modules/` | mtime | stable | 79 | 5000 | no | yes |
| `/root/oogactx/` | git | stable | 14 | 810 | yes | no |
| `/root/panic-reports-backup/` | mtime | stable | 0 | 6 | no | no |
| `/root/password/` | mtime | stable | 0 | 0 | no | no |
| `/root/playwright-tests/` | git | stable | 6 | 66 | no | no |
| `/root/proxypilot/` | git | stable | 43 | 5000 | yes | yes |
| `/root/ratio-calculation/` | git | stable | 38 | 332 | yes | no |
| `/root/ratio-playwright/` | mtime | stable | 0 | 0 | no | no |
| `/root/ratio/` | git | stable | 35 | 2105 | yes | no |
| `/root/reefermanseeds/` | git | stable | 137 | 5000 | no | yes |
| `/root/schemas/` | mtime | stable | 0 | 2 | no | no |
| `/root/sonarqube/` | mtime | stable | 0 | 1 | no | no |
| `/root/sozjal/` | mtime | stable | 5 | 240 | no | no |
| `/root/strategy/` | mtime | stable | 2 | 11 | no | no |
| `/root/talanton/` | git | stable | 3 | 96 | no | no |
| `/root/termaxa/` | git | stable | 6 | 294 | no | no |
| `/root/test-kilo/` | mtime | stable | 0 | 5 | no | no |
| `/root/test-results/` | mtime | stable | 0 | 0 | no | no |
| `/root/thin-ratio/` | git | stable | 64 | 3503 | no | no |
| `/root/tim-vitepress/` | git | stable | 17 | 2296 | no | no |
| `/root/topolearn/` | git | stable | 77 | 3789 | yes | no |
| `/root/untitled/` | mtime | stable | 0 | 0 | no | no |
| `/root/usage-tracker/` | git | stable | 125 | 2225 | no | no |
| `/root/workflow-dockerized/` | git | stable | 79 | 5000 | no | yes |
| `/root/yielder-customer-insights/` | git | stable | 52 | 1349 | no | no |

## Walk bounds: the parked question, settled with evidence

Task 5 parked a residual: `mtimeStamp` bounds its walk at `MAX_DEPTH` 6 and
`MAX_ENTRIES` 5000, and a truncated walk is still returned as a confident
`mtime` stamp. A change outside the walked region would not move that stamp,
and `unchanged()` would report `true` for a workspace that had, in fact,
changed. That is a false positive, the expensive error for this product. The
question was whether real trees come anywhere near those bounds.

They do, routinely. 16 of the 71 probed directories reached one of the two
bounds:

- **Depth hit** (13 directories): `/root/Youbuntu`, `/root/dungeon`,
  `/root/e-commerce-api`, `/root/expensis`, `/root/glyphfall-mail`,
  `/root/lowkey`, `/root/mcpobservatory`, `/root/nekyia`, `/root/oogactx`,
  `/root/proxypilot`, `/root/ratio-calculation`, `/root/ratio`,
  `/root/topolearn`.
- **Entries hit** (4 directories): `/root/node_modules`, `/root/proxypilot`
  (both bounds), `/root/reefermanseeds`, `/root/workflow-dockerized`.

Of these 16, only one, `/root/node_modules`, was actually stamped via the mtime
fallback in this run (kind `mtime`, 5000 entries walked, `MAX_ENTRIES` hit). For
that one directory, today's `mtime` stamp is confirmed to cover only part of the
tree, exactly the failure mode the residual describes: a change made past entry
5000 in that tree would not move the stamp, and Cassandra would go silent on a
retried command whose workspace had, in fact, changed under it.

The other 15 hits were on directories whose stamp this run came from `gitStamp`,
so the bound did not touch today's actual result. They matter anyway: each one
is a directory of real, ordinary size, from 101 walked entries
(`/root/nekyia`) up to the full 5000-entry cap, that would truncate the
instant it had to lean on the fallback: git missing, `.git` corrupted, or the
repository un-initialized. Two of the depth-hit directories, `/root/nekyia`
(101 entries) and `/root/glyphfall-mail` (122 entries), show that `MAX_DEPTH`
truncates on structure, not just size: a tree with comparatively few files can
still nest past 6 levels and get cut off well before `MAX_ENTRIES` would ever
matter. The fallback is not a rare-directory problem. Ordinary, present-day
project trees on this machine hit one of its bounds close to a quarter of the
time (16/71, about 23%).

This does not, on its own, tell you the fix. It tells you the premise for not
fixing it, "no evidence real trees hit the bounds," no longer holds. The
obvious fix Task 5 considered, poisoning the stamp on truncation, would make
Cassandra permanently silent on every one of these 16 directories the moment
they ever needed the fallback, and on `/root/node_modules` right now. Whether
that trade is worth taking is a decision for whoever picks this residual back
up, made with these numbers in hand instead of a guess. `src/freshness.ts` was
not changed as part of this task.

## The 200ms probe budget

One probe, `/root/e-commerce-api`, took 375ms; a git-backed repository with
1,656 walked entries, also one of the 16 that hit `MAX_DEPTH`. Every other
probe in all three runs, synthetic and real, returned well inside the 200ms
budget, most in under 100ms. This cost is paid only on a hash hit, on the
already-slow path where Cassandra is about to warn, never on a miss, so the
budget is deliberately generous; one overrun in 71 real repositories does not
by itself argue for lowering `MAX_ENTRIES`. It is reported here, unadjusted,
because the brief asks for the number rather than a judgment call about
whether it is acceptable.

## What this measurement establishes, and what it does not

The synthetic harness (`bun run fp`) proves the probe **reacts**: given a
directory built for the purpose, every cataloged mutation shape moves the
stamp. It says nothing about whether the probe is quiet when it should be
quiet.

This run (`bun run fp:real`, both the default set and the widened sweep)
proves the probe is **stable**: across 71 real, unmodified repositories on
this machine, calling `stateStamp()` twice in immediate succession returned
the same value every time. It says nothing about whether the probe reacts
correctly to a real mutation, because nothing was mutated in this run.

These are two different properties. Reacting to change and staying stable
under no change do not imply each other, and neither run substitutes for the
other. Together they are what currently exists as evidence for the freshness
probe. Neither run tells you what happens the moment a real, ordinary tree
exceeds `MAX_ENTRIES` while using the mtime fallback: that is not a stability
question, it is the walk-bounds finding above, and it is now backed by a real
example (`/root/node_modules`) rather than a hypothetical one.

## For future changes

Every future change to `src/freshness.ts` is compared against this file. If a
change to `gitStamp`, `mtimeStamp`, `stateStamp`, or `unchanged` alters the
stability count, the timing figures, or the walk-bound-hit count on a rerun of
Step 3's widened sweep, that is a regression against this baseline even if
`bun run fp` and `bun run check` both still pass. Re-run with:

```bash
bun run fp
bun run fp:real
CASSANDRA_FP_ROOTS="$(ls -d /root/*/ | tr '\n' ',' | sed 's/,$//')" bun run fp:real
```
