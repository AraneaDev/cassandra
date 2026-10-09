import type { Io } from './io.ts'
import { basename, dirname, isAbsolute, join, normalize } from './path.ts'

/**
 * Where every project's index lives. Tests set CASSANDRA_HOME; the plugin gets
 * CLAUDE_PLUGIN_DATA. Rejects when there is neither an explicit root nor a home
 * directory to fall back on, which every caller treats as silence.
 */
export async function dataRoot(io: Io): Promise<string> {
  const explicit = (await io.env('CASSANDRA_HOME')) ?? (await io.env('CLAUDE_PLUGIN_DATA'))
  if (explicit) {
    await rememberDataRoot(io, explicit)
    return explicit
  }
  const home = await homeBase(io)
  return (await readRememberedDataRoot(io, home)) ?? join(home, '.cassandra')
}

/**
 * The home directory, preferring `$HOME`.
 *
 * Node's `os.homedir()` consults `$HOME` first on POSIX, but Bun's resolves from the
 * passwd entry and ignores the environment, so a changed `HOME` is invisible to it.
 * Reading the variable first matches what a user expects from a CLI and keeps the two
 * runtimes agreeing. The mod has no OS lookup at all, so `HOME` is all it has.
 */
async function homeBase(io: Io): Promise<string> {
  const h = await io.env('HOME')
  if (h && isAbsolute(h)) return h
  const os = await io.homeDir()
  if (!os) throw new Error('cassandra: no home directory to resolve a data root from')
  return os
}

/** Where the pointer lives. Fixed, so a shell with no plugin environment can still find it. */
function pointerPath(home: string): string {
  return join(home, '.cassandra', 'data-root')
}

/**
 * Record where the hooks are writing.
 *
 * Claude Code sets `CLAUDE_PLUGIN_DATA` for a plugin hook but not for a shell, so the CLI
 * would otherwise resolve a different directory from the one the hooks use and report an
 * empty index while the plugin was actively warning. The hook leaves this pointer behind
 * so `cassandra list`, `stats` and the rest read the same place, and so does a mod that
 * cannot see the variable. Best effort throughout: losing the pointer costs
 * discoverability, never correctness.
 */
async function rememberDataRoot(io: Io, root: string): Promise<void> {
  try {
    const p = pointerPath(await homeBase(io))
    if ((await io.readText(p))?.trim() === root) return
    await io.writeText(p, root)
  } catch {
    // A read-only home is not a reason to fail a tool call.
  }
}

/** Read the pointer a hook left behind, or null when there is none worth trusting. */
async function readRememberedDataRoot(io: Io, home: string): Promise<string | null> {
  try {
    const v = (await io.readText(pointerPath(home)))?.trim()
    return v && isAbsolute(v) && (await io.exists(v)) ? v : null
  } catch {
    return null
  }
}

/** Whether `dir` holds a real git marker: a `.git` file (worktree, submodule) or a directory with `HEAD`. */
export async function isRepoMarker(io: Io, dir: string): Promise<boolean> {
  const git = join(dir, '.git')
  if (!(await io.exists(git))) return false
  if (await io.exists(join(git, 'HEAD'))) return true
  // A worktree or submodule has a `.git` file pointing at the real git directory. An
  // empty directory (a sandbox placeholder) is not a repository, and git agrees.
  try {
    return ((await io.readText(git)) ?? '').startsWith('gitdir:')
  } catch {
    return false
  }
}

/**
 * Nearest ancestor containing `.git`, else the directory itself. Filesystem probes rather
 * than `git rev-parse`, because this runs on the hot path and a subprocess there would
 * cost more than the lookup it serves. `cwd` is absolute: both front ends hand over the
 * harness's own absolute working directory, and the CLI resolves its flag first.
 */
export async function findRepoRoot(io: Io, cwd: string): Promise<string> {
  const start = normalize(cwd)
  let dir = start
  for (;;) {
    if (await isRepoMarker(io, dir)) return dir
    const parent = dirname(dir)
    if (parent === dir) return start
    dir = parent
  }
}

/** Stable per-project directory name. Two checkouts of one repo never share an index. */
export async function projectSlug(io: Io, cwd: string): Promise<string> {
  const root = await findRepoRoot(io, cwd)
  const name = basename(root).replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 40) || 'project'
  const digest = (await io.sha256(root)).slice(0, 8)
  return `${name}-${digest}`
}

/** The locations Cassandra writes to for one project. */
export interface Paths {
  root: string
  records: string
  stats: string
}

/** Resolve every path Cassandra needs for the project containing `cwd`. */
export async function pathsFor(io: Io, cwd: string): Promise<Paths> {
  const root = join(await dataRoot(io), await projectSlug(io, cwd))
  return {
    root,
    records: join(root, 'records'),
    stats: join(root, 'stats.jsonl'),
  }
}

/** Longest path segment Cassandra will derive from untrusted input. */
const SEGMENT_MAX = 120

/**
 * The one sanitizer every derived path segment goes through.
 *
 * Hook payloads, CLI argv and record filenames all arrive from outside this process,
 * and every one of them ends up as a path segment. Anything outside `[a-zA-Z0-9._-]`
 * becomes a dash, which removes `/` and every separator with it; the result is capped
 * so a pathological input cannot exceed the OS name limit; and the three segments that
 * still escape a directory after that, `''`, `'.'` and `'..'`, collapse to a fixed
 * fallback token. The output can therefore only ever name a child of the directory it
 * is joined to.
 *
 * A non-string is treated as absent rather than coerced, so a hostile object cannot
 * reach the filesystem through `toString`.
 */
export function safeSegment(value: string, fallback = 'unknown'): string {
  const raw = typeof value === 'string' ? value : ''
  const cleaned = raw.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, SEGMENT_MAX)
  return (cleaned === '' || cleaned === '.' || cleaned === '..') ? fallback : cleaned
}

/** A real fingerprint: exactly 16 lowercase hex characters. Nothing else is one. */
export function isFingerprint(hash: string): boolean {
  return typeof hash === 'string' && /^[0-9a-f]{16}$/.test(hash)
}

/**
 * Sharded record location. The first two hex characters keep directories small.
 *
 * The hash is the one segment with a known shape, so it is held to it. Anything that
 * is not a real fingerprint resolves to a single fixed name inside the records
 * directory rather than being trusted: `readRecord` deletes what it cannot parse, so
 * a hash that escaped this directory would be an arbitrary-file delete reachable from
 * `cassandra why` and `cassandra forget`.
 */
export function recordPath(paths: Paths, hash: string): string {
  const cleaned = safeSegment(hash, 'invalid')
  const safe = isFingerprint(cleaned) ? cleaned : 'invalid'
  return join(paths.records, safe.slice(0, 2), `${safe}.json`)
}

/**
 * Where in-flight call markers live: one directory per user, not per project.
 *
 * PreToolUse writes the marker from the directory the call started in, but the outcome
 * payload reports the shell's directory after the command ran. A `cd ../other-repo`
 * inside the command would therefore look in a different project's directory and miss
 * it, so the lookup key can only be the `tool_use_id`, which both events share.
 */
export async function pendingDir(io: Io): Promise<string> {
  return join(await dataRoot(io), 'pending')
}

/**
 * Marker written when the read path warns, so the outcome can be attributed without re-hashing.
 * Guards against path traversal through the shared sanitizer.
 */
export function pendingPath(dir: string, toolUseId: string): string {
  return join(dir, safeSegment(toolUseId))
}
