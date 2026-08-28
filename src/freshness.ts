import { createHash } from 'node:crypto'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { findRepoRoot } from './paths'
import type { StateKind, StateStamp } from './types'

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
function gitStamp(root: string): StateStamp | null {
  try {
    const head = Bun.spawnSync(['git', '-C', root, 'rev-parse', 'HEAD'], { stderr: 'ignore' })
    const status = Bun.spawnSync(['git', '-C', root, 'status', '--porcelain'], { stderr: 'ignore' })
    if (status.exitCode !== 0) return null
    // A repository with no commits yet fails `rev-parse HEAD`, so its exit code is
    // checked explicitly rather than trusting whatever git wrote to stdout on
    // failure. Substituting a fixed literal keeps the stamp defined by our own
    // code. The repo is still stampable either way: `status --porcelain` alone
    // already lists every untracked and staged file, so the stamp stays valid and
    // moves both with the working tree and with the first commit.
    const headValue = head.exitCode === 0 ? head.stdout.toString() : 'no-head'
    const text = `${headValue} ${status.stdout.toString()}`
    return { kind: 'git', value: createHash('sha256').update(text).digest('hex').slice(0, 16) }
  } catch {
    return null
  }
}

/**
 * Distinguishes a subdirectory that is genuinely gone from one that could not be
 * read for some other reason. Only `ENOENT` and `ENOTDIR` mean gone: the walk may
 * safely skip that subtree, since its absence is real information. Every other
 * code, most importantly `EACCES`/`EPERM`, means the content is still there but
 * invisible to the walk, and must not be treated the same as absence, or a change
 * confined to that subtree would never move the stamp.
 */
export function isMissingSubtree(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
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
function mtimeStamp(root: string): StateStamp | null {
  try {
    readdirSync(root)
  } catch {
    return null
  }

  const parts: string[] = []
  let seen = 0
  let poisoned = false
  const walk = (dir: string, depth: number): void => {
    if (poisoned) return
    if (depth > MAX_DEPTH || seen >= MAX_ENTRIES) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (err) {
      if (!isMissingSubtree(err)) poisoned = true
      return
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (poisoned) return
      if (seen >= MAX_ENTRIES) return
      if (entry.name.startsWith('.') || SKIP.has(entry.name)) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      try {
        const st = statSync(full)
        parts.push(`${full}:${st.size}:${st.mtimeMs}`)
        seen += 1
      } catch {
        // A file that vanished mid-walk simply does not contribute.
      }
    }
  }
  try {
    walk(root, 0)
  } catch {
    return null
  }
  if (poisoned) return null

  // A real entry line always has the shape `<fullpath>:<size>:<mtimeMs>`, where
  // `<fullpath>` is produced by `join` and so never begins with a space. The
  // sentinel below does, so it can never collide with a genuine listing: an empty,
  // readable directory is a valid, stable state, not an unknown one.
  const payload = parts.length === 0 ? ' empty' : parts.join('\n')
  return { kind: 'mtime', value: createHash('sha256').update(payload).digest('hex').slice(0, 16) }
}

/**
 * Fingerprint the workspace so a later call can ask whether anything changed.
 *
 * Runs only after a hash hit, never on a miss, which is what lets it afford a
 * subprocess. Returns `none` when it cannot tell, and `none` never warns.
 */
export function stateStamp(cwd: string): StateStamp {
  if (!existsSync(cwd)) return { kind: 'none', value: '' }
  const root = findRepoRoot(cwd)
  if (existsSync(join(root, '.git'))) {
    const stamp = gitStamp(root)
    if (stamp) return stamp
  }
  return mtimeStamp(root) ?? { kind: 'none', value: '' }
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
