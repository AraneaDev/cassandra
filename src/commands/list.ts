import { listRecords } from '../record'
import type { Paths } from '../paths'

/** Print every remembered failure for this project, most recent first. */
export function list(paths: Paths): number {
  const all = listRecords(paths).sort((a, b) => b.record.lastSeen.localeCompare(a.record.lastSeen))
  if (all.length === 0) {
    console.log('No remembered failures for this project.')
    return 0
  }
  console.log(`${all.length} remembered failure${all.length === 1 ? '' : 's'}:\n`)
  for (const { hash, record } of all) {
    const kind = record.kind === 'denial' ? 'denied' : 'failed'
    console.log(`  ${hash.slice(0, 8)}  ${kind} ${record.count}x  ${record.lastSeen.slice(0, 10)}  ${record.display}`)
  }
  return 0
}
