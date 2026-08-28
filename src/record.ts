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
