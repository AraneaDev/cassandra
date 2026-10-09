import type { Io } from './io.ts'
import type { Paths } from './paths.ts'

/** Which boundary a warning crossed. `same_context` means the model could already see the failure. */
export type Boundary = 'compaction' | 'session' | 'subagent' | 'same_context'

/**
 * What happened to a warning. `false_positive` means the warned call then succeeded,
 * so the freshness probe missed a real change. `confirmed` means it failed again.
 */
type StatKind = 'warned' | 'false_positive' | 'confirmed'

/** One line of the efficacy log. */
export interface StatEvent {
  t: string
  kind: StatKind
  hash: string
  boundary?: Boundary
}

/** Append one event. Never throws: losing a metric must not cost a session. */
export async function appendStat(io: Io, paths: Paths, event: Omit<StatEvent, 't'>): Promise<void> {
  try {
    await io.appendText(paths.stats, `${JSON.stringify({ ...event, t: io.now() })}\n`)
  } catch {
    // Best effort by design.
  }
}

/** Read the log, skipping any line that does not parse. */
export async function readStats(io: Io, paths: Paths): Promise<StatEvent[]> {
  try {
    const text = await io.readText(paths.stats)
    if (text === null) return []
    return text
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        try {
          const parsed = JSON.parse(line)
          // Validate shape: must be object, not array, with required fields
          if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') return null
          const { kind, hash } = parsed
          if (typeof hash !== 'string') return null
          if (typeof kind !== 'string' || !['warned', 'false_positive', 'confirmed'].includes(kind)) return null
          return parsed as StatEvent
        } catch {
          return null
        }
      })
      .filter((e): e is StatEvent => e !== null)
  } catch {
    return []
  }
}

/**
 * Which boundary this warning crossed.
 *
 * Ordered most to least specific. A `same_context` warning is one the model could
 * have answered from its own transcript, so a high share of those is the signal
 * that Cassandra is not earning its place.
 */
export function attributeBoundary(
  recorded: { sessionId: string; compactions: number; agentId?: string },
  current: { sessionId: string; compactions: number; agentId?: string },
): Boundary {
  if ((current.agentId ?? '') !== (recorded.agentId ?? '')) return 'subagent'
  if (current.sessionId !== recorded.sessionId) return 'session'
  if (current.compactions > recorded.compactions) return 'compaction'
  return 'same_context'
}
