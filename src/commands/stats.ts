import { readStats, type Boundary } from '../stats'
import type { Paths } from '../paths'

const BOUNDARIES: Boundary[] = ['compaction', 'session', 'subagent', 'same_context']

/**
 * Report whether Cassandra is earning its place.
 *
 * Two numbers matter. A high false-positive rate means the freshness probe is
 * missing real changes. A high `same_context` share means most warnings tell the
 * model something already visible in its own transcript, which is the case for
 * removing the plugin rather than tuning it.
 */
export function stats(paths: Paths): number {
  const events = readStats(paths)
  const warned = events.filter((e) => e.kind === 'warned')
  if (warned.length === 0) {
    console.log('No warnings recorded yet for this project.')
    return 0
  }

  const falsePositives = events.filter((e) => e.kind === 'false_positive').length
  const confirmed = events.filter((e) => e.kind === 'confirmed').length
  const resolved = falsePositives + confirmed
  const fpRate = resolved === 0 ? 0 : (falsePositives / resolved) * 100

  console.log(`${warned.length} warnings issued\n`)
  console.log(`  confirmed        ${confirmed}  (failed again, warning was right)`)
  console.log(`  false positives  ${falsePositives}  (succeeded, probe missed a change)`)
  console.log(`  false-positive rate ${fpRate.toFixed(1)}%\n`)
  console.log('  by boundary:')
  for (const b of BOUNDARIES) {
    const n = warned.filter((e) => e.boundary === b).length
    const share = ((n / warned.length) * 100).toFixed(1)
    const note = b === 'same_context'
      ? '  <- redundant, the model could already see these; a high share here is the case for uninstalling, not tuning'
      : ''
    console.log(`    ${b.padEnd(13)} ${String(n).padStart(4)}  ${share.padStart(5)}%${note}`)
  }
  return 0
}
