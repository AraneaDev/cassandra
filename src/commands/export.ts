import { listRecords } from '../record'
import { readStats } from '../stats'
import type { Paths } from '../paths'

/** Emit the whole project index as JSON, so you can do your own arithmetic on it. */
export function exportAll(paths: Paths): number {
  console.log(JSON.stringify({
    exportedAt: new Date().toISOString(),
    records: listRecords(paths).map(({ hash, record }) => ({ hash, ...record })),
    stats: readStats(paths),
  }, null, 2))
  return 0
}
