import { evidence, gitPhrase, inScope, oneLine, origin } from './describe.ts'
import { fixSentence, readFix } from './fixes.ts'
import { stateStamp, unchanged } from './freshness.ts'
import type { Io } from './io.ts'
import { basename } from './path.ts'
import { findRepoRoot, pathsFor, type Paths } from './paths.ts'
import { listRecords, readRecord } from './record.ts'
import { redactSecrets } from './redact.ts'
import { compactionCount } from './session.ts'
import { attributeBoundary, countToday, readStats, warningRates, type PaneCounters, type StatEvent } from './stats.ts'
import type { FailureRecord, StateStamp } from './types.ts'

/** Which records a tab lists: every one, or only those in one state. */
export type PaneTab = 'history' | 'warnings' | 'stale' | 'denied'
/** A record's state now: it would warn, the workspace moved since, or it was a denial. */
export type RowState = 'warns' | 'stale' | 'denied'
/**
 * One remembered call as a list row: `display` is the command on one line, `where` its
 * package suffix (" (in packages/a)") or '', `time` the local HH:MM of `lastSeen` (MM-DD under
 * Last week and Older) and `group` its day group (see `dayGroup`).
 */
export interface PaneRow { hash: string; id: string; display: string; where: string; state: RowState; count: number; time: string; group: string }
/**
 * What the selected row shows. `reason` is the stored excerpt on one line, `full` the stored
 * multi-line output; `evidenceThen`/`evidenceNow` the workspace when it failed and now;
 * `firstSeen`/`lastSeen` ISO; `session` where it failed relative to this session; `retest`
 * the call to run again, or why it cannot be.
 */
export interface PaneDetail {
  exitCode: number | null; reason: string | null; full: string | null
  warnsNow: boolean; evidenceThen: string; evidenceNow: string
  firstSeen: string; lastSeen: string; tries: number
  session: string; fix: string | null
  retest: { ok: true; tool: string; input: unknown; cwd: string } | { ok: false; why: 'denied' | 'no-input' | 'too-large' | 'secret' }
}
/** The warning this session raised last, for the record it was about. */
export interface JustWarned { hash: string; at: string; display: string; count: number; lastSeen: string; reason: string | null; evidence: string; fix: string | null }
/**
 * The warning this session raised last: its record, when, the session that raised it, and
 * that record as it stood when the warning was raised (`count`, `lastSeen`, `evidence`, the
 * one-line `reason` and the `fix` sentence, null for none), so a later failure, a new fix
 * note or a stale workspace does not change what the card says was warned. A value from
 * before a field was kept lacks it, and reads the live record (or, for `sessionId`, the
 * stats log) instead.
 */
export interface LastWarning {
  hash: string; at: string; sessionId?: string
  count?: number; lastSeen?: string; evidence?: string; reason?: string | null; fix?: string | null
}
/** What the pane remembers between redraws. */
export interface PaneView { tab: PaneTab; selected: string | null; expanded: boolean; confirmAll: boolean; confirmRetest: string | null; showFull: boolean; query: string; notice: string | null; lastWarning: LastWarning | null }
/** Everything the pane draws, as plain data. */
export interface PaneModel {
  project: string; git: { branch: string | null; head: string } | null
  tabs: Record<PaneTab, number>; counters: PaneCounters; rates: string | null
  justWarned: JustWarned | null
  /** The whole filtered (tab, query), sorted (newest first) list; windowing is the layout's. */
  rows: PaneRow[]; selected: string | null; detail: PaneDetail | null
  /** Every record in the store, filtered out ones included: what a confirmed Forget all may delete. */
  total: number; hashes: string[]; view: PaneView; error: string | null
}

const UNREADABLE = "Cassandra could not read this project's store."

/** Longest stored excerpt the model hands on; the drawing clips it to the width. */
const REASON_CAP = 500

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** The view a pane starts from. */
const DEFAULT_VIEW: PaneView = {
  tab: 'history', selected: null, expanded: false, confirmAll: false, confirmRetest: null,
  showFull: false, query: '', notice: null, lastWarning: null,
}

/**
 * Which day heading a record falls under, by local calendar day: `Today`, `Yesterday`, the
 * weekday name within six days, `Last week` within thirteen, else `Older`. A future or
 * unreadable time reads as `Today` and `Older` respectively.
 */
export function dayGroup(lastSeenIso: string, nowIso: string): string {
  const then = new Date(lastSeenIso)
  const now = new Date(nowIso)
  if (Number.isNaN(then.getTime()) || Number.isNaN(now.getTime())) return 'Older'
  const midnight = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  // Rounded, so a day that is 23 or 25 hours long across a DST change still counts as one.
  const days = Math.round((midnight(now) - midnight(then)) / 86_400_000)
  if (days <= 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days <= 6) return WEEKDAYS[then.getDay()]!
  if (days <= 13) return 'Last week'
  return 'Older'
}

