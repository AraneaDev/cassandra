# Cassandra Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Claude Code plugin that remembers failed Bash and MCP tool calls across compaction, session and subagent boundaries, and warns the model via `PreToolUse` `additionalContext` when it is about to repeat one having changed nothing.

**Architecture:** A compiled Bun binary serves both the hot read path (`PreToolUse`, every call) and the cold write path (`PostToolUseFailure`, `PermissionDenied`). Records live one-per-file in a sharded directory tree, so a lookup is a single `existsSync`. The expensive freshness probe runs only after a hash hit, which is rare. Every hook exits 0 unconditionally.

**Tech Stack:** Bun >= 1.1.0, TypeScript (ESM, strict), `bun test` with coverage thresholds, eslint + typescript-eslint + jsdoc, markdownlint-cli2, knip, release-please, POSIX `sh` for the two wiring scripts.

**Spec:** `docs/superpowers/specs/2026-08-28-cassandra-design.md`

## Global Constraints

- Package name `cassandra`, MIT, `"type": "module"`, `engines.bun >= 1.1.0`.
- Git identity is already set locally: `AraneaDev <12177132+AraneaDev@users.noreply.github.com>`. Do not change it.
- **Every hook process exits 0 on every path.** There is no `process.exit(1)` anywhere in `src/hook.ts` or the `sh` scripts.
- Nothing reaches stdout except a single valid `hookSpecificOutput` JSON object. Diagnostics go to stderr.
- `hooks.json` sets `"timeout": 2` on every entry.
- Hash is `sha256`, hex, truncated to 16 characters. Never `Bun.hash`, which is not stable across Bun versions.
- Data root resolution order: `CASSANDRA_HOME`, then `CLAUDE_PLUGIN_DATA`, then `~/.cassandra`. Tests always set `CASSANDRA_HOME`.
- Normalization for v1 is trim plus whitespace collapse. Nothing else. No path canonicalisation, no flag reordering, no stripping redirects.
- Conventional commits. `feat:`, `fix:`, `docs:`, `test:`, `chore:`, `refactor:`, `perf:`, `ci:`.
- Prose in README and docs: no em dashes, single author voice, reader addressed as "you".

## Tracked Risk: the freshness probe

The user has flagged the freshness probe, and especially the non-git max-mtime fallback, as the weakest part of the design. It is not to be built once and assumed correct.

**Why it is risky.** The probe decides whether a hit becomes a warning. A probe that under-detects change produces false positives, which is the failure mode that trains you to ignore the tool. The git path is strong. The mtime fallback is a heuristic over an unbounded tree and can miss a change (file rewritten with a preserved mtime, change outside the scanned depth) or see spurious change (a build artefact, a log file).

**The safety rule that bounds the damage.** `stateStamp` returns a `kind` of `git`, `mtime` or `none`. **A `none` result never warns.** Unknown state means silence. This is asserted in Task 5 Step 1 and re-asserted in Task 8.

**Checkpoint protocol.** The false-positive harness built in Task 5 is re-run, unchanged, at three later points. If the rate moves, stop and report before continuing:

| Checkpoint | After | Command |
| --- | --- | --- |
| FP-1 baseline | Task 5 | `bun test test/freshness.test.ts` |
| FP-2 post-integration | Task 8 | `bun run fp` |
| FP-3 post-wiring | Task 11 | `bun run fp` |
| FP-4 real sessions | Task 13 | `bun run fp:real` |

Task 13 exists solely to measure the probe against real session data and is not optional.

## Note on one addition to the spec

The spec's measurement section requires attributing each warning to one of three boundaries (compaction, session, subagent). Session and subagent are derivable from the `PreToolUse` payload (`session_id`, `agent_id`). Compaction is not. Task 10 therefore wires a `PostCompact` hook that increments a per-session counter, and records store the counter value at failure time. This is a small addition to the spec's event table, required by the spec's own measurement section.

## File Structure

| File | Responsibility |
| --- | --- |
| `src/types.ts` | Shared types. No logic. |
| `src/paths.ts` | Data root, repo root discovery, project slug, record paths. |
| `src/fingerprint.ts` | Tool classification, Bash and MCP extractors, stable hash. |
| `src/freshness.ts` | Workspace state stamp: git probe, mtime fallback, `none`. |
| `src/record.ts` | Record read, write, increment, delete. Corrupt handling. |
| `src/session.ts` | Per-session compaction counter. |
| `src/stats.ts` | Efficacy log append and read, boundary attribution. |
| `src/hook.ts` | Hook entrypoint. Dispatches on `hook_event_name`. Compiled to `bin/`. |
| `src/cli.ts` | CLI entrypoint. Dispatches subcommands. |
| `src/commands/*.ts` | One file per subcommand: list, why, forget, stats, export. |
| `hooks/hooks.json` | Event wiring. |
| `hooks/scripts/session-start.sh` | Build ladder: use binary, build it, or report inert. |
| `scripts/build-hook.ts` | `bun build --compile` into `bin/cassandra-hook`. |
| `scripts/fp-harness.ts` | Freshness false-positive harness. Tracked risk. |
| `scripts/make-fixtures.ts` | Capture real hook payloads into `test/fixtures/`. |

---

### Task 1: Project scaffold and toolchain

**Files:**

- Create: `package.json`, `tsconfig.json`, `eslint.config.mjs`, `knip.json`, `.markdownlint-cli2.jsonc`, `bunfig.toml`, `.gitignore`, `LICENSE`, `release-please-config.json`, `.release-please-manifest.json`, `.githooks/pre-commit`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `src/types.ts`, `test/scaffold.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: a repo where `bun run typecheck`, `bun run lint` and `bun run lint:docs` pass. `src/types.ts` exports `HookPayload`, `ToolKind`, `RecordKind`, `StateKind`, `FailureRecord`, `StateStamp`.

- [ ] **Step 1: Write the failing test**

`test/scaffold.test.ts`:

```ts
import { expect, test } from 'bun:test'
import type { FailureRecord } from '../src/types'

