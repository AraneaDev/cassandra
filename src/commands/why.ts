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
