import type { Io } from '../src/core/io.ts'
import type { PaneModel } from '../src/core/pane.ts'
import type { PaneLayout } from './layout.ts'
import { callDigest } from './retest.ts'

/**
 * What one surface last drew: the row it marked selected, every row it showed, every record
 * it counted, the whole list the marker walks (the tab and search applied, in order), the
 * marked record when it offered a retest, and the record whose retest confirm it drew whole.
 */
export interface DrawnPane {
  selected: string | null
  hashes: ReadonlySet<string>
  counted: ReadonlySet<string>
  rows: readonly string[]
  retestable: string | null
  /** The record whose whole call this surface drew under a Run, when it did. */
  confirming: string | null
  /** The digest of the call that confirm showed (callDigest), so Run runs that call or nothing. */
  shown: string | null
  /** How many pages of the full output this surface could show, 0 when it drew none. */
  fullPages: number
}

/** What each surface last drew, by surface. Forget acts only on rows the person saw. */
export type DrawnBySurface = Map<string, DrawnPane>

/** What a surface drew from this model laid out so. Rejects only when the shown call cannot be digested. */
export async function drawnOf(io: Io, model: PaneModel, layout: PaneLayout): Promise<DrawnPane> {
  const confirming = layout.retest !== null && layout.retest !== 'too-small'
  const { start, count } = layout.list
  return {
    selected: model.selected,
    hashes: new Set(model.rows.slice(start, start + count).map((r) => r.hash)),
    counted: new Set(model.hashes),
    rows: model.rows.map((r) => r.hash),
    retestable: model.detail?.retest.ok === true ? model.selected : null,
    confirming: confirming ? model.selected : null,
    shown: confirming && model.detail?.retest.ok === true
      ? await callDigest(io, model.detail.retest.tool, model.detail.retest.input, model.detail.retest.cwd) : null,
    fullPages: layout.full?.pages ?? 0,
  }
}

/** The row this surface drew as marked: the selection when it was drawn here, else the row drawn as selected. */
export function markedRow(drawn: DrawnPane, selected: string | null): string | null {
  return selected !== null && drawn.hashes.has(selected) ? selected : drawn.selected
}

/**
 * The row `by` steps from the selection in the whole list this surface drew (not empty),
 * stopping at either end; from the row drawn as selected when the list does not hold the
 * selection.
 */
export function steppedRow(drawn: DrawnPane, selected: string | null, by: 1 | -1): string {
  const start = selected !== null && drawn.rows.includes(selected) ? selected : drawn.selected
  const from = drawn.rows.indexOf(start ?? '')
  return drawn.rows[Math.min(drawn.rows.length - 1, Math.max(0, (from < 0 ? 0 : from) + by))]!
}

/** The page of the full output `by` turns to from `page`, held to the pages this surface drew (at least one). */
export function turnedPage(drawn: DrawnPane, page: number, by: 1 | -1): number {
  const last = drawn.fullPages - 1
  const at = Math.min(last, Math.max(0, Math.trunc(page) || 0))
  return Math.min(last, Math.max(0, at + by))
}
