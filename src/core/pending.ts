import type { Io } from './io.ts'
import { pendingPath, type Paths } from './paths.ts'
import { join } from './path.ts'

/** How long a marker can sit unresolved before it is assumed to belong to a dead session. */
const PENDING_TTL_MS = 24 * 60 * 60 * 1000

/**
 * Drop markers whose outcome never arrived.
 *
 * A marker is written when a warning fires and removed when the call resolves. A
 * session killed in between leaves one behind forever, and nothing else ever
 * enumerates this directory, so it only grows. This runs on the warn path, which is
 * rare by construction, over a directory that is normally near-empty. Everything about
 * it is best effort: it cannot throw, and a marker it fails to remove is retried next
 * time rather than reported.
 */
async function prunePending(io: Io, dir: string): Promise<void> {
  try {
    const listing = await io.list(dir)
    if (!listing.ok) return
    const cutoff = Date.parse(io.now()) - PENDING_TTL_MS
    for (const entry of listing.entries) {
      if (entry.kind !== 'file' || entry.mtimeMs >= cutoff) continue
      try {
        await io.remove(join(dir, entry.name))
      } catch {
        // A marker that vanished under us needs no cleaning.
      }
    }
  } catch {
    // Cleanup is opportunistic and must never cost a call.
  }
}

/** Write the marker that lets PostToolUse attribute an outcome without re-hashing. */
export async function markPending(io: Io, paths: Paths, toolUseId: string, hash: string): Promise<void> {
  try {
    await prunePending(io, paths.pending)
    await io.writeText(pendingPath(paths, toolUseId), hash)
  } catch {
    // A missing marker only costs a metric.
  }
}

/** Read and remove the marker for a tool call, if this call was warned about. */
export async function takePending(io: Io, paths: Paths, toolUseId: string): Promise<string | null> {
  try {
    const p = pendingPath(paths, toolUseId)
    const text = await io.readText(p)
    if (text === null) return null
    await io.remove(p)
    const hash = text.trim()
    return hash || null
  } catch {
    return null
  }
}
