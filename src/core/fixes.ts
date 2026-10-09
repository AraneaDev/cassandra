import { gitState } from './freshness.ts'
import type { Io } from './io.ts'
import { join } from './path.ts'
import { findRepoRoot, isFingerprint, safeSegment, type Paths } from './paths.ts'
import type { FailureRecord, FixNote } from './types.ts'

/** git's empty tree: what a repository with no commits is diffed from. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
const NOTE_FILES_MAX = 10
const NAME_MAX = 120
const SENTENCE_NAMES = 3

/** Where one call's fix note lives: sharded like records, never outside `fixes/`. */
export function fixPath(paths: Paths, hash: string): string {
  const cleaned = safeSegment(hash, 'invalid')
  const safe = isFingerprint(cleaned) ? cleaned : 'invalid'
  return join(paths.root, 'fixes', safe.slice(0, 2), `${safe}.json`)
}

/** A file name fit to put in a sentence the model reads: no control characters, bounded. */
function cleanName(name: string): string {
  const t = name.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim()
  return t.length > NAME_MAX ? `${t.slice(0, NAME_MAX - 3)}...` : t
}

/**
 * What changed between a recorded failure and now, by file name: committed changes since
 * the failure's HEAD, plus paths whose dirty status flipped. A path dirty at both moments
 * cannot be told apart by name and is left out. Null when the record predates this or was
 * not in git, or when git cannot answer now.
 */
export async function computeFix(io: Io, cwd: string, record: FailureRecord): Promise<FixNote | null> {
  if (record.gitHead === undefined) return null
  try {
    const root = await findRepoRoot(io, cwd)
    const now = await gitState(io, root)
    if (!now) return null
    let rewritten = false
    const changed = new Set<string>()
    if (now.head !== 'no-head') {
      const from = record.gitHead === 'no-head' ? EMPTY_TREE : record.gitHead
      const diff = await io.run(['git', '-C', root, 'diff', '--name-only', from, now.head], root)
      if (!diff || diff.exitCode !== 0) rewritten = true
      else for (const f of diff.stdout.split('\n')) if (f) changed.add(f)
    }
    const before = new Set(record.dirty ?? [])
    const after = new Set(now.dirty)
    for (const f of before) if (!after.has(f)) changed.add(f)
    for (const f of after) if (!before.has(f)) changed.add(f)
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
    return { kind: n.kind, files: n.files.filter((f) => typeof f === 'string').map(cleanName), more: typeof n.more === 'number' ? n.more : 0, at: n.at }
  } catch {
    return null
  }
}

/** Remove every fix note for the project; returns how many were removed. Never throws. */
export async function removeAllFixes(io: Io, paths: Paths): Promise<number> {
  let n = 0
  try {
    const root = join(paths.root, 'fixes')
    const shards = await io.list(root)
    if (!shards.ok) return 0
    for (const shard of shards.entries) {
      if (shard.kind !== 'dir') continue
      const files = await io.list(join(root, shard.name))
      if (!files.ok) continue
      for (const f of files.entries) {
        if (!f.name.endsWith('.json')) continue
        try { await io.remove(join(root, shard.name, f.name)); n += 1 } catch { /* next */ }
      }
    }
  } catch {
    // Best effort by design.
  }
  return n
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
  if (note.kind === 'elsewhere') return `Last time it started working with no change inside this repository; the fix was elsewhere (${day}).`
  if (note.kind === 'rewritten') {
    return note.files.length + note.more === 0
      ? `Last time it started working after history was rewritten (${day}).`
      : `Last time it started working after history was rewritten; ${names(note.files, note.more)} also changed (${day}).`
  }
  return `Last time this started working after ${names(note.files, note.more)} changed (${day}).`
}
