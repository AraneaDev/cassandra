import { deleteRecord, listRecords } from '../record'
import type { Paths } from '../paths'

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
  deleteRecord(paths, target)
  console.log(`Forgot ${target}.`)
  return 0
}
