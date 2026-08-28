import { readRecord } from '../record'
import { isFingerprint, type Paths } from '../paths'

/**
 * Print one record in full, including the error excerpt that produced it.
 *
 * The hash arrives straight from argv, so it is refused unless it has the shape of a
 * real fingerprint. A lookup is a read that can end in a delete when the record does
 * not parse, and argv is not a trusted source for a path segment.
 */
export function why(paths: Paths, hash: string): number {
  if (!isFingerprint(hash)) {
    console.log(`Not a fingerprint: ${hash || '(empty)'}. Use the full 16-character hash from \`cassandra list\`.`)
    return 1
  }
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
