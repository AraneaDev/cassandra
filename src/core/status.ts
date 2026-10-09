import { liveRecords } from './digest.ts'
import type { Io } from './io.ts'

/** The status line for the person: how many live failures, or undefined to clear it. */
export async function statusText(io: Io, cwd: string): Promise<string | undefined> {
  const live = await liveRecords(io, cwd)
  if (!live) return undefined
  return `cassandra: ${live.total} live ${live.total === 1 ? 'failure' : 'failures'}`
}