/**
 * What a row's time column shows: local HH:MM, or MM-DD once the day group is `Last week` or
 * `Older` (both 5 cells); '' when the time does not parse.
 */
function clock(iso: string, group: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const two = (n: number): string => String(n).padStart(2, '0')
  return group === 'Last week' || group === 'Older'
    ? `${two(d.getMonth() + 1)}-${two(d.getDate())}`
    : `${two(d.getHours())}:${two(d.getMinutes())}`
}

/** "fp X% · same_context Y%", as `cassandra stats` reads them; null when nothing was warned. */
function ratesLine(events: StatEvent[]): string | null {
  const rates = warningRates(events)
  return rates.warned === 0
    ? null
    : `fp ${rates.fpRate.toFixed(1)}% · same_context ${rates.sameContextRate.toFixed(1)}%`
}

/** The exit code a Bash failure's output starts with ("Exit code 2"), or null. */
function exitCodeOf(excerpt: string): number | null {
  const m = /^\s*Exit code (-?\d+)\b/.exec(excerpt)
  return m ? Number(m[1]) : null
}

/** The workspace a record was stamped against, as one phrase. */
function evidenceThen(r: FailureRecord): string {
  if (r.stateKind !== 'git') return 'the files under this directory tree'
  if (!r.gitHead) return 'this repository, HEAD not recorded'
  return gitPhrase(r.gitHead, r.dirty ?? [], r.dirtyTruncated === true)
}

/** The workspace now, as one phrase that reads against `evidenceThen`. */
function evidenceNow(r: FailureRecord, stamp: StateStamp, same: boolean): string {
  if (stamp.kind === 'git' && stamp.git) return gitPhrase(stamp.git.head, stamp.git.dirty)
  if (r.stateKind === 'git') return 'not a git repository now'
  if (stamp.kind === 'mtime') return same ? 'no file changed since' : 'files changed since'
  return 'the workspace cannot be read now'
}

/** Why a record cannot be retested, or the exact call to run. */
function retestOf(r: FailureRecord, cwd: string): PaneDetail['retest'] {
  if (r.kind === 'denial') return { ok: false, why: 'denied' }
  if (r.inputSecret) return { ok: false, why: 'secret' }
  if (r.inputTooLarge) return { ok: false, why: 'too-large' }
  if (r.input === undefined) return { ok: false, why: 'no-input' }
  return { ok: true, tool: r.tool, input: r.input, cwd: typeof r.cwd === 'string' && r.cwd ? r.cwd : cwd }
}

/** Branch and short HEAD of the repository at `root`; null outside git. `branch` is null on a detached head. */
async function gitInfo(io: Io, root: string, stamp: StateStamp): Promise<PaneModel['git']> {
  if (stamp.kind !== 'git' || !stamp.git) return null
  const ref = await io.run(['git', '-C', root, 'symbolic-ref', '--short', '-q', 'HEAD'], root)
  const branch = ref && ref.exitCode === 0 ? oneLine(ref.stdout) || null : null
  return { branch, head: oneLine(stamp.git.head).slice(0, 7) }
}

async function fixOf(io: Io, paths: Paths, hash: string): Promise<string | null> {
  const note = await readFix(io, paths, hash)
  return note ? fixSentence(note) : null
}

// Redacted again as read, for a record an older version stored before redaction.
const reasonOf = (r: FailureRecord): string | null => oneLine(redactSecrets(r.errorExcerpt)).slice(0, REASON_CAP) || null
/** The call as the pane shows it, on one line and redacted. */
const displayOf = (r: FailureRecord): string => oneLine(redactSecrets(r.display))

/**
 * What the Just warned card keeps of a warning raised now in `sessionId`: the record as it
 * stands, before the call settles it. Only `hash`, `at` and `sessionId` when the record
 * cannot be read. Rejects only when the store's location cannot be worked out.
 */
export async function lastWarningOf(io: Io, cwd: string, hash: string, sessionId: string): Promise<LastWarning> {
  const paths = await pathsFor(io, cwd)
  const base = { hash, at: io.now(), sessionId }
  const r = await readRecord(io, paths, hash).catch(() => null)
  if (r === null) return base
  return { ...base, count: r.count, lastSeen: r.lastSeen, evidence: evidence(r), reason: reasonOf(r), fix: await fixOf(io, paths, hash).catch(() => null) }
}

/** A kept field of a last warning, or the live value when the snapshot predates it. */
const keptOr = <T>(kept: T | null | undefined, live: () => T | null | Promise<T | null>): T | null | Promise<T | null> =>
  kept === undefined ? live() : kept

