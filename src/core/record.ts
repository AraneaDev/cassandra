import type { Io } from './io.ts'
import { join } from './path.ts'
import { recordPath, type Paths } from './paths.ts'
import type { FailureRecord } from './types.ts'

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
export async function readRecord(io: Io, paths: Paths, hash: string): Promise<FailureRecord | null> {
  let text: string | null
  try {
    text = await io.readText(recordPath(paths, hash))
  } catch {
    await deleteRecord(io, paths, hash)
    return null
  }
  if (text === null) return null
  try {
    const parsed: unknown = JSON.parse(text)
    if (!looksValid(parsed)) {
      await deleteRecord(io, paths, hash)
      return null
    }
    return parsed
  } catch {
    await deleteRecord(io, paths, hash)
    return null
  }
}

/**
 * Create a record, or increment an existing one and refresh its mutable fields.
 * The write is atomic: see `Io.writeText`. An unwritable index must not break a
 * session, so a failed write loses the record and nothing else. A caller that already
 * read the record passes it as `read` (null for none) to spare a second read.
 */
export async function upsertRecord(io: Io, paths: Paths, hash: string, seed: RecordSeed, read?: FailureRecord | null): Promise<void> {
  const now = io.now()
  const existing = read === undefined ? await readRecord(io, paths, hash) : read
  const next: FailureRecord = {
    ...seed,
    count: (existing?.count ?? 0) + 1,
    firstSeen: existing?.firstSeen ?? now,
    lastSeen: now,
  }
  try {
    await io.writeText(recordPath(paths, hash), JSON.stringify(next))
  } catch {
    // Best effort by design.
  }
}

/** Remove a record. Missing is not an error. */
export async function deleteRecord(io: Io, paths: Paths, hash: string): Promise<void> {
  try {
    await io.remove(recordPath(paths, hash))
  } catch {
    // Best effort by design.
  }
}

/** Every stored record for this project, walked across the hash shards. */
export async function listRecords(io: Io, paths: Paths): Promise<Array<{ hash: string; record: FailureRecord }>> {
  const out: Array<{ hash: string; record: FailureRecord }> = []
  const shards = await io.list(paths.records)
  if (!shards.ok) return out
  for (const shard of shards.entries) {
    if (shard.kind !== 'dir') continue
    const files = await io.list(join(paths.records, shard.name))
    if (!files.ok) continue
    for (const file of files.entries) {
      if (!file.name.endsWith('.json')) continue
      const hash = file.name.slice(0, -5)
      const record = await readRecord(io, paths, hash)
      if (record) out.push({ hash, record })
    }
  }
  return out
}
