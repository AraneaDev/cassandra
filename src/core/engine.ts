import { digestText, liveRecords } from './digest.ts'
import { history, reason, scopeOf } from './describe.ts'
import { computeFix, dirtyHashes, fixSentence, readFix, writeFix } from './fixes.ts'
import { displayFor, fingerprint } from './fingerprint.ts'
import { stateStamp, unchanged } from './freshness.ts'
import type { Io } from './io.ts'
import { findRepoRoot, pathsFor } from './paths.ts'
import { deleteRecord, readRecord, upsertRecord } from './record.ts'
import { packageScope } from './scope.ts'
import { compactionCount } from './session.ts'
import { appendStat, attributeBoundary, type BriefBoundary } from './stats.ts'
import type { RecordKind } from './types.ts'

const EXCERPT_MAX = 240
/** Most dirty paths a record keeps, so a huge working tree cannot bloat it. */
const DIRTY_MAX = 200

/**
 * The one piece of free text Cassandra stores and replays.
 *
 * `error_message` and `denial_reason` are the output of whatever command failed, and a
 * failing `npm`, `pip` or `curl` prints text an attacker can influence. That text is
 * written to disk and later handed back to the model as `additionalContext`, so it is
 * treated as untrusted throughout: ASCII control characters, which carry terminal escape
 * sequences and can hide or rewrite what is displayed, become spaces before anything else
 * happens, and the result is collapsed and capped. The warning template then quotes it,
 * and labels it as tool output rather than instruction.
 * Also used for an agent's stated reason when it resolves a failure.
 */
