import { listRecords } from '../core/record.ts'
import { readStats } from '../core/stats.ts'
import type { Io } from '../core/io.ts'
import type { Paths } from '../core/paths.ts'
import type { CommandResult } from './run.ts'

/** Emit the whole project index as JSON, so you can do your own arithmetic on it. */
export async function exportAll(io: Io, paths: Paths): Promise<CommandResult> {
  const text = JSON.stringify({
    exportedAt: new Date().toISOString(),
    records: (await listRecords(io, paths)).map(({ hash, record }) => ({ hash, ...record })),
    stats: await readStats(io, paths),
  }, null, 2)
  return { code: 0, text }
}
