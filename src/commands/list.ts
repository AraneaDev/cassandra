import { listRecords } from '../core/record.ts'
import type { Io } from '../core/io.ts'
import type { Paths } from '../core/paths.ts'
import type { CommandResult } from './run.ts'

/** Print every remembered failure for this project, most recent first. */
export async function list(io: Io, paths: Paths): Promise<CommandResult> {
  const lines: string[] = []
  const all = (await listRecords(io, paths)).sort((a, b) => b.record.lastSeen.localeCompare(a.record.lastSeen))
  if (all.length === 0) {
    lines.push('No remembered failures for this project.')
    return { code: 0, text: lines.join('\n') }
  }
  lines.push(`${all.length} remembered failure${all.length === 1 ? '' : 's'}:\n`)
  for (const { hash, record } of all) {
    const kind = record.kind === 'denial' ? 'denied' : 'failed'
    lines.push(`  ${hash.slice(0, 8)}  ${kind} ${record.count}x  ${record.lastSeen.slice(0, 10)}  ${record.display}`)
  }
  return { code: 0, text: lines.join('\n') }
}
