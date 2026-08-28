import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import type { Paths } from './paths'

/** Which boundary a warning crossed. `same_context` means the model could already see the failure. */
export type Boundary = 'compaction' | 'session' | 'subagent' | 'same_context'

/**
 * What happened to a warning. `false_positive` means the warned call then succeeded,
 * so the freshness probe missed a real change. `confirmed` means it failed again.
 */
export type StatKind = 'warned' | 'false_positive' | 'confirmed'

/** One line of the efficacy log. */
export interface StatEvent {
  t: string
  kind: StatKind
  hash: string
  boundary?: Boundary
}

/** Append one event. Never throws: losing a metric must not cost a session. */
export function appendStat(paths: Paths, event: Omit<StatEvent, 't'>): void {
  try {
    mkdirSync(paths.root, { recursive: true })
    appendFileSync(paths.stats, `${JSON.stringify({ t: new Date().toISOString(), ...event })}\n`)
  } catch {
    // Best effort by design.
  }
}

/** Read the log, skipping any line that does not parse. */
export function readStats(paths: Paths): StatEvent[] {
  if (!existsSync(paths.stats)) return []
  try {
    return readFileSync(paths.stats, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        try {
          return JSON.parse(line) as StatEvent
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
  recorded: { sessionId: string; compactions: number },
  current: { sessionId: string; compactions: number; agentId?: string },
): Boundary {
  if (current.agentId) return 'subagent'
  if (current.sessionId !== recorded.sessionId) return 'session'
  if (current.compactions > recorded.compactions) return 'compaction'
  return 'same_context'
}