test('FailureRecord shape is constructible', () => {
  const r: FailureRecord = {
    tool: 'Bash',
    display: 'bun test',
    kind: 'failure',
    count: 1,
    stateStamp: 'a3f1c8',
    stateKind: 'git',
    sessionId: 's1',
    compactions: 0,
    firstSeen: '2026-08-28T00:00:00Z',
    lastSeen: '2026-08-28T00:00:00Z',
    errorExcerpt: 'boom',
  }
  expect(r.count).toBe(1)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/scaffold.test.ts`
Expected: FAIL, cannot resolve `../src/types`.

- [ ] **Step 3: Write the config files**

`package.json`:

```json
{
  "name": "cassandra",
  "version": "0.0.0",
  "description": "Remembers the tool calls that already failed, so your agent stops retrying them blind",
  "license": "MIT",
  "type": "module",
  "bin": { "cassandra": "./src/cli.ts" },
  "engines": { "bun": ">=1.1.0" },
  "scripts": {
    "build:hook": "bun run scripts/build-hook.ts",
    "test": "bun test",
    "test:coverage": "bun test --coverage",
    "typecheck": "tsc --noEmit",
    "lint": "eslint .",
    "lint:fix": "eslint . --fix",
    "lint:docs": "markdownlint-cli2",
    "knip": "knip",
    "fp": "bun run scripts/fp-harness.ts",
    "fp:real": "bun run scripts/fp-harness.ts --real",
    "check": "bun run lint && bun run lint:docs && bun run typecheck && bun run knip && bun run test:coverage",
    "prepare": "git config core.hooksPath .githooks || true"
  },
  "devDependencies": {
    "@eslint/js": "^10.0.1",
    "@types/bun": "latest",
    "eslint": "^10.9.1",
    "eslint-plugin-jsdoc": "^64.2.1",
    "knip": "^6.32.2",
    "markdownlint-cli2": "^0.23.2",
    "typescript": "^5.5.0",
    "typescript-eslint": "^8.68.0"
  }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "types": ["@types/bun"],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true
  },
  "include": ["src", "test", "scripts"]
}
```

`bunfig.toml`:

```toml
[test]
coverageSkipTestFiles = true
coverageReporter = ["text"]
coveragePathIgnorePatterns = ["test/**", "scripts/**"]

[test.coverageThreshold]
lines = 0.90
functions = 0.90
```

`knip.json`:

```json
{
  "$schema": "https://unpkg.com/knip@6/schema.json",
  "entry": ["src/cli.ts", "src/hook.ts", "scripts/*.ts", "test/**/*.test.ts"],
  "project": ["src/**/*.ts", "scripts/**/*.ts", "test/**/*.ts"]
}
```

`.markdownlint-cli2.jsonc`:

```jsonc
{
  "config": {
    "default": true,
    "MD013": false,
    "MD033": false,
    "MD041": false,
    "MD060": false,
    "MD024": { "siblings_only": true }
  },
  "globs": ["**/*.md"],
  "ignores": ["node_modules", "CHANGELOG.md"]
}
```

`.gitignore`:

```text
node_modules/
bin/
dist/
coverage/
test/fixtures/
.env
*.log
.momus/
CLAUDE.md
```

`eslint.config.mjs`: copy `/root/talanton/eslint.config.mjs` verbatim, then change the final override block's `files` array from `['src/cli.ts', 'src/commands/**/*.ts', 'src/render.ts']` to `['src/cli.ts', 'src/commands/**/*.ts', 'src/hook.ts']`.

`release-please-config.json`: copy `/root/kanon/release-please-config.json` verbatim, changing `"package-name"` to `"cassandra"`.

`.release-please-manifest.json`:

```json
{".":"0.0.0"}
```

`.githooks/pre-commit`: copy `/root/talanton/.githooks/pre-commit` verbatim, changing `TALANTON_SKIP_HOOKS` to `CASSANDRA_SKIP_HOOKS` in both places.

`LICENSE`: MIT, copyright holder `AraneaDev`, year 2026.

`.claude-plugin/plugin.json`:

```json
{
  "name": "cassandra",
  "displayName": "Cassandra",
  "version": "0.0.0",
  "description": "Remembers the tool calls that already failed, and says so before your agent runs one again unchanged.",
  "author": { "name": "AraneaDev", "url": "https://github.com/AraneaDev" },
  "homepage": "https://github.com/AraneaDev/cassandra",
  "repository": "https://github.com/AraneaDev/cassandra",
  "license": "MIT",
  "keywords": ["hooks", "failure", "retry", "observability", "context", "compaction"]
}
```

`.claude-plugin/marketplace.json`:

```json
{
  "name": "cassandra",
  "owner": { "name": "AraneaDev", "url": "https://github.com/AraneaDev" },
  "description": "Cross-boundary failure memory for Claude Code.",
  "plugins": [
    {
      "name": "cassandra",
      "source": "./",
      "description": "She spoke truly and no one checked. Warns when your agent repeats a call that already failed."
    }
  ]
}
```

`src/types.ts`:

```ts
/** Which extractor applies to a tool call. */
export type ToolKind = 'bash' | 'mcp' | 'ignored'

/** Whether a record came from a tool failure or an auto-mode permission denial. */
export type RecordKind = 'failure' | 'denial'

/** How a workspace state stamp was obtained. `none` means it could not be, and never warns. */
export type StateKind = 'git' | 'mtime' | 'none'

/** A workspace state fingerprint, used to decide whether anything changed since a failure. */
export interface StateStamp {
  kind: StateKind
  value: string
}

/** One remembered failure, stored as a single JSON file named by its fingerprint. */
export interface FailureRecord {
  tool: string
  display: string
  kind: RecordKind
  count: number
  stateStamp: string
  stateKind: StateKind
  sessionId: string
  compactions: number
  firstSeen: string
  lastSeen: string
  errorExcerpt: string
}

/** The subset of a Claude Code hook payload Cassandra reads. All fields are optional by design. */
export interface HookPayload {
  hook_event_name?: string
  session_id?: string
  cwd?: string
  tool_name?: string
  tool_input?: unknown
  tool_use_id?: string
  error_message?: string
  denial_reason?: string
  agent_id?: string
}
```

- [ ] **Step 4: Install and run the test**

Run: `bun install && bun test test/scaffold.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify the toolchain**

Run: `bun run typecheck && bun run lint && bun run lint:docs`
Expected: all three exit 0. `knip` and coverage will fail until later tasks add entrypoints, so do not run `bun run check` yet.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: scaffold project, toolchain and plugin manifests"
```

---

### Task 2: Paths and project slug

**Files:**

- Create: `src/paths.ts`, `test/paths.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `dataRoot(): string`
  - `findRepoRoot(cwd: string): string`
  - `projectSlug(cwd: string): string`
  - `interface Paths { root: string; records: string; pending: string; stats: string }`
  - `pathsFor(cwd: string): Paths`
  - `recordPath(paths: Paths, hash: string): string`
  - `pendingPath(paths: Paths, toolUseId: string): string`

- [ ] **Step 1: Write the failing test**

`test/paths.test.ts`:

```ts
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { dataRoot, findRepoRoot, pathsFor, projectSlug, recordPath } from '../src/paths'

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cass-paths-'))
  process.env.CASSANDRA_HOME = join(tmp, 'home')
})

afterEach(() => {
  delete process.env.CASSANDRA_HOME
  rmSync(tmp, { recursive: true, force: true })
})

test('dataRoot honours CASSANDRA_HOME first', () => {
  expect(dataRoot()).toBe(join(tmp, 'home'))
})

test('findRepoRoot walks up to the directory containing .git', () => {
  const repo = join(tmp, 'repo')
  const deep = join(repo, 'a', 'b')
  mkdirSync(join(repo, '.git'), { recursive: true })
  mkdirSync(deep, { recursive: true })
  expect(findRepoRoot(deep)).toBe(repo)
})

test('findRepoRoot returns cwd when there is no .git above it', () => {
  const plain = join(tmp, 'plain')
  mkdirSync(plain, { recursive: true })
  expect(findRepoRoot(plain)).toBe(plain)
})

test('a subdirectory of a repo yields the same slug as its root', () => {
  const repo = join(tmp, 'repo')
  const deep = join(repo, 'a', 'b')
  mkdirSync(join(repo, '.git'), { recursive: true })
  mkdirSync(deep, { recursive: true })
  expect(projectSlug(deep)).toBe(projectSlug(repo))
})

test('two checkouts with the same basename get different slugs', () => {
  const one = join(tmp, 'x', 'proj')
  const two = join(tmp, 'y', 'proj')
  mkdirSync(join(one, '.git'), { recursive: true })
  mkdirSync(join(two, '.git'), { recursive: true })
  expect(projectSlug(one)).not.toBe(projectSlug(two))
  expect(projectSlug(one).startsWith('proj-')).toBe(true)
})

test('recordPath shards on the first two hash characters', () => {
  const p = pathsFor(tmp)
  expect(recordPath(p, 'abcdef0123456789')).toBe(join(p.records, 'ab', 'abcdef0123456789.json'))
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/paths.test.ts`
Expected: FAIL, cannot resolve `../src/paths`.

- [ ] **Step 3: Write the implementation**

`src/paths.ts`:

```ts
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

/** Where every project's index lives. Tests set CASSANDRA_HOME; the plugin gets CLAUDE_PLUGIN_DATA. */
export function dataRoot(): string {
  return process.env.CASSANDRA_HOME
    ?? process.env.CLAUDE_PLUGIN_DATA
    ?? join(homedir(), '.cassandra')
}

/**
 * Nearest ancestor containing `.git`, else the directory itself. Pure filesystem
 * probes rather than `git rev-parse`, because this runs on the hot path and a
 * subprocess there would cost more than the lookup it serves.
 */
export function findRepoRoot(cwd: string): string {
  let dir = resolve(cwd)
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return resolve(cwd)
    dir = parent
  }
}

/** Stable per-project directory name. Two checkouts of one repo never share an index. */
export function projectSlug(cwd: string): string {
  const root = findRepoRoot(cwd)
  const name = basename(root).replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 40) || 'project'
  const digest = createHash('sha256').update(root).digest('hex').slice(0, 8)
  return `${name}-${digest}`
}

/** The locations Cassandra writes to for one project. */
export interface Paths {
  root: string
  records: string
  pending: string
  stats: string
}

/** Resolve every path Cassandra needs for the project containing `cwd`. */
export function pathsFor(cwd: string): Paths {
  const root = join(dataRoot(), projectSlug(cwd))
  return {
    root,
    records: join(root, 'records'),
    pending: join(root, 'pending'),
    stats: join(root, 'stats.jsonl'),
  }
}

/** Sharded record location. The first two hex characters keep directories small. */
export function recordPath(paths: Paths, hash: string): string {
  return join(paths.records, hash.slice(0, 2), `${hash}.json`)
}

/** Marker written when the read path warns, so the outcome can be attributed without re-hashing. */
export function pendingPath(paths: Paths, toolUseId: string): string {
  const safe = toolUseId.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 120)
  return join(paths.pending, safe)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/paths.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/paths.ts test/paths.test.ts
git commit -m "feat: resolve data root, repo root and per-project index paths"
```

---

### Task 3: Fingerprinting

**Files:**

- Create: `src/fingerprint.ts`, `test/fingerprint.test.ts`

**Interfaces:**

- Consumes: `ToolKind` from `src/types.ts`.
- Produces:
  - `classify(toolName: string): ToolKind`
  - `stableStringify(value: unknown): string`
  - `displayFor(toolName: string, toolInput: unknown): string`
  - `fingerprint(toolName: string, toolInput: unknown): string | null`

- [ ] **Step 1: Write the failing test**

`test/fingerprint.test.ts`:

```ts
import { expect, test } from 'bun:test'
import { classify, displayFor, fingerprint, stableStringify } from '../src/fingerprint'

test('classify routes Bash, MCP tools and everything else', () => {
  expect(classify('Bash')).toBe('bash')
  expect(classify('mcp__knossos__scan_project')).toBe('mcp')
  expect(classify('Edit')).toBe('ignored')
  expect(classify('Write')).toBe('ignored')
})

test('whitespace variants of one command share a fingerprint', () => {
  const a = fingerprint('Bash', { command: 'bun test' })
  const b = fingerprint('Bash', { command: '  bun   test  ' })
  const c = fingerprint('Bash', { command: 'bun\ttest' })
  expect(a).toBe(b)
  expect(a).toBe(c)
})

test('different commands never collide', () => {
  expect(fingerprint('Bash', { command: 'rm foo' }))
    .not.toBe(fingerprint('Bash', { command: 'rm bar' }))
})

test('normalization does not merge commands that differ only by redirect or flag order', () => {
  const base = fingerprint('Bash', { command: 'bun test' })
  expect(fingerprint('Bash', { command: 'bun test > out.txt' })).not.toBe(base)
  expect(fingerprint('Bash', { command: 'bun test --bail --coverage' }))
    .not.toBe(fingerprint('Bash', { command: 'bun test --coverage --bail' }))
})

test('commands containing quotes, backslashes and newlines survive intact', () => {
  const gnarly = 'git commit -m "fix \\"quoted\\" thing"'
  expect(fingerprint('Bash', { command: gnarly }))
    .toBe(fingerprint('Bash', { command: gnarly }))
  const heredoc = "cat <<'EOF' > f\nline one\nline two\nEOF"
  expect(fingerprint('Bash', { command: heredoc })).toBeString()
})

test('MCP fingerprints ignore key order', () => {
  const a = fingerprint('mcp__k__scan', { project_id: 'pp', depth: 3 })
  const b = fingerprint('mcp__k__scan', { depth: 3, project_id: 'pp' })
  expect(a).toBe(b)
})

test('MCP fingerprints separate different argument values', () => {
  expect(fingerprint('mcp__k__scan', { depth: 3 }))
    .not.toBe(fingerprint('mcp__k__scan', { depth: 4 }))
})

test('the same input to different MCP tools does not collide', () => {
  expect(fingerprint('mcp__a__run', { x: 1 })).not.toBe(fingerprint('mcp__b__run', { x: 1 }))
})

test('malformed or ignored input yields null rather than throwing', () => {
  expect(fingerprint('Edit', { old_string: 'a' })).toBeNull()
  expect(fingerprint('Bash', {})).toBeNull()
  expect(fingerprint('Bash', null)).toBeNull()
  expect(fingerprint('Bash', { command: '   ' })).toBeNull()
})

test('stableStringify sorts nested keys', () => {
  expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}')
})

test('displayFor truncates long commands for human output', () => {
  const long = 'x'.repeat(300)
  expect(displayFor('Bash', { command: long }).length).toBeLessThanOrEqual(120)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/fingerprint.test.ts`
Expected: FAIL, cannot resolve `../src/fingerprint`.

- [ ] **Step 3: Write the implementation**

`src/fingerprint.ts`:

```ts
import { createHash } from 'node:crypto'
import type { ToolKind } from './types'

/** Which extractor a tool name routes to. Edit and Write payloads never repeat, so they are ignored. */
export function classify(toolName: string): ToolKind {
  if (toolName === 'Bash') return 'bash'
  if (toolName.startsWith('mcp__')) return 'mcp'
  return 'ignored'
}

/**
 * JSON with every object's keys sorted, recursively. Two calls carrying the same
 * arguments in a different order therefore hash identically, which removes any
 * dependence on the harness serializing key order consistently.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.keys(value as Record<string, unknown>).sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
  return `{${entries.join(',')}}`
}

/**
 * The significant part of a tool input, normalized.
 *
 * Normalization is deliberately stingy. A miss costs silence, which is the status
 * quo; a false match costs a confidently wrong warning, which is what teaches you
 * to ignore the tool. So only whitespace is touched.
 */
function significant(toolName: string, toolInput: unknown): string | null {
  const kind = classify(toolName)
  if (kind === 'ignored') return null
  if (toolInput === null || typeof toolInput !== 'object') return null

  if (kind === 'bash') {
    const command = (toolInput as { command?: unknown }).command
    if (typeof command !== 'string') return null
    const normalized = command.trim().replace(/\s+/g, ' ')
    return normalized.length > 0 ? normalized : null
  }

  return stableStringify(toolInput)
}

/** A short human label for CLI output and the warning text. */
export function displayFor(toolName: string, toolInput: unknown): string {
  const sig = significant(toolName, toolInput) ?? ''
  const text = classify(toolName) === 'bash' ? sig : `${toolName} ${sig}`
  return text.length > 120 ? `${text.slice(0, 117)}...` : text
}

/**
 * Stable 16-character fingerprint, or null when this call is not one Cassandra tracks.
 * sha256 rather than Bun.hash, which is not guaranteed stable across Bun versions and
 * would silently invalidate every stored record on an upgrade.
 */
export function fingerprint(toolName: string, toolInput: unknown): string | null {
  const sig = significant(toolName, toolInput)
  if (sig === null) return null
  return createHash('sha256').update(`${toolName} ${sig}`).digest('hex').slice(0, 16)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/fingerprint.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src/fingerprint.ts test/fingerprint.test.ts
git commit -m "feat: fingerprint Bash and MCP calls with stingy normalization"
```

---

### Task 4: Record storage

**Files:**

- Create: `src/record.ts`, `test/record.test.ts`

**Interfaces:**

- Consumes: `Paths`, `recordPath` from `src/paths.ts`; `FailureRecord` from `src/types.ts`.
- Produces:
  - `readRecord(paths: Paths, hash: string): FailureRecord | null`
  - `upsertRecord(paths: Paths, hash: string, seed: Omit<FailureRecord, 'count' | 'firstSeen' | 'lastSeen'>): void`
  - `deleteRecord(paths: Paths, hash: string): void`
  - `listRecords(paths: Paths): Array<{ hash: string; record: FailureRecord }>`

- [ ] **Step 1: Write the failing test**

`test/record.test.ts`:

```ts
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathsFor, recordPath, type Paths } from '../src/paths'
import { deleteRecord, listRecords, readRecord, upsertRecord } from '../src/record'

let tmp: string
let paths: Paths

const seed = {
  tool: 'Bash',
  display: 'bun test',
  kind: 'failure' as const,
  stateStamp: 'a3f1c8',
  stateKind: 'git' as const,
  sessionId: 's1',
  compactions: 0,
  errorExcerpt: '3 tests failing',
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cass-rec-'))
  process.env.CASSANDRA_HOME = join(tmp, 'home')
  paths = pathsFor(tmp)
})

afterEach(() => {
  delete process.env.CASSANDRA_HOME
  rmSync(tmp, { recursive: true, force: true })
})

test('a missing record reads as null', () => {
  expect(readRecord(paths, 'deadbeefdeadbeef')).toBeNull()
})

test('upsert creates a record with count 1', () => {
  upsertRecord(paths, 'aa11bb22cc33dd44', seed)
  const r = readRecord(paths, 'aa11bb22cc33dd44')
  expect(r?.count).toBe(1)
  expect(r?.display).toBe('bun test')
  expect(r?.firstSeen).toBe(r?.lastSeen)
})

test('upsert on an existing record increments and refreshes state, keeping firstSeen', () => {
  upsertRecord(paths, 'aa11bb22cc33dd44', seed)
  const first = readRecord(paths, 'aa11bb22cc33dd44')!
  upsertRecord(paths, 'aa11bb22cc33dd44', { ...seed, stateStamp: '9c0201', sessionId: 's2' })
  const second = readRecord(paths, 'aa11bb22cc33dd44')!
  expect(second.count).toBe(2)
  expect(second.stateStamp).toBe('9c0201')
  expect(second.sessionId).toBe('s2')
  expect(second.firstSeen).toBe(first.firstSeen)
})

test('a corrupt record is deleted and reads as null', () => {
  const p = recordPath(paths, 'ffeeddccbbaa9988')
  mkdirSync(join(paths.records, 'ff'), { recursive: true })
  writeFileSync(p, 'not json at all')
  expect(readRecord(paths, 'ffeeddccbbaa9988')).toBeNull()
  expect(existsSync(p)).toBe(false)
})

test('a record missing required fields is treated as corrupt', () => {
  const p = recordPath(paths, '1122334455667788')
  mkdirSync(join(paths.records, '11'), { recursive: true })
  writeFileSync(p, JSON.stringify({ tool: 'Bash' }))
  expect(readRecord(paths, '1122334455667788')).toBeNull()
  expect(existsSync(p)).toBe(false)
})

test('delete removes a record', () => {
  upsertRecord(paths, 'aa11bb22cc33dd44', seed)
  deleteRecord(paths, 'aa11bb22cc33dd44')
  expect(readRecord(paths, 'aa11bb22cc33dd44')).toBeNull()
})

test('delete on a missing record does not throw', () => {
  expect(() => deleteRecord(paths, 'nosuchnosuch1234')).not.toThrow()
})

test('listRecords returns every stored record across shards', () => {
  upsertRecord(paths, 'aa11bb22cc33dd44', seed)
  upsertRecord(paths, 'bb11bb22cc33dd44', { ...seed, display: 'bun run build' })
  const all = listRecords(paths)
  expect(all).toHaveLength(2)
  expect(all.map((e) => e.record.display).sort()).toEqual(['bun run build', 'bun test'])
})

test('listRecords on an empty index returns an empty array', () => {
  expect(listRecords(paths)).toEqual([])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/record.test.ts`
Expected: FAIL, cannot resolve `../src/record`.

- [ ] **Step 3: Write the implementation**

`src/record.ts`:

```ts
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { recordPath, type Paths } from './paths'
import type { FailureRecord } from './types'

/** Fields a caller supplies; count and timestamps are managed here. */
type RecordSeed = Omit<FailureRecord, 'count' | 'firstSeen' | 'lastSeen'>

const REQUIRED = ['tool', 'display', 'kind', 'count', 'stateStamp', 'stateKind', 'firstSeen', 'lastSeen'] as const

function looksValid(value: unknown): value is FailureRecord {
  if (value === null || typeof value !== 'object') return false
  const r = value as Record<string, unknown>
  return REQUIRED.every((k) => r[k] !== undefined)
}

/**
 * Read one record. Anything unreadable, unparseable or structurally wrong is deleted
 * rather than repaired: a corrupt record cannot be trusted to gate a warning, and
 * leaving it in place would make every later read pay the same failure.
 */
export function readRecord(paths: Paths, hash: string): FailureRecord | null {
  const p = recordPath(paths, hash)
  if (!existsSync(p)) return null
  try {
    const parsed: unknown = JSON.parse(readFileSync(p, 'utf8'))
    if (!looksValid(parsed)) {
      deleteRecord(paths, hash)
      return null
    }
    return parsed
  } catch {
    deleteRecord(paths, hash)
    return null
  }
}

/** Create a record, or increment an existing one and refresh its mutable fields. */
export function upsertRecord(paths: Paths, hash: string, seed: RecordSeed): void {
  const now = new Date().toISOString()
  const existing = readRecord(paths, hash)
  const next: FailureRecord = {
    ...seed,
    count: (existing?.count ?? 0) + 1,
    firstSeen: existing?.firstSeen ?? now,
    lastSeen: now,
  }
  const p = recordPath(paths, hash)
  try {
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, JSON.stringify(next))
  } catch {
    // An unwritable index must not break a session. The record is simply lost.
  }
}

/** Remove a record. Missing is not an error. */
export function deleteRecord(paths: Paths, hash: string): void {
  try {
    rmSync(recordPath(paths, hash), { force: true })
  } catch {
    // Best effort by design.
  }
}

/** Every stored record for this project, walked across the hash shards. */
export function listRecords(paths: Paths): Array<{ hash: string; record: FailureRecord }> {
  const out: Array<{ hash: string; record: FailureRecord }> = []
  if (!existsSync(paths.records)) return out
  try {
    for (const shard of readdirSync(paths.records)) {
      const dir = join(paths.records, shard)
      for (const file of readdirSync(dir)) {
        if (!file.endsWith('.json')) continue
        const hash = file.slice(0, -5)
        const record = readRecord(paths, hash)
        if (record) out.push({ hash, record })
      }
    }
  } catch {
    // A partially readable index still returns what it could read.
  }
  return out
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/record.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/record.ts test/record.test.ts
git commit -m "feat: store, increment and self-heal failure records"
```

---

### Task 5: Freshness probe and false-positive harness (TRACKED RISK)

This is the task the user singled out. Build the probe **and** the harness that measures it in the same task, so the baseline exists before anything depends on it.

**Files:**

- Create: `src/freshness.ts`, `test/freshness.test.ts`, `scripts/fp-harness.ts`

**Interfaces:**

- Consumes: `StateStamp`, `StateKind` from `src/types.ts`; `findRepoRoot` from `src/paths.ts`.
- Produces:
  - `stateStamp(cwd: string): StateStamp`
  - `unchanged(recorded: string, recordedKind: StateKind, current: StateStamp): boolean`

- [ ] **Step 1: Write the failing test**

`test/freshness.test.ts`:

```ts
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { stateStamp, unchanged } from '../src/freshness'

let tmp: string

function git(cwd: string, ...args: string[]): void {
  Bun.spawnSync(['git', ...args], { cwd, stdout: 'ignore', stderr: 'ignore' })
}

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q')
  git(dir, 'config', 'user.email', 't@example.com')
  git(dir, 'config', 'user.name', 'T')
  writeFileSync(join(dir, 'a.txt'), 'one')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'init')
}

beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'cass-fresh-')) })
afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

// The safety rule that bounds the whole risk.
test('a none stamp never counts as unchanged', () => {
  expect(unchanged('anything', 'git', { kind: 'none', value: '' })).toBe(false)
  expect(unchanged('', 'none', { kind: 'none', value: '' })).toBe(false)
  expect(unchanged('x', 'none', { kind: 'git', value: 'x' })).toBe(false)
})

test('a stamp taken twice with nothing touched is identical', () => {
  const repo = join(tmp, 'r'); initRepo(repo)
  expect(stateStamp(repo).value).toBe(stateStamp(repo).value)
})

test('git: an uncommitted edit changes the stamp', () => {
  const repo = join(tmp, 'r'); initRepo(repo)
  const before = stateStamp(repo)
  writeFileSync(join(repo, 'a.txt'), 'two')
  expect(stateStamp(repo).value).not.toBe(before.value)
})

test('git: a new untracked file changes the stamp', () => {
  const repo = join(tmp, 'r'); initRepo(repo)
  const before = stateStamp(repo)
  writeFileSync(join(repo, 'b.txt'), 'new')
  expect(stateStamp(repo).value).not.toBe(before.value)
})

test('git: a commit changes the stamp', () => {
  const repo = join(tmp, 'r'); initRepo(repo)
  const before = stateStamp(repo)
  writeFileSync(join(repo, 'a.txt'), 'two')
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'second')
  expect(stateStamp(repo).value).not.toBe(before.value)
})

test('git: a sed -i style rewrite changes the stamp', () => {
  const repo = join(tmp, 'r'); initRepo(repo)
  const before = stateStamp(repo)
  Bun.spawnSync(['sed', '-i', 's/one/three/', join(repo, 'a.txt')], { cwd: repo })
  expect(stateStamp(repo).value).not.toBe(before.value)
})

test('git: stamp kind is git inside a repository', () => {
  const repo = join(tmp, 'r'); initRepo(repo)
  expect(stateStamp(repo).kind).toBe('git')
})

test('mtime: kind is mtime outside a repository', () => {
  const plain = join(tmp, 'p'); mkdirSync(plain, { recursive: true })
  writeFileSync(join(plain, 'a.txt'), 'one')
  expect(stateStamp(plain).kind).toBe('mtime')
})

test('mtime: a rewritten file changes the stamp', async () => {
  const plain = join(tmp, 'p'); mkdirSync(plain, { recursive: true })
  writeFileSync(join(plain, 'a.txt'), 'one')
  const before = stateStamp(plain)
  await Bun.sleep(1100)
  writeFileSync(join(plain, 'a.txt'), 'two')
  expect(stateStamp(plain).value).not.toBe(before.value)
})

test('mtime: a new file changes the stamp even within the same second', () => {
  const plain = join(tmp, 'p'); mkdirSync(plain, { recursive: true })
  writeFileSync(join(plain, 'a.txt'), 'one')
  const before = stateStamp(plain)
  writeFileSync(join(plain, 'b.txt'), 'new')
  expect(stateStamp(plain).value).not.toBe(before.value)
})

test('mtime: dot directories and node_modules are skipped', () => {
  const plain = join(tmp, 'p'); mkdirSync(join(plain, 'node_modules'), { recursive: true })
  mkdirSync(join(plain, '.cache'), { recursive: true })
  writeFileSync(join(plain, 'a.txt'), 'one')
  const before = stateStamp(plain)
  writeFileSync(join(plain, 'node_modules', 'x'), 'noise')
  writeFileSync(join(plain, '.cache', 'y'), 'noise')
  expect(stateStamp(plain).value).toBe(before.value)
})

test('a nonexistent directory yields none rather than throwing', () => {
  expect(stateStamp(join(tmp, 'gone')).kind).toBe('none')
})

test('unchanged requires the kind to match, so a fallback switch never warns', () => {
  expect(unchanged('abc', 'git', { kind: 'mtime', value: 'abc' })).toBe(false)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/freshness.test.ts`
Expected: FAIL, cannot resolve `../src/freshness`.

- [ ] **Step 3: Write the implementation**

`src/freshness.ts`:

```ts
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { findRepoRoot } from './paths'
import type { StateKind, StateStamp } from './types'

/** Directories the mtime walk never descends into: churn that says nothing about source. */
const SKIP = new Set(['node_modules', 'dist', 'build', 'target', 'coverage', 'vendor', '__pycache__'])

/** Bounds on the mtime walk, so an enormous tree cannot stall the probe. */
const MAX_DEPTH = 6
const MAX_ENTRIES = 5000

/**
 * Stamp a git worktree: HEAD plus the full porcelain status. This is the strong path.
 * It sees commits, staged and unstaged edits, and untracked files, which together
 * cover every way the workspace moves, including edits made outside Claude Code.
 */
function gitStamp(root: string): StateStamp | null {
  try {
    const head = Bun.spawnSync(['git', '-C', root, 'rev-parse', 'HEAD'], { stderr: 'ignore' })
    const status = Bun.spawnSync(['git', '-C', root, 'status', '--porcelain'], { stderr: 'ignore' })
    if (status.exitCode !== 0) return null
    const text = `${head.stdout.toString()} ${status.stdout.toString()}`
    return { kind: 'git', value: createHash('sha256').update(text).digest('hex').slice(0, 16) }
  } catch {
    return null
  }
}

/**
 * Fallback for directories that are not git worktrees.
 *
 * This is the weakest part of Cassandra and is treated as such. It folds in every
 * entry's name, size and mtime rather than only the maximum mtime, so a file
 * rewritten within the same second, or replaced by one of a different length, still
 * moves the stamp. It is bounded in depth and entry count, and any failure degrades
 * to `none`, which never warns.
 */
function mtimeStamp(root: string): StateStamp | null {
  const parts: string[] = []
  let seen = 0
  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH || seen >= MAX_ENTRIES) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (seen >= MAX_ENTRIES) return
      if (entry.name.startsWith('.') || SKIP.has(entry.name)) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      try {
        const st = statSync(full)
        parts.push(`${full}:${st.size}:${st.mtimeMs}`)
        seen += 1
      } catch {
        // A file that vanished mid-walk simply does not contribute.
      }
    }
  }
  try {
    walk(root, 0)
  } catch {
    return null
  }
  if (parts.length === 0) return null
  return { kind: 'mtime', value: createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16) }
}

/**
 * Fingerprint the workspace so a later call can ask whether anything changed.
 *
 * Runs only after a hash hit, never on a miss, which is what lets it afford a
 * subprocess. Returns `none` when it cannot tell, and `none` never warns.
 */
export function stateStamp(cwd: string): StateStamp {
  if (!existsSync(cwd)) return { kind: 'none', value: '' }
  const root = findRepoRoot(cwd)
  if (existsSync(join(root, '.git'))) {
    const stamp = gitStamp(root)
    if (stamp) return stamp
  }
  return mtimeStamp(root) ?? { kind: 'none', value: '' }
}

/**
 * Whether the workspace is provably unchanged since a failure was recorded.
 *
 * Deliberately conservative on three counts: an unknown current state never
 * matches, an unknown recorded state never matches, and a change of probe kind
 * between the two readings never matches. Every uncertain case resolves to
 * "something may have changed", which means silence.
 */
export function unchanged(recorded: string, recordedKind: StateKind, current: StateStamp): boolean {
  if (current.kind === 'none' || recordedKind === 'none') return false
  if (current.kind !== recordedKind) return false
  if (!recorded || !current.value) return false
  return recorded === current.value
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/freshness.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Write the false-positive harness**

`scripts/fp-harness.ts`:

```ts
/**
 * Freshness probe false-positive harness. Tracked risk.
 *
 * A false positive is the probe reporting "unchanged" after something really did
 * change, because that is what makes Cassandra warn about a command that has
 * already been fixed. This harness applies a catalogue of real mutation shapes and
 * asserts the stamp moved for every one.
 *
 * Re-run unchanged at checkpoints FP-2 and FP-3. Any regression is a stop.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { stateStamp } from '../src/freshness'

interface Mutation {
  name: string
  apply: (dir: string) => void
}

const MUTATIONS: Mutation[] = [
  { name: 'edit a tracked file', apply: (d) => writeFileSync(join(d, 'a.txt'), 'changed') },
  { name: 'create a new file', apply: (d) => writeFileSync(join(d, 'new.txt'), 'x') },
  { name: 'delete a file', apply: (d) => rmSync(join(d, 'a.txt'), { force: true }) },
  { name: 'sed -i rewrite', apply: (d) => { Bun.spawnSync(['sed', '-i', 's/one/two/', join(d, 'a.txt')]) } },
  { name: 'heredoc write', apply: (d) => writeFileSync(join(d, 'a.txt'), 'line one\nline two\n') },
  { name: 'same-length rewrite', apply: (d) => writeFileSync(join(d, 'a.txt'), 'ONE') },
  {
    name: 'rewrite with mtime restored',
    apply: (d) => {
      const p = join(d, 'a.txt')
      writeFileSync(p, 'xyz')
      utimesSync(p, new Date(1000000), new Date(1000000))
    },
  },
  {
    name: 'create a nested file',
    apply: (d) => { mkdirSync(join(d, 'sub'), { recursive: true }); writeFileSync(join(d, 'sub', 'c.txt'), 'y') },
  },
  {
    name: 'rename a file',
    apply: (d) => { writeFileSync(join(d, 'renamed.txt'), 'one'); rmSync(join(d, 'a.txt'), { force: true }) },
  },
]

function seed(dir: string, asRepo: boolean): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'a.txt'), 'one')
  if (!asRepo) return
  const run = (...args: string[]): void => {
    Bun.spawnSync(['git', '-C', dir, ...args], { stdout: 'ignore', stderr: 'ignore' })
  }
  run('init', '-q')
  run('config', 'user.email', 't@example.com')
  run('config', 'user.name', 'T')
  run('add', '-A')
  run('commit', '-qm', 'init')
}

function runSynthetic(): number {
  const root = mkdtempSync(join(tmpdir(), 'cass-fp-'))
  let failures = 0
  let total = 0

  for (const asRepo of [true, false]) {
    const mode = asRepo ? 'git  ' : 'mtime'
    for (const m of MUTATIONS) {
      const dir = join(root, `${asRepo ? 'g' : 'm'}-${m.name.replace(/\W+/g, '-')}`)
      seed(dir, asRepo)
      const before = stateStamp(dir)
      m.apply(dir)
      const after = stateStamp(dir)
      total += 1
      const moved = before.value !== after.value && after.kind !== 'none'
      if (!moved) {
        failures += 1
        console.error(`FALSE POSITIVE  [${mode}] ${m.name}: stamp did not move (kind=${after.kind})`)
      }
    }
  }

  rmSync(root, { recursive: true, force: true })
  const rate = ((failures / total) * 100).toFixed(1)
  console.error(`\nfreshness FP harness: ${total - failures}/${total} mutations detected, false-positive rate ${rate}%`)
  return failures === 0 ? 0 : 1
}

/**
 * Real-repository mode. The synthetic harness proves the probe reacts to mutations
 * in a directory built for the purpose. This proves two further things against real
 * trees: that a stamp is stable when genuinely nothing changes, which is what stops
 * Cassandra going silent when it should speak, and that the probe returns in a time
 * the hot path can afford.
 */
function runReal(): number {
  const roots = (process.env.CASSANDRA_FP_ROOTS ?? '/root/talanton,/root/kanon,/root/claude-timestamp,/root/aranea')
    .split(',').map((s) => s.trim()).filter((s) => s.length > 0 && existsSync(s))

  if (roots.length === 0) {
    console.error('fp:real: no candidate repositories found, set CASSANDRA_FP_ROOTS')
    return 0
  }

  let unstable = 0
  let slow = 0
  console.error('fp:real: probing real repositories\n')

  for (const root of roots) {
    const t0 = performance.now()
    const a = stateStamp(root)
    const elapsed = performance.now() - t0
    const b = stateStamp(root)

    const stable = a.value === b.value && a.kind !== 'none'
    if (!stable) unstable += 1
    if (elapsed > 200) slow += 1

    console.error(`  ${stable ? 'stable  ' : 'UNSTABLE'}  ${a.kind.padEnd(5)}  ${elapsed.toFixed(0).padStart(4)}ms  ${root}`)
  }

  console.error(`\nfp:real: ${roots.length - unstable}/${roots.length} stable, ${slow} over the 200ms budget`)
  return unstable === 0 && slow === 0 ? 0 : 1
}

process.exit(process.argv.includes('--real') ? runReal() : runSynthetic())
```

- [ ] **Step 6: Establish checkpoint FP-1**

Run: `bun run fp`
Expected: exit 0, and a final line reading `18/18 mutations detected, false-positive rate 0.0%`.

**If any mutation is not detected, stop and report it before starting Task 6.** Record the exact output in the commit message so later checkpoints have a baseline to compare against. The `rewrite with mtime restored` and `same-length rewrite` cases are the ones most likely to fail on the mtime path, and both are the reason the walk folds in size and name rather than only the maximum mtime.

- [ ] **Step 7: Commit**

```bash
git add src/freshness.ts test/freshness.test.ts scripts/fp-harness.ts
git commit -m "feat: probe workspace freshness with a git path and a bounded mtime fallback

An unknown state never counts as unchanged, so every uncertain case resolves to
silence rather than a warning. Adds the false-positive harness that guards this;
FP-1 baseline is 18/18 mutations detected."
```

---

### Task 6: Efficacy log

**Files:**

- Create: `src/stats.ts`, `test/stats.test.ts`

**Interfaces:**

- Consumes: `Paths` from `src/paths.ts`.
- Produces:
  - `type Boundary = 'compaction' | 'session' | 'subagent' | 'same_context'`
  - `type StatKind = 'warned' | 'false_positive' | 'confirmed'`
  - `interface StatEvent { t: string; kind: StatKind; hash: string; boundary?: Boundary }`
  - `appendStat(paths: Paths, event: Omit<StatEvent, 't'>): void`
  - `readStats(paths: Paths): StatEvent[]`
  - `attributeBoundary(recorded: { sessionId: string; compactions: number }, current: { sessionId: string; compactions: number; agentId?: string }): Boundary`

- [ ] **Step 1: Write the failing test**

`test/stats.test.ts`:

```ts
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathsFor, type Paths } from '../src/paths'
import { appendStat, attributeBoundary, readStats } from '../src/stats'

