import { deleteRecord, listRecords } from '../core/record.ts'
import { removeAllFixes } from '../core/fixes.ts'
import type { Io } from '../core/io.ts'
import { type Paths } from '../core/paths.ts'
import { join } from '../core/path.ts'
import { explainResolution, resolveHash } from '../core/resolve.ts'
import type { CommandResult } from './run.ts'

/** Drop one record, or the whole project index. */
export async function forget(io: Io, paths: Paths, target: string | null, all: boolean): Promise<CommandResult> {
  const lines: string[] = []
  if (all) {
    const records = await listRecords(io, paths)
    for (const { hash } of records) await deleteRecord(io, paths, hash)
    const fixes = await removeAllFixes(io, paths)
    const n = records.length
    const done = fixes.removed > 0
      ? `Forgot ${n} record${n === 1 ? '' : 's'} and ${fixes.removed} fix note${fixes.removed === 1 ? '' : 's'}.`
      : `Forgot ${n} record${n === 1 ? '' : 's'}.`
    if (fixes.failed > 0) {
      lines.push(`${done} Could not remove some fix notes; check the permissions under ${join(paths.root, 'fixes')}.`)
      return { code: 1, text: lines.join('\n') }
    }
    lines.push(done)
    return { code: 0, text: lines.join('\n') }
  }
  if (!target) {
    lines.push('Pass a hash, or --all to clear the project index.')
    return { code: 1, text: lines.join('\n') }
  }
  // argv is untrusted, and this call deletes a file. A prefix is resolved against the
  // index first, so nothing but a real fingerprint reaches the path builder.
  const r = await resolveHash(io, paths, target)
  if (!r.ok) {
    lines.push(explainResolution(target, r))
    return { code: 1, text: lines.join('\n') }
  }
  await deleteRecord(io, paths, r.hash)
  lines.push(`Forgot ${r.hash}.`)
  return { code: 0, text: lines.join('\n') }
}
