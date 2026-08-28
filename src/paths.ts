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