let tmp: string
let paths: Paths

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cass-stats-'))
  process.env.CASSANDRA_HOME = join(tmp, 'home')
  paths = pathsFor(tmp)
})

afterEach(() => {
  delete process.env.CASSANDRA_HOME
  rmSync(tmp, { recursive: true, force: true })
})

test('reading an absent log yields an empty array', () => {
  expect(readStats(paths)).toEqual([])
})

test('appended events round-trip in order', () => {
  appendStat(paths, { kind: 'warned', hash: 'aaaa', boundary: 'compaction' })
  appendStat(paths, { kind: 'confirmed', hash: 'aaaa' })
  const events = readStats(paths)
  expect(events).toHaveLength(2)
  expect(events[0]!.kind).toBe('warned')
  expect(events[0]!.boundary).toBe('compaction')
  expect(events[1]!.kind).toBe('confirmed')
  expect(events[0]!.t).toBeString()
})

test('a corrupt line is skipped rather than failing the read', () => {
  appendStat(paths, { kind: 'warned', hash: 'aaaa' })
  appendFileSync(paths.stats, 'not json at all\n')
  appendStat(paths, { kind: 'confirmed', hash: 'aaaa' })
  expect(readStats(paths)).toHaveLength(2)
})

test('a subagent warning is attributed to the subagent boundary', () => {
  expect(attributeBoundary(
    { sessionId: 's1', compactions: 0 },
    { sessionId: 's1', compactions: 0, agentId: 'a1' },
  )).toBe('subagent')
})

