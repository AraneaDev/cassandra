import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Paths } from './paths'

/**
 * Compaction is the one boundary of the three that the PreToolUse payload cannot
 * reveal on its own, so a PostCompact hook counts them per session and records
 * store the count they were written at.
 */
function counterPath(paths: Paths, sessionId: string): string {
  const cleaned = sessionId.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 120)
  const safe = (cleaned === '' || cleaned === '.' || cleaned === '..') ? 'unknown' : cleaned
  return join(paths.root, 'sessions', safe)
}

/** How many compactions this session has been through. Unknown reads as zero. */
export function compactionCount(paths: Paths, sessionId: string): number {
  if (!sessionId) return 0
  try {
    const p = counterPath(paths, sessionId)
    if (!existsSync(p)) return 0
    const n = Number.parseInt(readFileSync(p, 'utf8').trim(), 10)
    return Number.isFinite(n) && n >= 0 ? n : 0
  } catch {
    return 0
  }
}

/** Record that this session has compacted once more. Never throws. */
export function bumpCompactions(paths: Paths, sessionId: string): void {
  if (!sessionId) return
  try {
    const p = counterPath(paths, sessionId)
    mkdirSync(join(paths.root, 'sessions'), { recursive: true })
    writeFileSync(p, String(compactionCount(paths, sessionId) + 1))
  } catch {
    // Best effort by design.
  }
}
