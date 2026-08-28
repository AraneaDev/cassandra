import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

/** Where every project's index lives. Tests set CASSANDRA_HOME; the plugin gets CLAUDE_PLUGIN_DATA. */
export function dataRoot(): string {
  const explicit = process.env.CASSANDRA_HOME ?? process.env.CLAUDE_PLUGIN_DATA
  if (explicit) {
    rememberDataRoot(explicit)
    return explicit
  }
  return readRememberedDataRoot() ?? join(homeBase(), '.cassandra')
}

/**
 * The home directory, preferring `$HOME`.
 *
 * Node's `os.homedir()` consults `$HOME` first on POSIX, but Bun's resolves from the
 * passwd entry and ignores the environment, so a changed `HOME` is invisible to it.
 * Reading the variable first matches what a user expects from a CLI and keeps the two
 * runtimes agreeing.
 */
function homeBase(): string {
  const h = process.env.HOME
  return h && isAbsolute(h) ? h : homedir()
}

/** Where the pointer lives. Fixed, so a shell with no plugin environment can still find it. */
function pointerPath(): string {
  return join(homeBase(), '.cassandra', 'data-root')
}

/**
 * Record where the hooks are writing.
 *
 * Claude Code sets `CLAUDE_PLUGIN_DATA` for a plugin hook but not for a shell, so the CLI
 * would otherwise resolve a different directory from the one the hooks use and report an
 * empty index while the plugin was actively warning. The hook leaves this pointer behind
 * so `cassandra list`, `stats` and the rest read the same place. Best effort throughout:
 * losing the pointer costs discoverability, never correctness.
 */
function rememberDataRoot(root: string): void {
  try {
    const p = pointerPath()
    if (existsSync(p) && readFileSync(p, 'utf8').trim() === root) return
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, root)
  } catch {
    // A read-only home is not a reason to fail a tool call.
  }
}

/** Read the pointer a hook left behind, or null when there is none worth trusting. */
function readRememberedDataRoot(): string | null {
  try {
    const p = pointerPath()
    if (!existsSync(p)) return null
    const v = readFileSync(p, 'utf8').trim()
    return v && isAbsolute(v) && existsSync(v) ? v : null
  } catch {
    return null
  }
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
 * Marker written when the read path warns, so the outcome can be attributed without re-hashing.
 * Guards against path traversal through the shared sanitizer.
 */
export function pendingPath(paths: Paths, toolUseId: string): string {
  return join(paths.pending, safeSegment(toolUseId))
}