test('a warning in a later session is attributed to the session boundary', () => {
  expect(attributeBoundary(
    { sessionId: 's1', compactions: 0 },
    { sessionId: 's2', compactions: 0 },
  )).toBe('session')
})

test('a warning after a compaction is attributed to compaction', () => {
  expect(attributeBoundary(
    { sessionId: 's1', compactions: 0 },
    { sessionId: 's1', compactions: 1 },
  )).toBe('compaction')
})

test('a warning inside one intact context is attributed to same_context', () => {
  expect(attributeBoundary(
    { sessionId: 's1', compactions: 2 },
    { sessionId: 's1', compactions: 2 },
  )).toBe('same_context')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/stats.test.ts`
Expected: FAIL, cannot resolve `../src/stats`.

- [ ] **Step 3: Write the implementation**

`src/stats.ts`:

```ts
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import type { Paths } from './paths'

/** Which boundary a warning crossed. `same_context` means the model could already see the failure. */
export type Boundary = 'compaction' | 'session' | 'subagent' | 'same_context'

/**
 * What happened to a warning. `false_positive` means the warned call then succeeded,
 * so the freshness probe missed a real change. `confirmed` means it failed again.
 */
export type StatKind = 'warned' | 'false_positive' | 'confirmed'

/** One line of the efficacy log. */
export interface StatEvent {
  t: string
  kind: StatKind
  hash: string
  boundary?: Boundary
}

/** Append one event. Never throws: losing a metric must not cost a session. */
export function appendStat(paths: Paths, event: Omit<StatEvent, 't'>): void {
  try {
    mkdirSync(paths.root, { recursive: true })
    appendFileSync(paths.stats, `${JSON.stringify({ t: new Date().toISOString(), ...event })}\n`)
  } catch {
    // Best effort by design.
  }
}

/** Read the log, skipping any line that does not parse. */
export function readStats(paths: Paths): StatEvent[] {
  if (!existsSync(paths.stats)) return []
  try {
    return readFileSync(paths.stats, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        try {
          return JSON.parse(line) as StatEvent
        } catch {
          return null
        }
      })
      .filter((e): e is StatEvent => e !== null)
  } catch {
    return []
  }
}

/**
 * Which boundary this warning crossed.
 *
 * Ordered most to least specific. A `same_context` warning is one the model could
 * have answered from its own transcript, so a high share of those is the signal
 * that Cassandra is not earning its place.
 */
export function attributeBoundary(
  recorded: { sessionId: string; compactions: number },
  current: { sessionId: string; compactions: number; agentId?: string },
): Boundary {
  if (current.agentId) return 'subagent'
  if (current.sessionId !== recorded.sessionId) return 'session'
  if (current.compactions > recorded.compactions) return 'compaction'
  return 'same_context'
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/stats.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/stats.ts test/stats.test.ts
git commit -m "feat: log warning efficacy and attribute each warning to a boundary"
```

---

### Task 7: Session state, for compaction counting

**Files:**

- Create: `src/session.ts`, `test/session.test.ts`

**Interfaces:**

- Consumes: `Paths` from `src/paths.ts`.
- Produces:
  - `compactionCount(paths: Paths, sessionId: string): number`
  - `bumpCompactions(paths: Paths, sessionId: string): void`

- [ ] **Step 1: Write the failing test**

`test/session.test.ts`:

```ts
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathsFor, type Paths } from '../src/paths'
import { bumpCompactions, compactionCount } from '../src/session'

let tmp: string
let paths: Paths

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cass-sess-'))
  process.env.CASSANDRA_HOME = join(tmp, 'home')
  paths = pathsFor(tmp)
})

