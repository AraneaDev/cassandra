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

/** What a marker remembers about a call: the record it was warned about, and where it started. */
export interface Pending {
  hash: string | null
  cwd: string | null
}

/**
 * Write the marker that lets the outcome hook attribute a call without re-hashing.
 *
 * The first line holds the warned hash (empty when there was no warning), the second the
 * directory the call started in. The outcome payload reports the shell's directory after
 * the command ran, so a `cd` inside the command would otherwise move the call to another
 * package. A marker from before this format holds only the hash, and still reads.
 */
export async function markPending(io: Io, paths: Paths, toolUseId: string, pending: Pending): Promise<void> {
  try {
    await prunePending(io, paths.pending)
    await io.writeText(pendingPath(paths, toolUseId), `${pending.hash ?? ''}\n${pending.cwd ?? ''}`)
  } catch {
    // A missing marker only costs a metric, or the package of one call.
  }
}

/** Read and remove the marker for a tool call. Both fields are null when there is none. */
export async function takePending(io: Io, paths: Paths, toolUseId: string): Promise<Pending> {
  try {
    const p = pendingPath(paths, toolUseId)
    const text = await io.readText(p)
    if (text === null) return { hash: null, cwd: null }
    await io.remove(p)
    const cut = text.indexOf('\n')
    const hash = (cut === -1 ? text : text.slice(0, cut)).trim()
    const cwd = cut === -1 ? '' : text.slice(cut + 1).replace(/\n$/, '')
    return { hash: hash || null, cwd: cwd || null }
  } catch {
    return { hash: null, cwd: null }
  }
}
