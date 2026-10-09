import { gitState, unquote } from './freshness.ts'
import type { Entry, Io } from './io.ts'
import { join } from './path.ts'
import { findRepoRoot, isFingerprint, safeSegment, type Paths } from './paths.ts'
import type { FailureRecord, FixNote } from './types.ts'

/** git's empty tree: what a repository with no commits is diffed from. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
const NOTE_FILES_MAX = 10
const NAME_MAX = 120
const SENTENCE_NAMES = 3

/** Most dirty paths whose content a failure record hashes. */
const HASHED_MAX = 50
/** Longest text, in string length, that is hashed; a longer file has no hash. */
const HASHED_TEXT_MAX = 256 * 1024

/** Directory listings for one pass over a set of paths, so a shared parent is listed once. */
type Listings = Map<string, Promise<Entry[] | null>>

/** A directory's entries through the per-pass cache; null when it cannot be listed. */
function listed(io: Io, dir: string, listings: Listings): Promise<Entry[] | null> {
  let listing = listings.get(dir)
  if (!listing) {
    listing = io.list(dir).then((l) => (l.ok ? l.entries : null), () => null)
    listings.set(dir, listing)
  }
  return listing
}

/**
 * The first 16 hex characters of a repo-relative path's content hash, or null when it is
 * not a regular file reached through real directories (missing, a directory, a link or
 * under one, unlistable or unreadable) or its text is longer than 256K characters. One
 * leading byte order mark is dropped first, since not every reader keeps it. Never throws.
 */
async function contentHash(io: Io, root: string, path: string, listings: Listings): Promise<string | null> {
  try {
    if (!path || path.endsWith('/')) return null
    const full = join(root, path)
    const prefix = root.endsWith('/') ? root : `${root}/`
    const rel = full.slice(prefix.length)
    if (!full.startsWith(prefix) || !rel) return null
    // Every directory from the root down must list as a directory, never a link: reading
    // through a linked directory would hash a file outside the repository.
    const parts = rel.split('/')
    let dir = root
    for (const part of parts.slice(0, -1)) {
      if ((await listed(io, dir, listings))?.find((e) => e.name === part)?.kind !== 'dir') return null
      dir = join(dir, part)
    }
    const entry = (await listed(io, dir, listings))?.find((e) => e.name === parts.at(-1))
    // UTF-8 spends at most 3 bytes per UTF-16 unit, so a file this large cannot be short enough.
    if (entry?.kind !== 'file' || entry.size > HASHED_TEXT_MAX * 3) return null
    const raw = await io.readText(full)
    if (raw === null) return null
    const text = raw.startsWith('\uFEFF') ? raw.slice(1) : raw
    if (text.length > HASHED_TEXT_MAX) return null
    return (await io.sha256(text)).slice(0, 16)
  } catch {
    return null
  }
}

/**
 * Content hashes of the first 50 dirty paths, in git's order, for a failure record. A path
 * that cannot be hashed is left out silently. Reads files only; writes nothing to git.
 */
export async function dirtyHashes(io: Io, root: string, dirty: readonly string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const listings: Listings = new Map()
  for (const path of dirty.slice(0, HASHED_MAX)) {
    const h = await contentHash(io, root, path, listings)
    if (h !== null) out[path] = h
  }
  return out
}

/** Where one call's fix note lives: sharded like records, never outside `fixes/`. */
export function fixPath(paths: Paths, hash: string): string {
  const cleaned = safeSegment(hash, 'invalid')
  const safe = isFingerprint(cleaned) ? cleaned : 'invalid'
  return join(paths.root, 'fixes', safe.slice(0, 2), `${safe}.json`)
}