afterEach(() => {
  delete process.env.CASSANDRA_HOME
  rmSync(tmp, { recursive: true, force: true })
})

test('an unseen session has zero compactions', () => {
  expect(compactionCount(paths, 's1')).toBe(0)
})

test('bump increments per session independently', () => {
  bumpCompactions(paths, 's1')
  bumpCompactions(paths, 's1')
  bumpCompactions(paths, 's2')
  expect(compactionCount(paths, 's1')).toBe(2)
  expect(compactionCount(paths, 's2')).toBe(1)
})

test('an empty session id is tolerated', () => {
  expect(() => bumpCompactions(paths, '')).not.toThrow()
  expect(compactionCount(paths, '')).toBe(0)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/session.test.ts`
Expected: FAIL, cannot resolve `../src/session`.

- [ ] **Step 3: Write the implementation**

`src/session.ts`:

```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Paths } from './paths'

/**
 * Compaction is the one boundary of the three that the PreToolUse payload cannot
 * reveal on its own, so a PostCompact hook counts them per session and records
 * store the count they were written at.
 */
function counterPath(paths: Paths, sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 120) || 'unknown'
  return join(paths.root, 'sessions', safe)
}

/** How many compactions this session has been through. Unknown reads as zero. */
export function compactionCount(paths: Paths, sessionId: string): number {
  if (!sessionId) return 0
  try {
    const p = counterPath(paths, sessionId)
    if (!existsSync(p)) return 0
    const n = Number.parseInt(readFileSync(p, 'utf8').trim(), 10)
    return Number.isFinite(n) && n >= 0 ? n : 0
  } catch {
    return 0
  }
}

/** Record that this session has compacted once more. Never throws. */
export function bumpCompactions(paths: Paths, sessionId: string): void {
  if (!sessionId) return
  try {
    const p = counterPath(paths, sessionId)
    mkdirSync(join(paths.root, 'sessions'), { recursive: true })
    writeFileSync(p, String(compactionCount(paths, sessionId) + 1))
  } catch {
    // Best effort by design.
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/session.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/session.ts test/session.test.ts
git commit -m "feat: count compactions per session for boundary attribution"
```

---

### Task 8: Hook entrypoint (CHECKPOINT FP-2)

**Files:**

- Create: `src/hook.ts`, `test/hook.test.ts`

**Interfaces:**

- Consumes: everything from Tasks 2 to 7.
- Produces: `handle(payload: HookPayload): string | null`, returning the JSON line to print or null for silence. The module's top level reads stdin, calls `handle`, prints any result and always exits 0.

- [ ] **Step 1: Write the failing test**

`test/hook.test.ts`:

```ts
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { handle } from '../src/hook'
import { pathsFor, pendingPath } from '../src/paths'
import { fingerprint } from '../src/fingerprint'
import { readRecord } from '../src/record'
import { readStats } from '../src/stats'

let tmp: string
let cwd: string

function gitInit(dir: string): void {
  const run = (...a: string[]): void => {
    Bun.spawnSync(['git', '-C', dir, ...a], { stdout: 'ignore', stderr: 'ignore' })
  }
  run('init', '-q'); run('config', 'user.email', 't@e.com'); run('config', 'user.name', 'T')
  writeFileSync(join(dir, 'a.txt'), 'one')
  run('add', '-A'); run('commit', '-qm', 'init')
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cass-hook-'))
  process.env.CASSANDRA_HOME = join(tmp, 'home')
  cwd = join(tmp, 'repo')
  mkdirSync(cwd, { recursive: true })
  gitInit(cwd)
})

afterEach(() => {
  delete process.env.CASSANDRA_HOME
  rmSync(tmp, { recursive: true, force: true })
})

const fail = (command: string) => ({
  hook_event_name: 'PostToolUseFailure',
  session_id: 's1', cwd, tool_name: 'Bash',
  tool_input: { command }, tool_use_id: 't1', error_message: '3 tests failing',
})

const pre = (command: string, extra: Record<string, unknown> = {}) => ({
  hook_event_name: 'PreToolUse',
  session_id: 's1', cwd, tool_name: 'Bash',
  tool_input: { command }, tool_use_id: 't2', ...extra,
})

test('an unknown command is silent', () => {
  expect(handle(pre('bun test'))).toBeNull()
})

test('a failure is recorded', () => {
  handle(fail('bun test'))
  const hash = fingerprint('Bash', { command: 'bun test' })!
  expect(readRecord(pathsFor(cwd), hash)?.count).toBe(1)
})

test('a repeat with nothing changed warns', () => {
  handle(fail('bun test'))
  const out = handle(pre('bun test'))
  expect(out).toBeString()
  const parsed = JSON.parse(out!)
  expect(parsed.hookSpecificOutput.hookEventName).toBe('PreToolUse')
  expect(parsed.hookSpecificOutput.additionalContext).toContain('bun test')
  expect(parsed.hookSpecificOutput.additionalContext).toContain('3 tests failing')
})

test('a repeat after a real edit is silent', () => {
  handle(fail('bun test'))
  writeFileSync(join(cwd, 'a.txt'), 'changed')
  expect(handle(pre('bun test'))).toBeNull()
})

test('warning writes a pending marker naming the record', () => {
  handle(fail('bun test'))
  handle(pre('bun test'))
  expect(existsSync(pendingPath(pathsFor(cwd), 't2'))).toBe(true)
})

test('a success on a warned call clears the record and logs a false positive', () => {
  handle(fail('bun test'))
  handle(pre('bun test'))
  handle({
    hook_event_name: 'PostToolUse', session_id: 's1', cwd,
    tool_name: 'Bash', tool_input: { command: 'bun test' }, tool_use_id: 't2',
  })
  const hash = fingerprint('Bash', { command: 'bun test' })!
  expect(readRecord(pathsFor(cwd), hash)).toBeNull()
  expect(readStats(pathsFor(cwd)).some((e) => e.kind === 'false_positive')).toBe(true)
})

test('a repeat failure on a warned call logs confirmed and does not clear', () => {
  handle(fail('bun test'))
  handle(pre('bun test'))
  handle({ ...fail('bun test'), tool_use_id: 't2' })
  const hash = fingerprint('Bash', { command: 'bun test' })!
  expect(readRecord(pathsFor(cwd), hash)?.count).toBe(2)
  expect(readStats(pathsFor(cwd)).some((e) => e.kind === 'confirmed')).toBe(true)
})

test('a success on a call that was never warned about clears nothing', () => {
  handle(fail('bun test'))
  const out = handle({
    hook_event_name: 'PostToolUse', session_id: 's1', cwd,
    tool_name: 'Bash', tool_input: { command: 'bun test' }, tool_use_id: 'never-warned',
  })
  expect(out).toBeNull()
  const hash = fingerprint('Bash', { command: 'bun test' })!
  expect(readRecord(pathsFor(cwd), hash)).not.toBeNull()
})

test('a permission denial is recorded and warns on repeat', () => {
  handle({
    hook_event_name: 'PermissionDenied', session_id: 's1', cwd,
    tool_name: 'Bash', tool_input: { command: 'curl example.com' },
    tool_use_id: 't9', denial_reason: 'network egress',
  })
  const out = handle(pre('curl example.com'))
  expect(out).toBeString()
  expect(JSON.parse(out!).hookSpecificOutput.additionalContext).toContain('network egress')
})

test('a subagent repeat is attributed to the subagent boundary', () => {
  handle(fail('bun test'))
  handle(pre('bun test', { agent_id: 'a1', tool_use_id: 't5' }))
  expect(readStats(pathsFor(cwd)).some((e) => e.kind === 'warned' && e.boundary === 'subagent')).toBe(true)
})

test('a repeat after a compaction is attributed to compaction', () => {
  handle(fail('bun test'))
  handle({ hook_event_name: 'PostCompact', session_id: 's1', cwd })
  handle(pre('bun test', { tool_use_id: 't6' }))
  expect(readStats(pathsFor(cwd)).some((e) => e.kind === 'warned' && e.boundary === 'compaction')).toBe(true)
})

test('Edit and Write calls are ignored entirely', () => {
  expect(handle({
    hook_event_name: 'PostToolUseFailure', session_id: 's1', cwd,
    tool_name: 'Edit', tool_input: { old_string: 'a', new_string: 'b' },
    tool_use_id: 't7', error_message: 'boom',
  })).toBeNull()
  expect(handle({
    hook_event_name: 'PreToolUse', session_id: 's1', cwd,
    tool_name: 'Edit', tool_input: { old_string: 'a' }, tool_use_id: 't8',
  })).toBeNull()
})

test('an unknown event, empty payload or missing cwd is silent', () => {
  expect(handle({ hook_event_name: 'Nonsense' })).toBeNull()
  expect(handle({})).toBeNull()
  expect(handle({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'x' } })).toBeNull()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/hook.test.ts`
Expected: FAIL, cannot resolve `../src/hook`.

- [ ] **Step 3: Write the implementation**

`src/hook.ts`:

```ts
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { displayFor, fingerprint } from './fingerprint'
import { stateStamp, unchanged } from './freshness'
import { pathsFor, pendingPath, type Paths } from './paths'
import { deleteRecord, readRecord, upsertRecord } from './record'
import { bumpCompactions, compactionCount } from './session'
import { appendStat, attributeBoundary } from './stats'
import type { HookPayload, RecordKind } from './types'

const EXCERPT_MAX = 240

function excerpt(text: string | undefined): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim()
  return t.length > EXCERPT_MAX ? `${t.slice(0, EXCERPT_MAX - 3)}...` : t
}

/** Write the marker that lets PostToolUse attribute an outcome without re-hashing. */
function markPending(paths: Paths, toolUseId: string, hash: string): void {
  try {
    mkdirSync(paths.pending, { recursive: true })
    writeFileSync(pendingPath(paths, toolUseId), hash)
  } catch {
    // A missing marker only costs a metric.
  }
}

/** Read and remove the marker for a tool call, if this call was warned about. */
function takePending(paths: Paths, toolUseId: string): string | null {
  try {
    const p = pendingPath(paths, toolUseId)
    if (!existsSync(p)) return null
    const hash = readFileSync(p, 'utf8').trim()
    rmSync(p, { force: true })
    return hash || null
  } catch {
    return null
  }
}

function record(payload: HookPayload, kind: RecordKind, reason: string | undefined): null {
  const { tool_name: tool, tool_input: input, cwd, session_id: sessionId } = payload
  if (!tool || !cwd) return null
  const hash = fingerprint(tool, input)
  if (!hash) return null

  const paths = pathsFor(cwd)
  const stamp = stateStamp(cwd)

  // A state we cannot read is a record we could never safely act on, so do not store it.
  if (stamp.kind === 'none') return null

  upsertRecord(paths, hash, {
    tool,
    display: displayFor(tool, input),
    kind,
    stateStamp: stamp.value,
    stateKind: stamp.kind,
    sessionId: sessionId ?? '',
    compactions: compactionCount(paths, sessionId ?? ''),
    errorExcerpt: excerpt(reason),
  })
  return null
}

/** PostToolUseFailure and PermissionDenied both record, but a warned call also resolves its marker. */
function onFailure(payload: HookPayload, kind: RecordKind, reason: string | undefined): null {
  const { cwd, tool_use_id: toolUseId } = payload
  if (cwd && toolUseId) {
    const paths = pathsFor(cwd)
    const warned = takePending(paths, toolUseId)
    // It failed again after we warned, so the warning was right and was disregarded.
    if (warned) appendStat(paths, { kind: 'confirmed', hash: warned })
  }
  return record(payload, kind, reason)
}

/** A success on a warned call means the freshness probe missed a real change. */
function onSuccess(payload: HookPayload): null {
  const { cwd, tool_use_id: toolUseId } = payload
  if (!cwd || !toolUseId) return null
  const paths = pathsFor(cwd)
  const warned = takePending(paths, toolUseId)
  if (!warned) return null
  appendStat(paths, { kind: 'false_positive', hash: warned })
  deleteRecord(paths, warned)
  return null
}

/** The hot path: hash, look up, and only then pay for the freshness probe. */
function onPreToolUse(payload: HookPayload): string | null {
  const {
    tool_name: tool, tool_input: input, cwd,
    session_id: sessionId, tool_use_id: toolUseId, agent_id: agentId,
  } = payload
  if (!tool || !cwd) return null
  const hash = fingerprint(tool, input)
  if (!hash) return null

  const paths = pathsFor(cwd)
  const found = readRecord(paths, hash)
  if (!found) return null

  // Only now, on a hit, does the expensive probe run.
  if (!unchanged(found.stateStamp, found.stateKind, stateStamp(cwd))) return null

  const boundary = attributeBoundary(
    { sessionId: found.sessionId, compactions: found.compactions },
    { sessionId: sessionId ?? '', compactions: compactionCount(paths, sessionId ?? ''), agentId },
  )
  appendStat(paths, { kind: 'warned', hash, boundary })
  if (toolUseId) markPending(paths, toolUseId, hash)

  const what = found.kind === 'denial' ? 'was denied' : 'failed'
  const times = found.count === 1 ? 'once' : `${found.count} times`
  const detail = found.errorExcerpt ? ` Last reason: ${found.errorExcerpt}` : ''
  const text = `cassandra: \`${found.display}\` ${what} ${times} before, most recently ${found.lastSeen}. `
    + `Nothing in this workspace has changed since.${detail}`

  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: text },
  })
}

