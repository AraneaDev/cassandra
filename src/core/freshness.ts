import type { Io } from './io.ts'
import { join } from './path.ts'
import { findRepoRoot } from './paths.ts'
import type { StateKind, StateStamp } from './types.ts'

/** Directories the mtime walk never descends into: churn that says nothing about source. */
const SKIP = new Set(['node_modules', 'dist', 'build', 'target', 'coverage', 'vendor', '__pycache__'])

/** Bounds on the mtime walk, so an enormous tree cannot stall the probe. */
const MAX_DEPTH = 6
const MAX_ENTRIES = 5000

/**
 * Stamp a git worktree: HEAD plus the full porcelain status. This is the strong path.
 * It sees commits, staged and unstaged edits, and untracked files, which together
 * cover every way the workspace moves, including edits made outside Claude Code.
 */
async function gitStamp(io: Io, root: string): Promise<StateStamp | null> {
  try {
    const [head, status] = await Promise.all([
      io.run(['git', '-C', root, 'rev-parse', 'HEAD'], root),
      io.run(['git', '-C', root, 'status', '--porcelain'], root),
    ])
    if (!status || status.exitCode !== 0) return null
    // A repository with no commits yet fails `rev-parse HEAD`, so its exit code is
    // checked explicitly rather than trusting whatever git wrote to stdout on
    // failure. Substituting a fixed literal keeps the stamp defined by our own
    // code. The repo is still stampable either way: `status --porcelain` alone
    // already lists every untracked and staged file, so the stamp stays valid and
    // moves both with the working tree and with the first commit.
    const headValue = head && head.exitCode === 0 ? head.stdout : 'no-head'
    const text = `${headValue} ${status.stdout}`
    return { kind: 'git', value: (await io.sha256(text)).slice(0, 16) }
  } catch {
    return null
  }
}

/**
 * Fallback for directories that are not git worktrees.
 *
 * This is the weakest part of Cassandra and is treated as such. It folds in every
 * entry's name, size and mtime rather than only the maximum mtime, so a file
 * rewritten within the same second, or replaced by one of a different length, still
 * moves the stamp. It is bounded in depth and entry count, and any failure degrades
 * to `none`, which never warns.
 *
 * Two distinct facts must not be conflated. A directory that was read successfully
 * but has nothing worth fingerprinting, because it is genuinely empty or because
 * everything in it was filtered by `SKIP` or the dot-directory rule, still yields a
 * VALID `mtime` stamp over a canonical sentinel payload. Only a directory that could
 * not be read at all yields `null`, which becomes `none` upstream. Telling the two
 * apart is what lets Cassandra stay informative on an early-stage project that is
 * nothing but `node_modules/` and dotfiles, instead of going permanently silent
 * there the moment its one real file is deleted.
 *
 * The same distinction applies one level down, inside the walk. A nested
 * subdirectory that has been deleted (`ENOENT`/`ENOTDIR`) is skipped: its absence
 * is real information the walk can act on. A nested subdirectory that merely
 * cannot be read (`EACCES`/`EPERM`, or anything unrecognised) poisons the whole
 * stamp instead of being silently treated as an empty subtree, because its content
 * still exists and can still change invisibly to the walk. A silent skip there
 * would let `unchanged()` report true for a workspace that actually changed, which
 * is the one failure mode this module exists to avoid.
 */
async function mtimeStamp(io: Io, root: string): Promise<StateStamp | null> {
  try {
    const top = await io.list(root)
    if (!top.ok) return null

    const parts: string[] = []
    let seen = 0
    let poisoned = false
    const walk = async (dir: string, depth: number, given?: Awaited<ReturnType<Io['list']>>): Promise<void> => {
      if (poisoned) return
      if (depth > MAX_DEPTH || seen >= MAX_ENTRIES) return
      const listing = given ?? await io.list(dir)
      if (!listing.ok) {
        if (!listing.missing) poisoned = true
        return
      }
      for (const entry of [...listing.entries].sort((a, b) => a.name.localeCompare(b.name))) {
        if (poisoned) return
        if (seen >= MAX_ENTRIES) return
        if (entry.name.startsWith('.') || SKIP.has(entry.name)) continue
        const full = join(dir, entry.name)
        if (entry.kind === 'dir') {
          await walk(full, depth + 1)
          continue
        }
        if (entry.kind !== 'file') continue
        parts.push(`${full}:${entry.size}:${entry.mtimeMs}`)
        seen += 1
      }
    }
    await walk(root, 0, top)
    if (poisoned) return null

    // A real entry line always has the shape `<fullpath>:<size>:<mtimeMs>`, where
    // `<fullpath>` is produced by `join` and so never begins with a space. The
    // sentinel below does, so it can never collide with a genuine listing: an empty,
    // readable directory is a valid, stable state, not an unknown one.
    const payload = parts.length === 0 ? ' empty' : parts.join('\n')
    return { kind: 'mtime', value: (await io.sha256(payload)).slice(0, 16) }
  } catch {
    return null
  }
}

/**
 * Fingerprint the workspace so a later call can ask whether anything changed.
 *
 * Runs only after a hash hit, never on a miss, which is what lets it afford a
 * subprocess. Returns `none` when it cannot tell, and `none` never warns.
 */
export async function stateStamp(io: Io, cwd: string): Promise<StateStamp> {
  if (!(await io.exists(cwd))) return { kind: 'none', value: '' }
  const root = await findRepoRoot(io, cwd)
  if (await io.exists(join(root, '.git'))) {
    const stamp = await gitStamp(io, root)
    if (stamp) return stamp
  }
  return (await mtimeStamp(io, root)) ?? { kind: 'none', value: '' }
}

/**
 * Whether the workspace is provably unchanged since a failure was recorded.
 *
 * Deliberately conservative on three counts: an unknown current state never
 * matches, an unknown recorded state never matches, and a change of probe kind
 * between the two readings never matches. Every uncertain case resolves to
 * "something may have changed", which means silence.
 */
export function unchanged(recorded: string, recordedKind: StateKind, current: StateStamp): boolean {
  if (current.kind === 'none' || recordedKind === 'none') return false
  if (current.kind !== recordedKind) return false
  if (!recorded || !current.value) return false
  return recorded === current.value
}
