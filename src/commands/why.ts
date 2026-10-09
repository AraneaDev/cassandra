import { readRecord } from '../core/record.ts'
import { fixSentence, readFix } from '../core/fixes.ts'
import type { Io } from '../core/io.ts'
import { type Paths } from '../core/paths.ts'
import { explainResolution, resolveHash } from '../core/resolve.ts'
import type { CommandResult } from './run.ts'

/**
 * Print one record in full, including the error excerpt that produced it.
 *
 * The hash arrives straight from argv, so a prefix is resolved against the index first
 * and only a full fingerprint ever reaches a path builder. A lookup is a read that can
 * end in a delete when the record does not parse, and argv is not a trusted source for
 * a path segment.
 */
export async function why(io: Io, paths: Paths, hash: string): Promise<CommandResult> {
  const lines: string[] = []
  const r = await resolveHash(io, paths, hash)
  if (!r.ok) {
    lines.push(explainResolution(hash, r))
    return { code: 1, text: lines.join('\n') }
  }
  const record = await readRecord(io, paths, r.hash)
  if (!record) {
    lines.push(`No record for ${r.hash}.`)
    return { code: 1, text: lines.join('\n') }
  }
  lines.push(`${record.display}\n`)
  lines.push(`  kind        ${record.kind}`)
  lines.push(`  seen        ${record.count} time${record.count === 1 ? '' : 's'}`)
  lines.push(`  first       ${record.firstSeen}`)
  lines.push(`  last        ${record.lastSeen}`)
  lines.push(`  probe       ${record.stateKind} (${record.stateStamp})`)
  lines.push(`  session     ${record.sessionId || 'unknown'}`)
  lines.push(`  reason      ${record.errorExcerpt || '(none captured)'}`)
  const fix = await readFix(io, paths, r.hash)
  if (fix) lines.push(`  fix         ${fixSentence(fix)}`)
  return { code: 0, text: lines.join('\n') }
}