/**
 * Route one hook payload. Returns the JSON line to print, or null for silence.
 * Separated from stdin handling so every branch is directly testable.
 */
export function handle(payload: HookPayload): string | null {
  switch (payload.hook_event_name) {
    case 'PreToolUse': return onPreToolUse(payload)
    case 'PostToolUse': return onSuccess(payload)
    case 'PostToolUseFailure': return onFailure(payload, 'failure', payload.error_message)
    case 'PermissionDenied': return onFailure(payload, 'denial', payload.denial_reason)
    case 'PostCompact':
      if (payload.cwd) bumpCompactions(pathsFor(payload.cwd), payload.session_id ?? '')
      return null
    default: return null
  }
}

if (import.meta.main) {
  // Nothing below may throw or exit non-zero. A hook that fails is a session that fails.
  try {
    const raw = await Bun.stdin.text()
    const out = handle(JSON.parse(raw) as HookPayload)
    if (out) process.stdout.write(`${out}\n`)
  } catch {
    // Unparseable input, unreadable index, anything at all: leave quietly.
  }
  process.exit(0)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/hook.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Run checkpoint FP-2**

Run: `bun run fp`
Expected: identical to FP-1, `18/18 mutations detected, false-positive rate 0.0%`.

**If the rate moved, stop and report before continuing.** Integration is the first point where the probe is called with real payload-derived paths rather than test-constructed ones, so a regression here means `cwd` handling, not the probe itself.

- [ ] **Step 6: Run the full suite**

Run: `bun test`
Expected: PASS, all files.

- [ ] **Step 7: Commit**

```bash
git add src/hook.ts test/hook.test.ts
git commit -m "feat: route hook events through record, gate and warn paths

The freshness probe runs only after a hash hit, so a miss costs one hash and one
existsSync. FP-2 checkpoint unchanged at 18/18."
```

---

### Task 9: Robustness, the load-bearing test

**Files:**

- Create: `test/robustness.test.ts`

**Interfaces:**

- Consumes: `handle` from `src/hook.ts`.
- Produces: nothing. This task adds guarantees, not surface.

- [ ] **Step 1: Write the test**

`test/robustness.test.ts`:

```ts
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { handle } from '../src/hook'
import type { HookPayload } from '../src/types'

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cass-rob-'))
  process.env.CASSANDRA_HOME = join(tmp, 'home')
})

afterEach(() => {
  delete process.env.CASSANDRA_HOME
  rmSync(tmp, { recursive: true, force: true })
})

const EVENTS = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionDenied', 'PostCompact', 'Nonsense']

const HOSTILE: unknown[] = [
  null,
  undefined,
  0,
  '',
  [],
  { command: null },
  { command: 123 },
  { command: ' ' },
  { command: 'x'.repeat(100000) },
  { command: '"; rm -rf /; echo "' },
  { command: '\u0000\u001b[31m' },
  { command: '\uD800' },
  { nested: { deep: { deeper: [1, 2, { x: null }] } } },
  { toString: null },
]

test('no combination of event and hostile input ever throws', () => {
  for (const event of EVENTS) {
    for (const input of HOSTILE) {
      for (const cwd of [tmp, '/nonexistent/nowhere', '', undefined]) {
        const payload = {
          hook_event_name: event, session_id: 's', cwd,
          tool_name: 'Bash', tool_input: input, tool_use_id: 't',
        } as HookPayload
        expect(() => handle(payload)).not.toThrow()
      }
    }
  }
})

test('anything returned is parseable JSON carrying only the documented shape', () => {
  for (const event of EVENTS) {
    for (const input of HOSTILE) {
      const out = handle({
        hook_event_name: event, session_id: 's', cwd: tmp,
        tool_name: 'Bash', tool_input: input, tool_use_id: 't',
      } as HookPayload)
      if (out === null) continue
      const parsed = JSON.parse(out)
      expect(Object.keys(parsed)).toEqual(['hookSpecificOutput'])
      expect(parsed.hookSpecificOutput.hookEventName).toBe('PreToolUse')
      expect(typeof parsed.hookSpecificOutput.additionalContext).toBe('string')
    }
  }
})

test('an unwritable data directory degrades to silence rather than an error', () => {
  const locked = join(tmp, 'locked')
  mkdirSync(locked, { recursive: true })
  chmodSync(locked, 0o500)
  process.env.CASSANDRA_HOME = locked
  expect(() => handle({
    hook_event_name: 'PostToolUseFailure', session_id: 's', cwd: tmp,
    tool_name: 'Bash', tool_input: { command: 'bun test' },
    tool_use_id: 't', error_message: 'boom',
  })).not.toThrow()
  chmodSync(locked, 0o700)
})

test('the entrypoint exits 0 on garbage stdin and prints nothing', async () => {
  const entry = join(import.meta.dir, '..', 'src', 'hook.ts')
  const proc = Bun.spawn(['bun', 'run', entry], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
  proc.stdin.write('this is not json at all')
  await proc.stdin.end()
  expect(await proc.exited).toBe(0)
  expect(await new Response(proc.stdout).text()).toBe('')
})

test('the entrypoint exits 0 on empty stdin', async () => {
  const entry = join(import.meta.dir, '..', 'src', 'hook.ts')
  const proc = Bun.spawn(['bun', 'run', entry], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
  await proc.stdin.end()
  expect(await proc.exited).toBe(0)
})
```

- [ ] **Step 2: Run the test**

Run: `bun test test/robustness.test.ts`
Expected: PASS, 5 tests. If any hostile input throws, fix `src/hook.ts` rather than weakening the test. The point of this file is that it cannot be satisfied by narrowing its inputs.

- [ ] **Step 3: Commit**

```bash
git add test/robustness.test.ts
git commit -m "test: assert the hook never throws, never exits non-zero and never emits stray stdout"
```

---

### Task 10: Build script and plugin wiring

**Files:**

- Create: `scripts/build-hook.ts`, `hooks/hooks.json`, `hooks/scripts/session-start.sh`

**Interfaces:**

- Consumes: `src/hook.ts`.
- Produces: `bin/cassandra-hook`, an executable reading a hook payload on stdin.

- [ ] **Step 1: Write the build script**

`scripts/build-hook.ts`:

```ts
/**
 * Compiles the hook entrypoint into a standalone binary.
 *
 * `bun run` on a TypeScript file pays transpilation on every invocation, which on
 * the PreToolUse path means every tool call for the life of a session. A compiled
 * binary skips that. The artefact is around 90MB, so it is gitignored and built on
 * first use rather than committed.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')
mkdirSync(join(root, 'bin'), { recursive: true })

const result = await Bun.build({
  entrypoints: [join(root, 'src', 'hook.ts')],
  outdir: join(root, 'bin'),
  target: 'bun',
  compile: { outfile: join(root, 'bin', 'cassandra-hook') },
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}
console.error('built bin/cassandra-hook')
```

- [ ] **Step 2: Build and verify the binary answers**

```bash
bun run build:hook
echo '{"hook_event_name":"PreToolUse","session_id":"s","cwd":"'"$PWD"'","tool_name":"Bash","tool_input":{"command":"bun test"},"tool_use_id":"t"}' | ./bin/cassandra-hook
echo "exit=$?"
```

Expected: no stdout, because nothing is recorded yet. `exit=0`.

- [ ] **Step 3: Measure the hot path**

```bash
PAYLOAD='{"hook_event_name":"PreToolUse","session_id":"s","cwd":"'"$PWD"'","tool_name":"Bash","tool_input":{"command":"bun test"},"tool_use_id":"t"}'
time (for i in $(seq 1 50); do echo "$PAYLOAD" | ./bin/cassandra-hook >/dev/null; done)
```

Expected: under 1.0s total for 50 invocations, so under 20ms each. Record the figure in the commit message. If a miss exceeds 20ms, stop and report: the whole design rests on a cheap miss.

- [ ] **Step 4: Write the wiring**

`hooks/hooks.json`:

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [ { "type": "command", "command": "sh \"$CLAUDE_PLUGIN_ROOT/hooks/scripts/session-start.sh\"", "timeout": 5 } ] }
    ],
    "PreToolUse": [
      { "matcher": "Bash|mcp__.*", "hooks": [ { "type": "command", "command": "\"$CLAUDE_PLUGIN_ROOT/bin/cassandra-hook\"", "timeout": 2 } ] }
    ],
    "PostToolUse": [
      { "matcher": "Bash|mcp__.*", "hooks": [ { "type": "command", "command": "\"$CLAUDE_PLUGIN_ROOT/bin/cassandra-hook\"", "timeout": 2 } ] }
    ],
    "PostToolUseFailure": [
      { "matcher": "Bash|mcp__.*", "hooks": [ { "type": "command", "command": "\"$CLAUDE_PLUGIN_ROOT/bin/cassandra-hook\"", "timeout": 2 } ] }
    ],
    "PermissionDenied": [
      { "matcher": "Bash|mcp__.*", "hooks": [ { "type": "command", "command": "\"$CLAUDE_PLUGIN_ROOT/bin/cassandra-hook\"", "timeout": 2 } ] }
    ],
    "PostCompact": [
      { "hooks": [ { "type": "command", "command": "\"$CLAUDE_PLUGIN_ROOT/bin/cassandra-hook\"", "timeout": 2 } ] }
    ]
  }
}
```

`hooks/scripts/session-start.sh`:

```sh
#!/bin/sh
# Build ladder. Cassandra's hot path is a compiled binary that is gitignored
# because it is around 90MB, so the first session after install builds it.
#
# Three rungs: use the binary, build it in the background, or report inert. Every
# one of them ends in exit 0, because a plugin that cannot start must still not
# stop a session from starting.
set -u

root=${CLAUDE_PLUGIN_ROOT:-}
[ -n "$root" ] || exit 0

# Drain stdin so the caller never blocks on a full pipe.
cat >/dev/null 2>&1

[ -x "$root/bin/cassandra-hook" ] && exit 0

if ! command -v bun >/dev/null 2>&1; then
  printf '%s\n' '{"systemMessage":"cassandra is inert: bun was not found on PATH, so the hook binary cannot be built. Install bun and restart the session."}'
  exit 0
fi

# Background, so a first session never waits on a compile. Until it lands every
# hook invocation finds no binary and Claude Code skips it.
( cd "$root" && bun run scripts/build-hook.ts >/dev/null 2>&1 ) &

printf '%s\n' '{"systemMessage":"cassandra is building its hook binary in the background. It will be active from the next session."}'
exit 0
```

- [ ] **Step 5: Verify the script is safe when unconfigured**

```bash
chmod +x hooks/scripts/session-start.sh
echo '{}' | sh hooks/scripts/session-start.sh; echo "unset root exit=$?"
echo '{}' | CLAUDE_PLUGIN_ROOT="$PWD" sh hooks/scripts/session-start.sh; echo "with binary exit=$?"
```

Expected: both `exit=0`. The first prints nothing. The second prints nothing, because `bin/cassandra-hook` already exists from Step 2.

- [ ] **Step 6: Commit**

```bash
git add scripts/build-hook.ts hooks/hooks.json hooks/scripts/session-start.sh
git commit -m "feat: compile the hook binary and wire the plugin's six events

