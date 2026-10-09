import { oneLine } from './describe.ts'
import { fixSentence, readFix } from './fixes.ts'
import { stateStamp, unchanged } from './freshness.ts'
import type { Io } from './io.ts'
import { pathsFor } from './paths.ts'
import { listRecords } from './record.ts'
import { readStats, warningRates } from './stats.ts'

/** One remembered call as a list row. */
export interface PaneRow { hash: string; id: string; display: string; kind: 'failed' | 'denied'; count: number; day: string; stale: boolean }
/** What the selected row shows beneath the list. */
export interface PaneDetail { reason: string; probe: string; fix: string | null }
/** What the pane remembers between redraws. */
export interface PaneView { selected: string | null; confirmAll: boolean; notice: string | null }
/** Everything the pane draws, as plain data. */
export interface PaneModel {
  rows: PaneRow[]
  more: number
  selected: string | null
  detail: PaneDetail | null
  stats: string | null
  confirmAll: boolean
  total: number
  notice: string | null
  error: string | null
}

const UNREADABLE = "Cassandra could not read this project's store."

/** The order the pane lists records in: the most recently seen first. */
function newestFirst(a: { record: { lastSeen: string } }, b: { record: { lastSeen: string } }): number {
  return b.record.lastSeen.localeCompare(a.record.lastSeen)
}

/**
 * The record a Forget press acts on, read fresh: the selected one while it is still
 * remembered, otherwise the newest, which is the row the pane then shows as selected.
 * Null when nothing is remembered.
 */
export async function paneTarget(io: Io, cwd: string, selected: string | null): Promise<string | null> {
  const all = await listRecords(io, await pathsFor(io, cwd))
  if (all.some((r) => r.hash === selected)) return selected
  return all.sort(newestFirst)[0]?.hash ?? null
}

/** Plain display data for `/cassandra pane`: what is remembered, what is selected, and how warnings fare. */
export async function paneModel(io: Io, cwd: string, view: PaneView, maxRows: number): Promise<PaneModel> {
  const empty = emptyModel(view)
  try {
    const paths = await pathsFor(io, cwd)
    const all = await listRecords(io, paths)
    const events = await readStats(io, paths)
    const rates = warningRates(events)
    const stats = rates.warned === 0
      ? null
      : `fp ${rates.fpRate.toFixed(1)}% · same_context ${rates.sameContextRate.toFixed(1)}%`
    if (all.length === 0) return { ...empty, stats }

    const stamp = await stateStamp(io, cwd)
    const sorted = all
      .map(({ hash, record }) => ({ hash, record, stale: !unchanged(record.stateStamp, record.stateKind, stamp) }))
      .sort(newestFirst)
    const shown = sorted.slice(0, Math.max(0, maxRows))
    const rows: PaneRow[] = shown.map(({ hash, record, stale }) => ({
      hash,
      id: hash.slice(0, 8),
      display: oneLine(record.display),
      kind: record.kind === 'denial' ? 'denied' : 'failed',
      count: record.count,
      day: record.lastSeen.slice(5, 10),
      stale,
    }))

    // A selection that vanished, or sits past maxRows, falls back to the first shown row on
    // purpose: the pane has no scrolling.
    const chosen = shown.find((r) => r.hash === view.selected) ?? shown[0]
    let detail: PaneDetail | null = null
    if (chosen) {
      const note = await readFix(io, paths, chosen.hash)
      // A record's stateKind is never 'none': the record writer refuses to store a 'none' stamp.
      const kind = chosen.record.stateKind
      detail = {
        reason: chosen.record.errorExcerpt ? 'stored excerpt (tool output)' : '(none captured)',
        probe: `${kind} · ${chosen.stale ? 'something' : 'nothing'} changed since`,
        fix: note ? fixSentence(note) : null,
      }
    }
    return {
      ...empty,
      rows,
      more: sorted.length - rows.length,
      selected: chosen?.hash ?? null,
      detail,
      stats,
      total: sorted.length,
    }
  } catch {
    return unreadableModel(view)
  }
}

function emptyModel(view: PaneView): PaneModel {
  return {
    rows: [], more: 0, selected: null, detail: null, stats: null,
    confirmAll: view.confirmAll, total: 0, notice: view.notice, error: null,
  }
}

/** The model of a pane that cannot read its store or its view: the one error line. */
export function unreadableModel(view: PaneView = { selected: null, confirmAll: false, notice: null }): PaneModel {
  return { ...emptyModel(view), error: UNREADABLE }
}
