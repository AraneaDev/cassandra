import type { PaneModel } from '../src/core/pane.ts'

/** How much width the pane has: decides what the header, counters and tabs show. */
export type Tier = 'narrow' | 'medium' | 'wide'

/** What the pane shows, decided from its model and its size. Pure data; the drawing follows it. */
export interface PaneLayout {
  tier: Tier; tooShort: boolean
  header: { branch: boolean; commit: boolean }
  counters: 'tiles' | 'short' | 'in-header'
  tabs: 'names' | 'digits'
  justWarned: boolean
  /** Records `start` .. `start + count` of `model.rows`; `more` records follow the window. */
  list: { start: number; count: number; more: number }
  detail: 'full' | 'compact' | 'none'
}

/** Header, tabs, one list row and the key bar: below this only a one-line fallback fits. */
export const PANE_MIN_LINES = 4
/** Below this many rows the counters move into the header line. */
const COUNTERS_IN_HEADER_BELOW = 22
const NARROW_BELOW = 56
const WIDE_FROM = 100

// Rows each part of the pane costs.
const HEADER_ROWS = 1
const TABS_ROWS = 1
const TILES_ROWS = 3
const SHORT_COUNTERS_ROWS = 1
const JUST_WARNED_ROWS = 6
const HISTORY_TITLE_ROWS = 1
const KEY_BAR_ROWS = 1
const FULL_DETAIL_ROWS = 9
const COMPACT_DETAIL_ROWS = 3

/** The width tier of a pane `columns` wide. */
export function tierOf(columns: number): Tier {
  if (columns < NARROW_BELOW) return 'narrow'
  return columns < WIDE_FROM ? 'medium' : 'wide'
}

/**
 * The records that fit `budget` rows from `start`, counting the day label above each group
 * and the blank line between groups. At least one record when there is one: a single row is
 * always worth showing, the drawing leaves its label out when that is all that fits.
 */
function fits(model: PaneModel, start: number, budget: number): number {
  let used = 0
  let count = 0
  let group: string | null = null
  for (let i = start; i < model.rows.length; i++) {
    const row = model.rows[i]!
    const cost = row.group === group ? 1 : (group === null ? 2 : 3)
    if (count > 0 && used + cost > budget) break
    used += cost
    count++
    group = row.group
  }
  return count
}

/** The window onto `model.rows` that holds the selected row, scrolled no further than it must. */
function windowOf(model: PaneModel, budget: number): PaneLayout['list'] {
  const total = model.rows.length
  if (total === 0 || budget < 1) return { start: 0, count: 0, more: total }
  const found = model.rows.findIndex((r) => r.hash === model.selected)
  const selected = found < 0 ? 0 : found
  let start = 0
  let count = fits(model, 0, budget)
  while (start + count <= selected) {
    start++
    count = fits(model, start, budget)
  }
  return { start, count, more: total - start - count }
}

/** Decide what shows for `model` in a pane of `columns` by `rows`. */
export function layoutOf(model: PaneModel, columns: number, rows: number): PaneLayout {
  const tier = tierOf(columns)
  const tooShort = rows < PANE_MIN_LINES
  const counters: PaneLayout['counters'] = tooShort || rows < COUNTERS_IN_HEADER_BELOW
    ? 'in-header' : tier === 'wide' ? 'tiles' : 'short'
  const tabs: PaneLayout['tabs'] = tier === 'narrow' || tooShort ? 'digits' : 'names'
  if (tooShort) {
    return {
      tier, tooShort, header: { branch: false, commit: false }, counters, tabs, justWarned: false,
      list: { start: 0, count: 0, more: model.rows.length }, detail: 'none',
    }
  }
  const counterRows = counters === 'tiles' ? TILES_ROWS : counters === 'short' ? SHORT_COUNTERS_ROWS : 0
  const chrome = HEADER_ROWS + TABS_ROWS + counterRows + HISTORY_TITLE_ROWS + KEY_BAR_ROWS
  let available = rows - chrome
  // The card goes first when it would leave the list nothing.
  const justWarned = model.justWarned !== null && available - JUST_WARNED_ROWS >= 1
  if (justWarned) available -= JUST_WARNED_ROWS
  // With nothing left the history title gives up its row to the one list row.
  if (available < 1) available = 1
  let detail: PaneLayout['detail'] = 'none'
  if (model.view.expanded) {
    if (available - FULL_DETAIL_ROWS >= 1) detail = 'full'
    else if (available - COMPACT_DETAIL_ROWS >= 1) detail = 'compact'
  }
  const taken = detail === 'full' ? FULL_DETAIL_ROWS : detail === 'compact' ? COMPACT_DETAIL_ROWS : 0
  return {
    tier, tooShort, header: { branch: tier !== 'narrow', commit: tier === 'wide' },
    counters, tabs, justWarned, list: windowOf(model, available - taken), detail,
  }
}
