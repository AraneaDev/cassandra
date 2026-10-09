import { readRecord } from '../core/record.ts'
import type { Io } from '../core/io.ts'
import { type Paths } from '../core/paths.ts'
import { explainResolution, resolveHash } from './resolve.ts'

/**
 * Print one record in full, including the error excerpt that produced it.
 *
 * The hash arrives straight from argv, so a prefix is resolved against the index first
 * and only a full fingerprint ever reaches a path builder. A lookup is a read that can
 * end in a delete when the record does not parse, and argv is not a trusted source for
 * a path segment.
 */
export async function why(io: Io, paths: Paths, hash: string): Promise<number> {
  const r = await resolveHash(io, paths, hash)
  if (!r.ok) {
    console.log(explainResolution(hash, r))
    return 1
  }
  const record = await readRecord(io, paths, r.hash)
  if (!record) {
    console.log(`No record for ${r.hash}.`)
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
