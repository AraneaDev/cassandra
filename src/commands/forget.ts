import { deleteRecord, listRecords } from '../record'
import { type Paths } from '../paths'
import { explainResolution, resolveHash } from './resolve'

/** Drop one record, or the whole project index. */
export function forget(paths: Paths, target: string | null, all: boolean): number {
  if (all) {
    const records = listRecords(paths)
    for (const { hash } of records) deleteRecord(paths, hash)
    console.log(`Forgot ${records.length} record${records.length === 1 ? '' : 's'}.`)
    return 0
  }
  if (!target) {
    console.log('Pass a hash, or --all to clear the project index.')
    return 1
  }
  // argv is untrusted, and this call deletes a file. A prefix is resolved against the
  // index first, so nothing but a real fingerprint reaches the path builder.
  const r = resolveHash(paths, target)
  if (!r.ok) {
    console.log(explainResolution(target, r))
    return 1
  }
  deleteRecord(paths, r.hash)
  console.log(`Forgot ${r.hash}.`)
  return 0
}
