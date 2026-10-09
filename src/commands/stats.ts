import { readStats, type Boundary } from '../core/stats.ts'
import { readRecord } from '../core/record.ts'
import type { Io } from '../core/io.ts'
import type { Paths } from '../core/paths.ts'

const BOUNDARIES: Boundary[] = ['compaction', 'session', 'subagent', 'same_context']
import type { CommandResult } from './run.ts'

/**
 * Report whether Cassandra is earning its place.
 *
 * Two numbers matter. A high false-positive rate means the freshness probe is
 * missing real changes. A high `same_context` share means most warnings tell the
 * model something already visible in its own transcript, which is the case for
 * removing the plugin rather than tuning it.
 */
export async function stats(io: Io, paths: Paths): Promise<CommandResult> {
  const lines: string[] = []
  const events = await readStats(io, paths)
  const warned = events.filter((e) => e.kind === 'warned')
  const briefed = events.filter((e) => e.kind === 'briefed')
  const resolves = events.filter((e) => e.kind === 'resolved' && e.hash)
  const fixed = events.filter((e) => e.kind === 'fixed')
  if (warned.length === 0 && briefed.length === 0 && resolves.length === 0 && fixed.length === 0) {
    lines.push('No warnings recorded yet for this project.')
    return { code: 0, text: lines.join('\n') }
  }

  if (warned.length > 0) {
    const falsePositives = events.filter((e) => e.kind === 'false_positive').length
    const confirmed = events.filter((e) => e.kind === 'confirmed').length
    const resolved = falsePositives + confirmed
    const fpRate = resolved === 0 ? 0 : (falsePositives / resolved) * 100

    lines.push(`${warned.length} warnings issued\n`)
    lines.push(`  confirmed        ${confirmed}  (failed again, warning was right)`)
    lines.push(`  false positives  ${falsePositives}  (succeeded, probe missed a change)`)
    lines.push(`  false-positive rate ${fpRate.toFixed(1)}%\n`)
    lines.push('  by boundary:')
    for (const b of BOUNDARIES) {
      const n = warned.filter((e) => e.boundary === b).length
      const share = ((n / warned.length) * 100).toFixed(1)
      const note = b === 'same_context'
        ? '  <- redundant, the model could already see these; a high share here is the case for uninstalling, not tuning'
        : ''
      lines.push(`    ${b.padEnd(13)} ${String(n).padStart(4)}  ${share.padStart(5)}%${note}`)
    }
  }

  if (briefed.length > 0) {
    // A call counts as repeated when a warning at a subagent or compaction boundary comes
    // strictly after the earliest briefing that named it: the note was not heeded.
    const firstBriefed = new Map<string, string>()
    for (const e of briefed) {
      for (const h of e.hashes ?? []) {
        const seen = firstBriefed.get(h)
        if (seen === undefined || e.t < seen) firstBriefed.set(h, e.t)
      }
    }
    const repeated = new Set(events
      .filter((e) => {
        if (e.kind !== 'warned' || !e.hash) return false
        if (e.boundary !== 'subagent' && e.boundary !== 'compaction') return false
        const first = firstBriefed.get(e.hash)
        return first !== undefined && e.t > first
      })
      .map((e) => e.hash))
    // Set apart from the warnings above it; alone, the report starts on its first line.
    lines.push(`${warned.length > 0 ? '\n' : ''}${briefed.length} ${briefed.length === 1 ? 'briefing' : 'briefings'} sent\n`)
    for (const b of ['subagent', 'compaction'] as const) {
      lines.push(`    ${b.padEnd(13)} ${String(briefed.filter((e) => e.boundary === b).length).padStart(4)}`)
    }
    lines.push(`  repeated after briefing  ${repeated.size} of ${firstBriefed.size}  (briefed, then retried across a boundary anyway)`)
  }

  if (resolves.length > 0) {
    // A resolve the agent got wrong: the record was created again after it was forgotten.
    let failedAgain = 0
    for (const e of resolves) {
      const record = await readRecord(io, paths, e.hash!)
      if (record && record.firstSeen > e.t) failedAgain += 1
    }
    lines.push(`${warned.length > 0 || briefed.length > 0 ? '\n' : ''}agent resolves\n`)
    lines.push(`  resolved by an agent  ${resolves.length}, failed again ${failedAgain}  (a high second number means resolve is silencing warnings, not reporting fixes)`)
  }

  if (fixed.length > 0) {
    const offered = warned.filter((e) => e.fixNote).length
    lines.push(`${warned.length > 0 || briefed.length > 0 || resolves.length > 0 ? '\n' : ''}fix notes\n`)
    lines.push(`  fixes remembered  ${fixed.length}, offered again ${offered}`)
  }
  return { code: 0, text: lines.join('\n') }
}
