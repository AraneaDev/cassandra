import { deleteRecord, listRecords } from '../core/record.ts'
import type { Io } from '../core/io.ts'
import { type Paths } from '../core/paths.ts'
import { explainResolution, resolveHash } from '../core/resolve.ts'

/** Drop one record, or the whole project index. */
export async function forget(io: Io, paths: Paths, target: string | null, all: boolean): Promise<number> {
  if (all) {
    const records = await listRecords(io, paths)
    for (const { hash } of records) await deleteRecord(io, paths, hash)
    console.log(`Forgot ${records.length} record${records.length === 1 ? '' : 's'}.`)
    return 0
  }
  if (!target) {
    console.log('Pass a hash, or --all to clear the project index.')
    return 1
  }
  // argv is untrusted, and this call deletes a file. A prefix is resolved against the
  // index first, so nothing but a real fingerprint reaches the path builder.
  const r = await resolveHash(io, paths, target)
  if (!r.ok) {
    console.log(explainResolution(target, r))
    return 1
  }
  await deleteRecord(io, paths, r.hash)
  console.log(`Forgot ${r.hash}.`)
  return 0
}