Hot path measured at under 20ms per miss. The binary is gitignored and built on
first session, so a machine without bun degrades to an inert plugin rather than a
broken one."
```

---

### Task 11: CLI (CHECKPOINT FP-3)

**Files:**

- Create: `src/cli.ts`, `src/commands/list.ts`, `src/commands/why.ts`, `src/commands/forget.ts`, `src/commands/stats.ts`, `src/commands/export.ts`, `commands/cassandra.md`, `test/cli.test.ts`

**Interfaces:**

- Consumes: `listRecords`, `readRecord`, `deleteRecord` from `src/record.ts`; `readStats`, `Boundary` from `src/stats.ts`; `pathsFor`, `Paths` from `src/paths.ts`.
- Produces: `run(argv: string[]): number` in `src/cli.ts`, returning a process exit code.

- [ ] **Step 1: Write the failing test**

`test/cli.test.ts`:

```ts
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { run } from '../src/cli'
import { pathsFor } from '../src/paths'
import { upsertRecord } from '../src/record'
import { appendStat } from '../src/stats'

let tmp: string
let cwd: string
let out: string[]
let originalLog: typeof console.log

const seed = {
  tool: 'Bash', display: 'bun test', kind: 'failure' as const,
  stateStamp: 'a3f1c8', stateKind: 'git' as const,
  sessionId: 's1', compactions: 0, errorExcerpt: '3 tests failing',
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cass-cli-'))
  process.env.CASSANDRA_HOME = join(tmp, 'home')
  cwd = join(tmp, 'proj')
  mkdirSync(cwd, { recursive: true })
  out = []
  originalLog = console.log
  console.log = (...args: unknown[]) => { out.push(args.join(' ')) }
})

afterEach(() => {
  console.log = originalLog
  delete process.env.CASSANDRA_HOME
  rmSync(tmp, { recursive: true, force: true })
})

test('list on an empty index says so and exits 0', () => {
  expect(run(['list', '--cwd', cwd])).toBe(0)
  expect(out.join('\n')).toContain('No remembered failures')
})

test('list shows a stored record', () => {
  upsertRecord(pathsFor(cwd), 'aa11bb22cc33dd44', seed)
  expect(run(['list', '--cwd', cwd])).toBe(0)
  expect(out.join('\n')).toContain('bun test')
  expect(out.join('\n')).toContain('aa11bb22')
})

test('why prints the full record', () => {
  upsertRecord(pathsFor(cwd), 'aa11bb22cc33dd44', seed)
  expect(run(['why', 'aa11bb22cc33dd44', '--cwd', cwd])).toBe(0)
  expect(out.join('\n')).toContain('3 tests failing')
})

test('why on an unknown hash exits 1', () => {
  expect(run(['why', 'nope', '--cwd', cwd])).toBe(1)
})

test('forget removes one record', () => {
  upsertRecord(pathsFor(cwd), 'aa11bb22cc33dd44', seed)
  expect(run(['forget', 'aa11bb22cc33dd44', '--cwd', cwd])).toBe(0)
  out.length = 0
  expect(run(['list', '--cwd', cwd])).toBe(0)
  expect(out.join('\n')).toContain('No remembered failures')
})

test('forget --all empties the index', () => {
  upsertRecord(pathsFor(cwd), 'aa11bb22cc33dd44', seed)
  upsertRecord(pathsFor(cwd), 'bb11bb22cc33dd44', seed)
  expect(run(['forget', '--all', '--cwd', cwd])).toBe(0)
  expect(out.join('\n')).toContain('Forgot 2')
})

test('stats reports the false-positive rate and boundary shares', () => {
  const p = pathsFor(cwd)
  appendStat(p, { kind: 'warned', hash: 'a', boundary: 'compaction' })
  appendStat(p, { kind: 'warned', hash: 'b', boundary: 'same_context' })
  appendStat(p, { kind: 'confirmed', hash: 'a' })
  appendStat(p, { kind: 'false_positive', hash: 'b' })
  expect(run(['stats', '--cwd', cwd])).toBe(0)
  const text = out.join('\n')
  expect(text).toContain('2 warnings')
  expect(text).toContain('50.0%')
  expect(text).toContain('compaction')
})

test('stats on an empty log exits 0 and says nothing has been measured', () => {
  expect(run(['stats', '--cwd', cwd])).toBe(0)
  expect(out.join('\n')).toContain('No warnings recorded')
})

test('export emits parseable JSON', () => {
  upsertRecord(pathsFor(cwd), 'aa11bb22cc33dd44', seed)
  expect(run(['export', '--cwd', cwd])).toBe(0)
  const parsed = JSON.parse(out.join('\n'))
  expect(parsed.records).toHaveLength(1)
  expect(parsed.records[0].hash).toBe('aa11bb22cc33dd44')
})

test('no arguments prints usage and exits 1', () => {
  expect(run([])).toBe(1)
  expect(out.join('\n')).toContain('Usage')
})

