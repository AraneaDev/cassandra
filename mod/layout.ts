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
  /** Whether the History card's title rule has a row; on the shortest pane it gives it to the list. */
  historyTitle: boolean
  /** Whether the last action's notice has its own row above the key bar, taken from the list. */
  notice: boolean
  /** The search row under the History title, taken from the list: the open field, the applied query, or none. */
  search: 'field' | 'query' | null
  /** Rows the key list takes from the list (its title and as many of its rows as fit), 0 when closed. */
  keys: number
  /**
   * Records `start` .. `start + count` of `model.rows`; `more` records follow the window.
   * `rows` is what the list may take: day labels, blanks and the `n more` line, not the detail.
   */
  list: { start: number; count: number; more: number; rows: number }
  detail: 'full' | 'compact' | 'none'
}

/** What the pane shows beside the model, from its own state: an open search field, an open key list. */
export interface PaneExtras { searching: boolean; showKeys: boolean; keyRows: number }

const NO_EXTRAS: PaneExtras = { searching: false, showKeys: false, keyRows: 0 }

/** Which records a list of some rows holds. */
type Window = Omit<PaneLayout['list'], 'rows'>

/** Header, tabs, one list row and the key bar: below this only a one-line fallback fits. */
export const PANE_MIN_LINES = 4
/** Below this many rows the counters move into the header line. */
const COUNTERS_IN_HEADER_BELOW = 22
const NARROW_BELOW = 56
const WIDE_FROM = 100

/** Rows each part of the pane costs: the layout budgets these, and the drawing draws exactly these. */
export const ROWS = {
  header: 1, tabs: 1, tiles: 3, shortCounters: 1, justWarned: 7, historyTitle: 1, notice: 1, search: 1, keysTitle: 1, keyBar: 1,
  fullDetail: 9, compactDetail: 3,
} as const
const HEADER_ROWS = ROWS.header
const TABS_ROWS = ROWS.tabs
const TILES_ROWS = ROWS.tiles
const SHORT_COUNTERS_ROWS = ROWS.shortCounters
const JUST_WARNED_ROWS = ROWS.justWarned
const HISTORY_TITLE_ROWS = ROWS.historyTitle
const NOTICE_ROWS = ROWS.notice
const SEARCH_ROWS = ROWS.search
const KEYS_TITLE_ROWS = ROWS.keysTitle
const KEY_BAR_ROWS = ROWS.keyBar
const FULL_DETAIL_ROWS = ROWS.fullDetail
const COMPACT_DETAIL_ROWS = ROWS.compactDetail

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
function scrolled(model: PaneModel, budget: number): Window {
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

/**
 * The window for `budget` rows. When records remain below it, the `n more` line takes one
 * of those rows; no line is drawn above the window.
 */
function windowOf(model: PaneModel, budget: number): Window {
  const whole = scrolled(model, budget)
  return whole.more > 0 && budget > 1 ? scrolled(model, budget - 1) : whole
}

/**
 * Decide what shows for `model` in a pane of `columns` by `rows`. `extras` says whether the
 * search field and the key list are open, and how many rows the key list holds.
 */
export function layoutOf(model: PaneModel, columns: number, rows: number, extras: PaneExtras = NO_EXTRAS): PaneLayout {
  const tier = tierOf(columns)
  const tooShort = rows < PANE_MIN_LINES
  const counters: PaneLayout['counters'] = tooShort || rows < COUNTERS_IN_HEADER_BELOW
    ? 'in-header' : tier === 'wide' ? 'tiles' : 'short'
  const tabs: PaneLayout['tabs'] = tier === 'narrow' || tooShort ? 'digits' : 'names'
  if (tooShort) {
    return {
      tier, tooShort, header: { branch: false, commit: false }, counters, tabs, justWarned: false,
      historyTitle: false, notice: false, search: null, keys: 0, list: { start: 0, count: 0, more: model.rows.length, rows: 0 }, detail: 'none',
    }
  }
  const counterRows = counters === 'tiles' ? TILES_ROWS : counters === 'short' ? SHORT_COUNTERS_ROWS : 0
  const chrome = HEADER_ROWS + TABS_ROWS + counterRows + HISTORY_TITLE_ROWS + KEY_BAR_ROWS
  let available = rows - chrome
  // The card goes first when it would leave the list nothing.
  const justWarned = model.justWarned !== null && available - JUST_WARNED_ROWS >= 1
  if (justWarned) available -= JUST_WARNED_ROWS
  // With nothing left the history title gives up its row to the one list row.
  const historyTitle = available >= 1
  if (!historyTitle) available += HISTORY_TITLE_ROWS
  // The search row comes before the notice: an open field must stay where it can be typed in.
  const wantsSearch: PaneLayout['search'] = extras.searching ? 'field' : model.view.query ? 'query' : null
  const search = wantsSearch !== null && available - SEARCH_ROWS >= 1 ? wantsSearch : null
  if (search !== null) available -= SEARCH_ROWS
  // The notice takes its row from the list, as long as one list row is left.
  const notice = Boolean(model.view.notice) && available - NOTICE_ROWS >= 1
  if (notice) available -= NOTICE_ROWS
  // The key list takes what it can and leaves one list row; its title alone is not worth a row.
  const keyRoom = extras.showKeys ? Math.min(KEYS_TITLE_ROWS + extras.keyRows, available - 1) : 0
  const keys = keyRoom > KEYS_TITLE_ROWS ? keyRoom : 0
  available -= keys
  let detail: PaneLayout['detail'] = 'none'
  if (model.view.expanded) {
    if (available - FULL_DETAIL_ROWS >= 1) detail = 'full'
    else if (available - COMPACT_DETAIL_ROWS >= 1) detail = 'compact'
  }
  const taken = detail === 'full' ? FULL_DETAIL_ROWS : detail === 'compact' ? COMPACT_DETAIL_ROWS : 0
  return {
    tier, tooShort, header: { branch: tier !== 'narrow', commit: tier === 'wide' },
    counters, tabs, justWarned, historyTitle, notice, search, keys, list: { ...windowOf(model, available - taken), rows: available - taken }, detail,
  }
}