/**
 * Plain display data for the `/cassandra` pane: the project, the records by tab and day, the
 * selected record in full, and this session's latest warning. `sessionId` keeps `justWarned`
 * to a warning this session actually raised.
 */
export async function paneModel(io: Io, cwd: string, view: PaneView, sessionId: string): Promise<PaneModel> {
  try {
    const now = io.now()
    const root = await findRepoRoot(io, cwd)
    const paths = await pathsFor(io, cwd)
    const all = await listRecords(io, paths)
    const events = await readStats(io, paths)
    const stamp = await stateStamp(io, cwd)

    const sorted = all
      .map(({ hash, record }) => {
        const same = unchanged(record.stateStamp, record.stateKind, stamp, record.stateCoarse)
        const state: RowState = record.kind === 'denial' ? 'denied' : same ? 'warns' : 'stale'
        return { hash, record, same, state }
      })
      .sort((a, b) => b.record.lastSeen.localeCompare(a.record.lastSeen))

    const tabs: Record<PaneTab, number> = { history: sorted.length, warnings: 0, stale: 0, denied: 0 }
    for (const r of sorted) tabs[r.state === 'warns' ? 'warnings' : r.state] += 1

    const query = view.query.trim().toLowerCase()
    const shown = sorted.filter((r) =>
      (view.tab === 'history' || r.state === (view.tab === 'warnings' ? 'warns' : view.tab))
      && (!query || displayOf(r.record).toLowerCase().includes(query)))
    const rows: PaneRow[] = shown.map(({ hash, record, state }) => {
      const group = dayGroup(record.lastSeen, now)
      return {
        hash,
        id: hash.slice(0, 8),
        display: displayOf(record),
        where: inScope(record),
        state,
        count: record.count,
        time: clock(record.lastSeen, group),
        group,
      }
    })

    const chosen = shown.find((r) => r.hash === view.selected) ?? shown[0]
    let detail: PaneDetail | null = null
    if (chosen) {
      const r = chosen.record
      const boundary = attributeBoundary(
        { sessionId: r.sessionId, compactions: r.compactions, agentId: r.agentId },
        // The pane runs in the main agent, so a record with an agentId reads as another agent's.
        { sessionId, compactions: await compactionCount(io, paths, sessionId) },
      )
      detail = {
        exitCode: exitCodeOf(r.errorExcerpt),
        reason: reasonOf(r),
        full: typeof r.errorFull === 'string' && r.errorFull ? redactSecrets(r.errorFull) : null,
        warnsNow: chosen.same,
        evidenceThen: evidenceThen(r),
        evidenceNow: evidenceNow(r, stamp, chosen.same),
        firstSeen: r.firstSeen,
        lastSeen: r.lastSeen,
        tries: r.count,
        session: origin(boundary),
        fix: await fixOf(io, paths, chosen.hash),
        retest: retestOf(r, cwd),
      }
    }

    let justWarned: JustWarned | null = null
    const last = view.lastWarning
    const warned = last && sorted.find((r) => r.hash === last.hash)
    // The session the snapshot names; an older one without it is checked against the stats log.
    const ours = last !== null && (typeof last.sessionId === 'string'
      ? last.sessionId === sessionId
      : events.some((e) => e.kind === 'warned' && e.hash === last.hash && e.sessionId === sessionId))
    if (last && warned && ours) {
      const r = warned.record
      justWarned = {
        hash: last.hash, at: last.at, display: displayOf(r), count: last.count ?? r.count, lastSeen: last.lastSeen ?? r.lastSeen,
        reason: await keptOr(last.reason, () => reasonOf(r)), evidence: last.evidence ?? evidence(r),
        fix: await keptOr(last.fix, () => fixOf(io, paths, last.hash)),
      }
    }

    return {
      project: basename(root),
      git: await gitInfo(io, root, stamp),
      tabs,
      counters: {
        warnNow: tabs.warnings,
        remembered: sorted.length,
        warningsToday: countToday(events, 'warned', now),
        clearedByRetest: countToday(events, 'retest_cleared', now),
      },
      rates: ratesLine(events),
      justWarned,
      rows,
      selected: chosen?.hash ?? null,
      detail,
      total: sorted.length,
      hashes: sorted.map((r) => r.hash),
      view,
      error: null,
    }
  } catch {
    return unreadableModel(view)
  }
}

/** The model of a pane that cannot read its store or its view: the one error line. */
export function unreadableModel(view: PaneView = DEFAULT_VIEW): PaneModel {
  return {
    project: '', git: null,
    tabs: { history: 0, warnings: 0, stale: 0, denied: 0 },
    counters: { warnNow: 0, remembered: 0, warningsToday: 0, clearedByRetest: 0 },
    rates: null, justWarned: null, rows: [], selected: null, detail: null,
    total: 0, hashes: [], view, error: UNREADABLE,
  }
}