/** A file name fit to put in a sentence the model reads: no control characters, bounded. */
function cleanName(name: string): string {
  const t = name.replace(/`/g, "'").replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim()
  return t.length > NAME_MAX ? `${t.slice(0, NAME_MAX - 3)}...` : t
}

/**
 * What changed between a recorded failure and now, by file name: committed changes since
 * the failure's HEAD, plus paths whose dirty status flipped, plus paths dirty at both
 * moments whose content hash moved. A path dirty at both moments with no stored hash cannot
 * be told apart by name and is left out. Null when the record predates this or was not in
 * git, or when git cannot answer now.
 */
export async function computeFix(io: Io, cwd: string, record: FailureRecord): Promise<FixNote | null> {
  if (record.gitHead === undefined) return null
  try {
    const root = await findRepoRoot(io, cwd)
    const now = await gitState(io, root)
    if (!now) return null
    let rewritten = false
    const changed = new Set<string>()
    const validHead = record.gitHead === 'no-head' || /^[0-9a-f]{40,64}$/.test(record.gitHead)
    if (!validHead) rewritten = true
    else if (now.head === 'no-head') rewritten = record.gitHead !== 'no-head'
    else {
      const from = record.gitHead === 'no-head' ? EMPTY_TREE : record.gitHead
      const diff = await io.run(['git', '-C', root, 'diff', '--name-only', '--end-of-options', from, now.head], root)
      if (!diff || diff.exitCode !== 0) rewritten = true
      else for (const f of diff.stdout.split('\n')) if (f) changed.add(unquote(f))
    }
    const before = new Set(record.dirty ?? [])
    const after = new Set(now.dirty)
    for (const f of before) if (!after.has(f)) changed.add(f)
    // A truncated list cannot say what was already dirty, so only the exact direction holds.
    if (!record.dirtyTruncated) for (const f of after) if (!before.has(f)) changed.add(f)
    // Dirty both times: named when its content moved. A file now unhashable has changed too.
    const hashes = record.dirtyHashes
    if (hashes && typeof hashes === 'object') {
      const listings: Listings = new Map()
      for (const f of before) {
        const was = Object.hasOwn(hashes, f) ? hashes[f] : undefined
        if (typeof was !== 'string' || !after.has(f)) continue
        if ((await contentHash(io, root, f, listings)) !== was) changed.add(f)
      }
    }
    const all = [...changed].map(cleanName).filter(Boolean).sort()
    const kind = rewritten ? 'rewritten' : all.length > 0 ? 'changed' : 'elsewhere'
    return { kind, files: all.slice(0, NOTE_FILES_MAX), more: Math.max(0, all.length - NOTE_FILES_MAX), at: io.now() }
  } catch {
    return null
  }
}

/** Keep the latest fix note for a call. Never throws. */
export async function writeFix(io: Io, paths: Paths, hash: string, note: FixNote): Promise<void> {
  try {
    await io.writeText(fixPath(paths, hash), JSON.stringify(note))
  } catch {
    // Best effort by design.
  }
}

/** The fix note for a call, or null. A note that does not parse is treated as absent. */
export async function readFix(io: Io, paths: Paths, hash: string): Promise<FixNote | null> {
  try {
    const text = await io.readText(fixPath(paths, hash))
    if (text === null) return null
    const n = JSON.parse(text) as FixNote
    if (!Array.isArray(n.files) || typeof n.at !== 'string' || !['changed', 'elsewhere', 'rewritten'].includes(n.kind)) return null
    if (!/^\d{4}-\d{2}-\d{2}/.test(n.at)) return null
    const files = n.files.filter((f) => typeof f === 'string').map(cleanName).filter(Boolean).slice(0, NOTE_FILES_MAX)
    const more = Number.isInteger(n.more) && n.more >= 0 ? Math.min(n.more, 10000) : 0
    return { kind: n.kind, files, more, at: n.at }
  } catch {
    return null
  }
}

/** What clearing the fix notes came to: how many went, and how many could not be removed. */
export interface FixCleanup {
  removed: number
  failed: number
}

/**
 * Remove every fix note for the project. A missing `fixes/` is nothing to do; a directory
 * that cannot be listed, or a note that cannot be removed, counts as a failure so the
 * caller can say so rather than report a clean slate. Never throws.
 */
export async function removeAllFixes(io: Io, paths: Paths): Promise<FixCleanup> {
  const result: FixCleanup = { removed: 0, failed: 0 }
  try {
    const root = join(paths.root, 'fixes')
    const shards = await io.list(root)
    if (!shards.ok) {
      if (!shards.missing) result.failed += 1
      return result
    }
    for (const shard of shards.entries) {
      if (shard.kind !== 'dir') continue
      const files = await io.list(join(root, shard.name))
      if (!files.ok) {
        if (!files.missing) result.failed += 1
        continue
      }
      for (const f of files.entries) {
        if (!f.name.endsWith('.json')) continue
        try {
          await io.remove(join(root, shard.name, f.name))
          result.removed += 1
        } catch {
          result.failed += 1
        }
      }
    }
  } catch {
    result.failed += 1
  }
  return result
}

/** Remove the fix note of one record. A missing note is nothing to do; true unless it could not be removed. Never throws. */
export async function removeFix(io: Io, paths: Paths, hash: string): Promise<boolean> {
  try {
    await io.remove(fixPath(paths, hash))
    return true
  } catch {
    return false
  }
}

function names(files: string[], more: number): string {
  const shown = files.slice(0, SENTENCE_NAMES).map((f) => `\`${cleanName(f)}\``)
  const rest = files.length - shown.length + more
  if (rest > 0) return `${shown.join(', ')} and ${rest} more`
  if (shown.length <= 1) return shown.join('')
  return `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}`
}

/** One sentence telling the model what made this call work last time. */
export function fixSentence(note: FixNote): string {
  const day = note.at.slice(0, 10)
  if (note.kind === 'elsewhere') return `Last time it started working with no change git could see in this repository; the fix was elsewhere (${day}).`
  if (note.kind === 'rewritten') {
    return note.files.length + note.more === 0
      ? `Last time it started working after history was rewritten (${day}).`
      : `Last time it started working after history was rewritten; ${names(note.files, note.more)} also changed (${day}).`
  }
  return `Last time this started working after ${names(note.files, note.more)} changed (${day}).`
}