export function sanitiseExcerpt(text: string | undefined): string {
  const t = (text ?? '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return t.length > EXCERPT_MAX ? `${t.slice(0, EXCERPT_MAX - 3)}...` : t
}

/** One tracked tool call, as either front end sees it. Empty strings mean unknown. */
export interface Call {
  tool: string
  input: unknown
  cwd: string
  sessionId: string
  agentId?: string
}

/**
 * What a call came to. An interrupt is not a failure of the command, and `not_run` means
 * the tool never ran (a permission rule refused it, or approval was not granted); neither
 * records anything.
 */
export type Outcome =
  | { kind: 'failure'; reason?: string }
  | { kind: 'denial'; reason?: string }
  | { kind: 'success' }
  | { kind: 'interrupt' }
  | { kind: 'not_run' }

/** The sentence to hand the model, and the record it is about. */
export interface Warning {
  hash: string
  text: string
}

/**
 * The read path: hash, look up, and only on a hit pay for the freshness probe. Returns
 * the warning when the workspace is provably unchanged since the recorded failure, and
 * logs the boundary it crossed; null, the overwhelming majority, otherwise.
 */
export async function check(io: Io, call: Call): Promise<Warning | null> {
  if (!call.tool || !call.cwd) return null
  const hash = await fingerprint(io, call.tool, call.input, await callScope(io, call))
  if (!hash) return null

  const paths = await pathsFor(io, call.cwd)
  const found = await readRecord(io, paths, hash)
  if (!found) return null

  // Only now, on a hit, does the expensive probe run.
  if (!unchanged(found.stateStamp, found.stateKind, await stateStamp(io, call.cwd), found.stateCoarse)) return null

  const boundary = attributeBoundary(
    { sessionId: found.sessionId, compactions: found.compactions, agentId: found.agentId },
    { sessionId: call.sessionId, compactions: await compactionCount(io, paths, call.sessionId), agentId: call.agentId },
  )
  // `none` never reaches this point, since `unchanged` refuses it.
  const scope = scopeOf(found.stateKind as Exclude<typeof found.stateKind, 'none'>)
  let text = `cassandra: ${history(found)} before, most recently ${found.lastSeen}. `
    + `Nothing in ${scope} has changed since.${reason(found)}`
  // What made this call work last time, when a past success left a note.
  const note = await readFix(io, paths, hash)
  if (note) text += ` ${fixSentence(note)}`
  await appendStat(io, paths, note ? { kind: 'warned', hash, boundary, fixNote: true } : { kind: 'warned', hash, boundary })
  return { hash, text }
}

/**
 * The write path, once a call's outcome is known. `warnedHash` is the record `check`
 * warned about for this very call, if it did: a failure then confirms the warning.
 * Any success of a recorded call forgets the record and, in a git repository, keeps a
 * fix note of what changed since it failed. A success after a warning additionally
 * proves the freshness probe missed a change. Resolves true only when the store changed:
 * a record was written, or a recorded call's record was forgotten.
 */
export async function settle(io: Io, call: Call, outcome: Outcome, warnedHash: string | null): Promise<boolean> {
  // An interrupt is not a failure of the command, and a call that never ran did not fail
  // either. Remembering either would warn about something that never actually failed, so
  // both are ignored outright.
  if (outcome.kind === 'interrupt' || outcome.kind === 'not_run' || !call.cwd) return false
  const paths = await pathsFor(io, call.cwd)
  if (outcome.kind === 'success') {
    if (warnedHash) await appendStat(io, paths, { kind: 'false_positive', hash: warnedHash })
    const hash = warnedHash ?? (call.tool ? await fingerprint(io, call.tool, call.input, await callScope(io, call)) : null)
    if (!hash) return false
    const found = await readRecord(io, paths, hash)
    if (!found) return false
    // The call works now. Keep what changed since it failed, then forget it as a dead end.
    const note = await computeFix(io, call.cwd, found)
    if (note) {
      await writeFix(io, paths, hash, note)
      await appendStat(io, paths, { kind: 'fixed', hash, files: note.files.length + note.more })
    }
    await deleteRecord(io, paths, hash)
    return true
  }
  // It failed again after we warned, so the warning was right and was disregarded.
  if (warnedHash) await appendStat(io, paths, { kind: 'confirmed', hash: warnedHash })
  return record(io, call, outcome.kind, outcome.reason)
}

/** The package a Bash call ran in; '' at the repo root and for every other tool. */
async function callScope(io: Io, call: Call): Promise<string> {
  return call.tool === 'Bash' && call.cwd ? packageScope(io, call.cwd) : ''
}

async function record(io: Io, call: Call, kind: RecordKind, reason: string | undefined): Promise<boolean> {
  if (!call.tool) return false
  const scope = await callScope(io, call)
  const hash = await fingerprint(io, call.tool, call.input, scope)
  if (!hash) return false
  const paths = await pathsFor(io, call.cwd)
  const stamp = await stateStamp(io, call.cwd)
  // A state we cannot read is a record we could never safely act on, so do not store it.
  if (stamp.kind === 'none') return false
  const earlier = await readRecord(io, paths, hash)
  const { hashes, stats } = stamp.git ? await dirtyHashes(io, await findRepoRoot(io, call.cwd), stamp.git.dirty, earlier) : { hashes: {}, stats: {} }
  await upsertRecord(io, paths, hash, {
    tool: call.tool,
    display: displayFor(call.tool, call.input),
    ...(scope ? { scope } : {}),
    kind,
    stateStamp: stamp.value,
    stateKind: stamp.kind,
    ...(stamp.coarse ? { stateCoarse: stamp.coarse } : {}),
    sessionId: call.sessionId,
    compactions: await compactionCount(io, paths, call.sessionId),
    errorExcerpt: sanitiseExcerpt(reason),
    agentId: call.agentId,
    ...(stamp.git
      ? {
          gitHead: stamp.git.head,
          dirty: stamp.git.dirty.slice(0, DIRTY_MAX),
          ...(stamp.git.dirty.length > DIRTY_MAX ? { dirtyTruncated: true } : {}),
          ...(Object.keys(hashes).length > 0 ? { dirtyHashes: hashes, ...(Object.keys(stats).length > 0 ? { dirtyStats: stats } : {}) } : {}),
        }
      : {}),
  }, earlier)
  return true
}

/** A note listing the project's live failures, and the records it named. */
export interface Briefing {
  text: string
  hashes: string[]
}

/**
 * The note for a boundary where the transcript is gone: a subagent starting, or a
 * conversation compacted. Null when nothing is live. A pure read: it writes nothing, so a
 * front end that cannot hand the note over leaves no trace.
 */
export async function buildBriefing(io: Io, cwd: string): Promise<Briefing | null> {
  if (!cwd) return null
  const live = await liveRecords(io, cwd)
  if (!live) return null
  return { text: digestText(live.records, live.kind), hashes: live.records.map((r) => r.hash) }
}

/** Log that a note was handed over, so `cassandra stats` can say whether briefings are heeded. */
export async function recordBriefing(io: Io, cwd: string, boundary: BriefBoundary, briefing: Briefing): Promise<void> {
  await appendStat(io, await pathsFor(io, cwd), { kind: 'briefed', boundary, hashes: briefing.hashes })
}
