import { history, reason, scopeOf } from './describe.ts'
import { stateStamp, unchanged } from './freshness.ts'
import type { Io } from './io.ts'
import { pathsFor } from './paths.ts'
import { listRecords } from './record.ts'
import type { FailureRecord } from './types.ts'

/** How many records one note carries. */
const DIGEST_LIMIT = 5

/** Records still worth passing on, with the stamp kind they were judged against. */
export interface LiveRecords {
  records: Array<{ hash: string; record: FailureRecord }>
  kind: 'git' | 'mtime'
}

/**
 * The project's live dead ends: the records whose stored stamp still matches the
 * workspace now, by the same `unchanged` rule the per-call warning uses, newest first
 * and capped. Null when there are none. A project with no records at all returns before
 * any stamp is taken, so a boundary in a clean project costs one directory listing.
 */
export async function liveRecords(io: Io, cwd: string, limit = DIGEST_LIMIT): Promise<LiveRecords | null> {
  const paths = await pathsFor(io, cwd)
  const all = await listRecords(io, paths)
  if (all.length === 0) return null
  const stamp = await stateStamp(io, cwd)
  if (stamp.kind === 'none') return null
  const live = all
    .filter(({ record }) => unchanged(record.stateStamp, record.stateKind, stamp))
    .sort((a, b) => b.record.lastSeen.localeCompare(a.record.lastSeen))
    .slice(0, limit)
  return live.length === 0 ? null : { records: live, kind: stamp.kind }
}

/** The note: one header line, then one line per record in the warning's own words. */
export function digestText(records: LiveRecords['records'], kind: LiveRecords['kind']): string {
  const header = `cassandra: these calls failed earlier in this project, and nothing in ${scopeOf(kind)} has changed since:`
  const lines = records.map(({ record }) => `- ${history(record)}, most recently ${record.lastSeen}.${reason(record)}`)
  return [header, ...lines].join('\n')
}
