import type { Io } from './io.ts'
import { join } from './path.ts'
import { dataRoot, safeSegment, type Paths } from './paths.ts'

/**
 * Compaction is the one boundary of the three that the PreToolUse payload cannot
 * reveal on its own, so a PostCompact hook counts them per session and records
 * store the count they were written at.
 *
 * The session id comes from the harness, so it goes through the same sanitizer as
 * every other derived path segment rather than a copy of it.
 */
function counterPath(paths: Paths, sessionId: string): string {
  return join(paths.root, 'sessions', safeSegment(sessionId))
}

/** How many compactions this session has been through. Unknown reads as zero. */
export async function compactionCount(io: Io, paths: Paths, sessionId: string): Promise<number> {
  if (!sessionId) return 0
  try {
    const text = await io.readText(counterPath(paths, sessionId))
    if (text === null) return 0
    const n = Number.parseInt(text.trim(), 10)
    return Number.isFinite(n) && n >= 0 ? n : 0
  } catch {
    return 0
  }
}

/** Record that this session has compacted once more. Never throws. */
export async function bumpCompactions(io: Io, paths: Paths, sessionId: string): Promise<void> {
  if (!sessionId) return
  try {
    await io.writeText(counterPath(paths, sessionId), String(await compactionCount(io, paths, sessionId) + 1))
  } catch {
    // Best effort by design.
  }
}

/** How long a mod session marker survives without being refreshed. */
const MARKER_TTL_MS = 24 * 60 * 60 * 1000

/**
 * Where the mod says "this session is mine".
 *
 * On a Claude Code build that loads the mod, the binary's hooks are still declared and
 * still run. The mod writes this marker, and the binary's first act on every event is to
 * look for it and stand down, so a call is never recorded twice. It lives under the data
 * root rather than a project, so the binary can check it before resolving anything else.
 * A project slug always ends in `-` and eight hex characters, so `sessions` cannot collide
 * with one.
 */
async function markerPath(io: Io, sessionId: string): Promise<string> {
  return join(await dataRoot(io), 'sessions', `${safeSegment(sessionId)}.mod`)
}

/** Claim this session for the mod. True when the marker is in place. Never throws. */
export async function markModSession(io: Io, sessionId: string): Promise<boolean> {
  if (!sessionId) return false
  try {
    await io.writeText(await markerPath(io, sessionId), io.now())
    return true
  } catch {
    return false
  }
}

/** Whether the mod has claimed this session. Unknown reads as no, so the binary keeps working. */
export async function isModSession(io: Io, sessionId: string): Promise<boolean> {
  if (!sessionId) return false
  try {
    return await io.exists(await markerPath(io, sessionId))
  } catch {
    return false
  }
}

/** Release the claim at session end. Never throws. */
export async function clearModSession(io: Io, sessionId: string): Promise<void> {
  if (!sessionId) return
  try {
    await io.remove(await markerPath(io, sessionId))
  } catch {
    // A marker left behind is pruned after a day.
  }
}

/**
 * Drop markers from sessions that ended without saying so. A live mod session rewrites
 * its marker well inside the TTL, so only dead ones age out. Never throws.
 */
export async function pruneModMarkers(io: Io): Promise<void> {
  try {
    const dir = join(await dataRoot(io), 'sessions')
    const listing = await io.list(dir)
    if (!listing.ok) return
    const cutoff = Date.parse(io.now()) - MARKER_TTL_MS
    for (const entry of listing.entries) {
      // `.tmp` files are staging leftovers from a write that died before its rename.
      const ours = entry.name.endsWith('.mod') || entry.name.endsWith('.tmp')
      if (entry.kind !== 'file' || !ours || entry.mtimeMs >= cutoff) continue
      try {
        await io.remove(join(dir, entry.name))
      } catch {
        // Retried at the next session start.
      }
    }
  } catch {
    // Cleanup is opportunistic.
  }
}