test('an unknown subcommand prints usage and exits 1', () => {
  expect(run(['nonsense'])).toBe(1)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/cli.test.ts`
Expected: FAIL, cannot resolve `../src/cli`.

- [ ] **Step 3: Write the commands**

`src/commands/list.ts`:

```ts
import { listRecords } from '../record'
import type { Paths } from '../paths'

/** Print every remembered failure for this project, most recent first. */
export function list(paths: Paths): number {
  const all = listRecords(paths).sort((a, b) => b.record.lastSeen.localeCompare(a.record.lastSeen))
  if (all.length === 0) {
    console.log('No remembered failures for this project.')
    return 0
  }
  console.log(`${all.length} remembered failure${all.length === 1 ? '' : 's'}:\n`)
  for (const { hash, record } of all) {
    const kind = record.kind === 'denial' ? 'denied' : 'failed'
    console.log(`  ${hash.slice(0, 8)}  ${kind} ${record.count}x  ${record.lastSeen.slice(0, 10)}  ${record.display}`)
  }
  return 0
}
```

`src/commands/why.ts`:

```ts
import { readRecord } from '../record'
import type { Paths } from '../paths'

/** Print one record in full, including the error excerpt that produced it. */
export function why(paths: Paths, hash: string): number {
  const record = readRecord(paths, hash)
  if (!record) {
    console.log(`No record for ${hash}. Use the full 16-character hash from \`cassandra list\`.`)
    return 1
  }
  console.log(`${record.display}\n`)
  console.log(`  kind        ${record.kind}`)
  console.log(`  seen        ${record.count} time${record.count === 1 ? '' : 's'}`)
  console.log(`  first       ${record.firstSeen}`)
  console.log(`  last        ${record.lastSeen}`)
  console.log(`  probe       ${record.stateKind} (${record.stateStamp})`)
  console.log(`  session     ${record.sessionId || 'unknown'}`)
  console.log(`  reason      ${record.errorExcerpt || '(none captured)'}`)
  return 0
}
```

`src/commands/forget.ts`:

```ts
import { deleteRecord, listRecords } from '../record'
import type { Paths } from '../paths'

/** Drop one record, or the whole project index. */
export function forget(paths: Paths, target: string | null, all: boolean): number {
  if (all) {
    const records = listRecords(paths)
    for (const { hash } of records) deleteRecord(paths, hash)
    console.log(`Forgot ${records.length} record${records.length === 1 ? '' : 's'}.`)
    return 0
  }
  if (!target) {
    console.log('Pass a hash, or --all to clear the project index.')
    return 1
  }
  deleteRecord(paths, target)
  console.log(`Forgot ${target}.`)
  return 0
}
```

`src/commands/stats.ts`:

```ts
import { readStats, type Boundary } from '../stats'
import type { Paths } from '../paths'

const BOUNDARIES: Boundary[] = ['compaction', 'session', 'subagent', 'same_context']

/**
 * Report whether Cassandra is earning its place.
 *
 * Two numbers matter. A high false-positive rate means the freshness probe is
 * missing real changes. A high `same_context` share means most warnings tell the
 * model something already visible in its own transcript, which is the case for
 * removing the plugin rather than tuning it.
 */
export function stats(paths: Paths): number {
  const events = readStats(paths)
  const warned = events.filter((e) => e.kind === 'warned')
  if (warned.length === 0) {
    console.log('No warnings recorded yet for this project.')
    return 0
  }

  const falsePositives = events.filter((e) => e.kind === 'false_positive').length
  const confirmed = events.filter((e) => e.kind === 'confirmed').length
  const resolved = falsePositives + confirmed
  const fpRate = resolved === 0 ? 0 : (falsePositives / resolved) * 100

  console.log(`${warned.length} warnings issued\n`)
  console.log(`  confirmed        ${confirmed}  (failed again, warning was right)`)
  console.log(`  false positives  ${falsePositives}  (succeeded, probe missed a change)`)
  console.log(`  false-positive rate ${fpRate.toFixed(1)}%\n`)
  console.log('  by boundary:')
  for (const b of BOUNDARIES) {
    const n = warned.filter((e) => e.boundary === b).length
    const share = ((n / warned.length) * 100).toFixed(1)
    const note = b === 'same_context' ? '  <- redundant, the model could already see these' : ''
    console.log(`    ${b.padEnd(13)} ${String(n).padStart(4)}  ${share.padStart(5)}%${note}`)
  }
  return 0
}
```

`src/commands/export.ts`:

```ts
import { listRecords } from '../record'
import { readStats } from '../stats'
import type { Paths } from '../paths'

/** Emit the whole project index as JSON, so you can do your own arithmetic on it. */
export function exportAll(paths: Paths): number {
  console.log(JSON.stringify({
    exportedAt: new Date().toISOString(),
    records: listRecords(paths).map(({ hash, record }) => ({ hash, ...record })),
    stats: readStats(paths),
  }, null, 2))
  return 0
}
```

`src/cli.ts`:

```ts
import { pathsFor } from './paths'
import { list } from './commands/list'
import { why } from './commands/why'
import { forget } from './commands/forget'
import { stats } from './commands/stats'
import { exportAll } from './commands/export'

const USAGE = `Usage: cassandra <command> [options]

  list              remembered failures for this project
  why <hash>        one record in full
  forget <hash>     drop one record
  forget --all      drop every record for this project
  stats             whether the warnings are earning their place
  export            the whole index as JSON

Options:
  --cwd <path>      project to act on (default: current directory)`

/** Parse argv and dispatch. Returns the exit code rather than calling exit, so it is testable. */
export function run(argv: string[]): number {
  const cwdFlag = argv.indexOf('--cwd')
  const cwd = cwdFlag !== -1 ? (argv[cwdFlag + 1] ?? process.cwd()) : process.cwd()
  const args = argv.filter((_, i) => i !== cwdFlag && i !== cwdFlag + 1)
  const [command, ...rest] = args
  const paths = pathsFor(cwd)

  switch (command) {
    case 'list': return list(paths)
    case 'why': return why(paths, rest[0] ?? '')
    case 'forget': return forget(paths, rest.includes('--all') ? null : rest[0] ?? null, rest.includes('--all'))
    case 'stats': return stats(paths)
    case 'export': return exportAll(paths)
    default:
      console.log(USAGE)
      return 1
  }
}

if (import.meta.main) process.exit(run(process.argv.slice(2)))
```

`commands/cassandra.md`:

```markdown
---
description: Show the tool calls Cassandra remembers failing in this project
---

Run `bun "${CLAUDE_PLUGIN_ROOT}/src/cli.ts" list --cwd "$(pwd)"` and show the output.

If the user asked for detail on one entry, run `why <hash>` instead. If they asked
whether Cassandra is worth keeping, run `stats` and read the false-positive rate and
the `same_context` share out of the result.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/cli.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Run checkpoint FP-3**

Run: `bun run fp`
Expected: identical to FP-1 and FP-2, `18/18`, 0.0%.

- [ ] **Step 6: Run the full check**

Run: `bun run check`
Expected: lint, docs lint, typecheck, knip and coverage all pass. Coverage thresholds are 0.90 lines and 0.90 functions per file. If a file is under, add the missing test rather than lowering the floor.

- [ ] **Step 7: Commit**

```bash
git add src/cli.ts src/commands commands/cassandra.md test/cli.test.ts
git commit -m "feat: add the cassandra CLI and slash command

stats reports the false-positive rate and the share of warnings that crossed no
boundary at all, which is the number that decides whether this is worth keeping.
FP-3 checkpoint unchanged at 18/18."
```

---

### Task 12: Fixtures from real payloads

**Files:**

- Create: `scripts/make-fixtures.ts`, `test/fixtures.test.ts`
- Modify: `package.json`, the `test` and `test:coverage` scripts

**Interfaces:**

- Consumes: `handle` from `src/hook.ts`.
- Produces: `test/fixtures/payloads.json`, generated and gitignored.

- [ ] **Step 1: Write the fixture generator**

`scripts/make-fixtures.ts`:

```ts
/**
 * Harvests real hook payloads from local Claude Code transcripts.
 *
 * Every schema assumption in the test suite is otherwise mine rather than the
 * harness's. Reading actual sessions is what catches a field that moved or a shape
 * I guessed wrong. When no transcripts exist the generator writes a small synthetic
 * set instead, so the suite still runs on a clean machine.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const outDir = join(import.meta.dir, '..', 'test', 'fixtures')
mkdirSync(outDir, { recursive: true })

const SYNTHETIC = [
  { hook_event_name: 'PreToolUse', session_id: 's1', cwd: '/tmp/x', tool_name: 'Bash', tool_input: { command: 'bun test' }, tool_use_id: 'toolu_1' },
  { hook_event_name: 'PostToolUseFailure', session_id: 's1', cwd: '/tmp/x', tool_name: 'Bash', tool_input: { command: 'bun test' }, tool_use_id: 'toolu_1', error_message: 'exit code 1' },
  { hook_event_name: 'PermissionDenied', session_id: 's1', cwd: '/tmp/x', tool_name: 'Bash', tool_input: { command: 'curl example.com' }, tool_use_id: 'toolu_2', denial_reason: 'network egress' },
  { hook_event_name: 'PreToolUse', session_id: 's1', cwd: '/tmp/x', tool_name: 'mcp__knossos__scan_project', tool_input: { project_id: 'pp', depth: 3 }, tool_use_id: 'toolu_3' },
]

/** Pull tool_use blocks out of transcripts and reshape them into PreToolUse payloads. */
function harvest(): unknown[] {
  const base = join(homedir(), '.claude', 'projects')
  if (!existsSync(base)) return []
  const found: unknown[] = []
  try {
    for (const project of readdirSync(base).slice(0, 20)) {
      const dir = join(base, project)
      let files: string[]
      try {
        files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).slice(0, 3)
      } catch {
        continue
      }
      for (const file of files) {
        for (const line of readFileSync(join(dir, file), 'utf8').split('\n').slice(0, 4000)) {
          if (!line.includes('"tool_use"')) continue
          try {
            const entry = JSON.parse(line) as { message?: { content?: unknown[] } }
            for (const block of entry.message?.content ?? []) {
              const b = block as { type?: string; name?: string; input?: unknown; id?: string }
              if (b.type !== 'tool_use' || !b.name) continue
              if (b.name !== 'Bash' && !b.name.startsWith('mcp__')) continue
              found.push({
                hook_event_name: 'PreToolUse', session_id: 'harvested', cwd: '/tmp/x',
                tool_name: b.name, tool_input: b.input, tool_use_id: b.id ?? 'toolu_h',
              })
              if (found.length >= 400) return found
            }
          } catch {
            // A truncated line is not a fixture.
          }
        }
      }
    }
  } catch {
    // An unreadable transcript directory simply yields nothing.
  }
  return found
}

const harvested = harvest()
writeFileSync(join(outDir, 'payloads.json'), JSON.stringify([...SYNTHETIC, ...harvested], null, 2))
console.error(`fixtures: ${SYNTHETIC.length} synthetic + ${harvested.length} harvested`)
```

- [ ] **Step 2: Write the test**

`test/fixtures.test.ts`:

```ts
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { handle } from '../src/hook'
import type { HookPayload } from '../src/types'

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cass-fix-'))
  process.env.CASSANDRA_HOME = join(tmp, 'home')
})

afterEach(() => {
  delete process.env.CASSANDRA_HOME
  rmSync(tmp, { recursive: true, force: true })
})

function payloads(): HookPayload[] {
  return JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'payloads.json'), 'utf8'))
}

test('every real payload is handled without throwing', () => {
  for (const p of payloads()) {
    expect(() => handle({ ...p, cwd: tmp })).not.toThrow()
  }
})

test('every real payload either stays silent or emits the documented shape', () => {
  for (const p of payloads()) {
    const out = handle({ ...p, cwd: tmp })
    if (out === null) continue
    expect(() => JSON.parse(out)).not.toThrow()
    expect(JSON.parse(out).hookSpecificOutput.hookEventName).toBe('PreToolUse')
  }
})

test('the fixture set contains Bash calls, not only MCP ones', () => {
  const all = payloads()
  expect(all.length).toBeGreaterThanOrEqual(4)
  expect(all.filter((p) => p.tool_name === 'Bash').length).toBeGreaterThan(0)
})
```

- [ ] **Step 3: Generate and run**

```bash
bun run scripts/make-fixtures.ts
bun test test/fixtures.test.ts
```

Expected: PASS, 3 tests. The generator prints how many payloads it harvested.

- [ ] **Step 4: Wire the generator into the test scripts**

In `package.json`, change `"test": "bun test"` to `"test": "bun run scripts/make-fixtures.ts && bun test"`, and `"test:coverage": "bun test --coverage"` to `"test:coverage": "bun run scripts/make-fixtures.ts && bun test --coverage"`.

- [ ] **Step 5: Commit**

```bash
git add scripts/make-fixtures.ts test/fixtures.test.ts package.json
git commit -m "test: exercise the hook against payloads harvested from real transcripts"
```

---

### Task 13: Real-repository freshness measurement (CHECKPOINT FP-4)

The tracked risk requires more than a synthetic harness. This task measures the probe against the actual repositories on this machine. The `runReal` function was already written in Task 5; this task runs it, interprets it, and records the baseline.

**Files:**

- Modify: none, unless a finding requires a fix to `src/freshness.ts`

**Interfaces:**

- Consumes: `scripts/fp-harness.ts`.
- Produces: a recorded baseline. No new code surface.

- [ ] **Step 1: Run checkpoint FP-4**

Run: `bun run fp:real`
Expected: every repository reports `stable`, and every probe returns under 200ms.

- [ ] **Step 2: Interpret the result**

- **An `UNSTABLE` git repository** means `git status --porcelain` output is changing between two immediately consecutive reads, usually because a build or watcher is writing into the tree. That is a genuine finding: Cassandra will go silent in that repo, failing safe but useless. Report it, do not paper over it.
- **An `UNSTABLE` mtime directory** is the fallback's known weakness and the reason it is bounded. Report the directory and roughly how many files it holds.
- **A probe over 200ms** means `MAX_ENTRIES` in `src/freshness.ts` needs lowering. Note that this cost is paid only on a hash hit, never on a miss, so the budget is deliberately generous.

If any of the three occurs, stop and report before Task 14. Do not adjust the harness thresholds to make the run pass.

- [ ] **Step 3: Widen the sample**

```bash
CASSANDRA_FP_ROOTS="$(ls -d /root/*/ | tr '\n' ',' | sed 's/,$//')" bun run fp:real
```

Expected: a stability and timing figure for every project directory on the machine. This is the number that says whether the mtime fallback is viable in practice, because it is the first time it meets trees that were not built for it.

- [ ] **Step 4: Record the baseline**

Write the output of `bun run fp` and both `fp:real` runs into a new file, `docs/freshness-baseline.md`, with the date and the Bun version (`bun --version`). Every future change to `src/freshness.ts` is compared against this file.

- [ ] **Step 5: Commit**

```bash
git add docs/freshness-baseline.md
git commit -m "test: record the freshness probe baseline across real repositories

Synthetic mutations prove the probe reacts; real trees prove it is stable when
nothing changes and returns inside the hot path's budget."
```

---

### Task 14: README and documentation

**Files:**

- Create: `README.md`, `docs/hooks.md`
- Modify: `docs/superpowers/specs/2026-08-28-cassandra-design.md`

**Interfaces:**

- Consumes: nothing.
- Produces: nothing importable.

- [ ] **Step 1: Write the README**

`README.md`, following the Talanton shape. House style for prose: no em dashes, single author voice, the reader is "you". Sections in this order:

1. A centred `<div align="center">` block with the name, the tagline **"She spoke truly and no one checked."**, and badges for release, CI, license, top language, last commit, conventional commits, and pre-release status. Copy the badge markup from `/root/talanton/README.md`, changing the repository name to `cassandra`.
2. A blockquote giving the etymology: Cassandra was given true prophecy and the curse that no one would believe her. State plainly that the plugin only ever advises and cannot block a call.
3. **What it does.** Three sentences. It remembers Bash and MCP calls that failed, and when one is about to run again with nothing changed in the workspace, it says so.
4. **Why it exists.** The three boundaries: compaction drops the failure from context, a new session never saw it, a subagent was never told. Inside one intact context window the model can usually already see the failure, and Cassandra deliberately stays quiet there.
5. **Quick start.** `/plugin marketplace add AraneaDev/cassandra`, then `/plugin install cassandra@cassandra`. Note that the first session builds the hook binary in the background and the plugin is active from the second session, and that Bun is required.
6. **What it will not do.** It never blocks, denies or rewrites a call. It never reads your prose or your prompts. It only ever adds one line of context.
7. **Is it working?** Point at `cassandra stats`, and be explicit that a high `same_context` share is the signal to uninstall rather than tune.
8. **Commands.** The table from Task 11's usage text.
9. **How it decides.** The fingerprint (trim and whitespace collapse, nothing else) and the freshness probe (git status, or a bounded mtime walk, and that an unknown state never warns).

- [ ] **Step 2: Write the hook reference**

`docs/hooks.md`: the event table from the spec, plus this note, which is the fact the whole plugin rests on:

> Both web renderings of the official hooks reference state that `additionalContext`
> is not supported on `PreToolUse`. That is wrong. The Claude Code changelog adds it
> in 2.1.9 and fixes a delivery bug in 2.1.110. Verify hook output fields against the
> changelog, not the reference page.

- [ ] **Step 3: Update the spec's event table**

In `docs/superpowers/specs/2026-08-28-cassandra-design.md`, add a `PostCompact` row to the event wiring table: matcher `(none)`, path `bump session compaction counter`, frequency `on compaction`. The spec's measurement section already requires compaction attribution, so this closes the gap between its two halves.

- [ ] **Step 4: Verify the docs lint**

Run: `bun run lint:docs`
Expected: exit 0.

- [ ] **Step 5: Run everything one final time**

Run: `bun run check && bun run fp && bun run fp:real`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add README.md docs/
git commit -m "docs: add README, hook reference and the PostCompact wiring note"
```

---

## Self-Review

**Spec coverage.** Every spec section maps to a task: event wiring (8, 10), read path (8), write path (8), clearing without cost (8), freshness probe (5), fingerprinting (3), storage (2, 4), distribution (10), failure behaviour (9), testing (3 to 9, 12), measuring efficacy (6, 11), CLI surface (11), conventions (1). The spec's out-of-scope list is respected: no flag reordering and no Edit or Write fingerprints appear anywhere.

**One spec gap found and closed.** The spec required boundary attribution but wired no event that could detect compaction. Task 7 adds `src/session.ts`, Task 10 wires `PostCompact`, and Task 14 Step 3 amends the spec's event table to match.

**Type consistency.** `FailureRecord` gained `sessionId`, `stateKind` and `compactions` beyond the spec's example JSON, all three required by boundary attribution and by the kind check inside `unchanged`. The shape is defined once in Task 1 and used identically in Tasks 4, 8 and 11. `Paths`, `StateStamp`, `StateKind`, `Boundary` and `StatKind` each have exactly one definition. `upsertRecord` takes `Omit<FailureRecord, 'count' | 'firstSeen' | 'lastSeen'>` at its definition and at every call site. `runSynthetic` and `runReal` are both defined in Task 5 and only invoked in Task 13.

**Placeholder scan.** No TBD, no "add error handling", no "similar to Task N". Every code step carries the real code. Task 14 specifies prose structure rather than dictating the prose, which is deliberate: it is a writing task with a fixed outline, not a code task.

**Tracked risk.** The freshness probe carries four checkpoints (Tasks 5, 8, 11, 13), a dedicated measurement task against real repositories, a safety rule asserted by test in two places, a recorded baseline file, and an explicit stop condition at every checkpoint.
