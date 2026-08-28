import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { recordPath, type Paths } from './paths'
import type { FailureRecord } from './types'

/** Fields a caller supplies; count and timestamps are managed here. */
type RecordSeed = Omit<FailureRecord, 'count' | 'firstSeen' | 'lastSeen'>

const REQUIRED = ['tool', 'display', 'kind', 'count', 'stateStamp', 'stateKind', 'sessionId', 'compactions', 'firstSeen', 'lastSeen', 'errorExcerpt'] as const

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

/**
 * Create a record, or increment an existing one and refresh its mutable fields.
 *
 * The write goes to a temp file in the same directory and is moved into place with
 * `renameSync`, which POSIX guarantees atomic within a filesystem. `writeFileSync`
 * alone is not: Claude Code runs Bash calls in parallel, so a concurrent `readRecord`
 * could observe a half-written file, judge it corrupt and delete it, while this writer
 * finished into an inode that no longer had a name. The cost of that is not a drifted
 * count, it is a failure silently forgotten, which is the one thing the index exists
 * to prevent.
 *
 * The temp name carries the pid and a random suffix so two writers cannot collide on
 * it, and ends in `.tmp` so `listRecords`, which reads only `.json`, never sees one.
 */
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
  const staging = `${p}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  try {
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(staging, JSON.stringify(next))
    renameSync(staging, p)
  } catch {
    // An unwritable index must not break a session. The record is simply lost, and
    // any half-written staging file goes with it rather than accumulating.
    try {
      rmSync(staging, { force: true })
    } catch {
      // Nothing further to try.
    }
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
  let shards: string[]
  try {
    shards = readdirSync(paths.records)
  } catch {
    // Cannot read shards directory; return empty.
    return out
  }
  for (const shard of shards) {
    const dir = join(paths.records, shard)
    let files: string[]
    try {
      files = readdirSync(dir)
    } catch {
      // Shard is not readable or not a directory; skip it.
      continue
    }
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      const hash = file.slice(0, -5)
      const record = readRecord(paths, hash)
      if (record) out.push({ hash, record })
    }
  }
  return out
}
