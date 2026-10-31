import { sanitiseFull } from '../src/core/engine.ts'
import type { PaneDetail, PaneModel } from '../src/core/pane.ts'
import { visible, wrapCells } from './draw-text.ts'

/** How much width the pane has: decides what the header, counters and tabs show. */
export type Tier = 'narrow' | 'medium' | 'wide'

/** One line of a wrapped block: the label it starts with ('' on a continued line), and its text. */
export interface LabelledLine { label: string; text: string }

/** Cells the labels of the retest confirm take, before the call's own text. */
export const RETEST_LABEL_CELLS = 8
/** Least room for the call's text beside the labels; narrower, the confirm is not offered. */
const RETEST_MIN_TEXT = 12
/** Cells the full output is set in from the pane's inner edge, as the detail's lines are. */
export const FULL_INDENT_CELLS = 3

/** The cells set in from either edge of a pane `columns` wide, as the drawing frames it. */
export const padOf = (columns: number): number => Math.min(tierOf(columns) === 'narrow' ? 1 : 2, Math.floor(columns / 2))
/** The cells between the pane's insets. */
export const innerOf = (columns: number): number => Math.max(0, columns - 2 * padOf(columns))

/** `label` and then `text`, its lines and their overflow wrapped to `room` cells, each continued line unlabelled. */
function labelled(label: string, text: string, room: number): LabelledLine[] {
  return text.split('\n').flatMap((l) => wrapCells(l, room)).map((t, i) => ({ label: i === 0 ? label : '', text: t }))
}

/**
 * Every line the retest confirm shows for the call, wrapped to `inner` cells and never cut:
 * for Bash the exact command, the directory it runs from, and any other argument it takes;
 * for any other tool its name and its whole input, pretty-printed. Control characters show
 * as their pictures. Null when the pane is too narrow to show the call beside its labels.
 */
export function retestBody(retest: Extract<PaneDetail['retest'], { ok: true }>, inner: number): LabelledLine[] | null {
  const room = inner - RETEST_LABEL_CELLS
  if (room < RETEST_MIN_TEXT) return null
  const input = retest.input
  if (retest.tool === 'Bash' && input !== null && typeof input === 'object' && !Array.isArray(input) && typeof (input as { command?: unknown }).command === 'string') {
    // The description is the model's note to the person, not part of the call.
    const rest = Object.fromEntries(Object.entries(input).filter(([k]) => k !== 'command' && k !== 'description'))
    return [
      ...labelled('run', visible((input as { command: string }).command), room),
      ...labelled('in', visible(retest.cwd), room),
      ...(Object.keys(rest).length > 0 ? labelled('with', JSON.stringify(rest), room) : []),
    ]
  }
  return [
    ...labelled('tool', visible(retest.tool), room),
    ...labelled('input', JSON.stringify(input, null, 2) ?? String(input), room),
  ]
}

/** What the full output says of a record that kept none. */
export const FULL_NOT_KEPT = 'The full output was not kept for this record.'

/**
 * The marked record's full output as the pane draws it, wrapped to `inner` cells less the
 * indent: the stored, sanitised output (sanitised again, so a tab draws as spaces); a record
 * that kept none shows its excerpt and says so.
 */
export function fullBody(detail: PaneDetail, inner: number): string[] {
  const room = inner - FULL_INDENT_CELLS
  const text = detail.full === null
    ? `${detail.reason ?? '(no output captured)'}\n${FULL_NOT_KEPT}`
    : visible(sanitiseFull(detail.full).replace(/\t/g, '    '))
  return text.split('\n').flatMap((l) => wrapCells(l, room))
}

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
  /**
   * The retest confirm: drawn whole (`lines`, its title rule above them), or `too-small`
   * when the whole call does not fit, so the pane says so and offers no Run; null with no
   * retest waiting for the marked record.
   */
  retest: { lines: LabelledLine[] } | 'too-small' | null
  /** The open detail's full output: the first `lines` of it, and how many more a dim line counts; null when not shown. */
  full: { lines: string[]; more: number } | null
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
  fullDetail: 9, compactDetail: 3, retestTitle: 1, fullTitle: 1, fullMore: 1,
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
const RETEST_TITLE_ROWS = ROWS.retestTitle
const FULL_TITLE_ROWS = ROWS.fullTitle
const FULL_MORE_ROWS = ROWS.fullMore

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
      retest: null, full: null,
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
  // A retest waiting for the marked record shows the whole call, or is not offered at all.
  const pending = model.detail?.retest
  let retest: PaneLayout['retest'] = null
  if (pending?.ok === true && model.view.confirmRetest !== null && model.view.confirmRetest === model.selected) {
    const lines = retestBody(pending, innerOf(columns))
    retest = lines !== null && available - RETEST_TITLE_ROWS - lines.length >= 1 ? { lines } : 'too-small'
  }
  if (retest !== null && retest !== 'too-small') available -= RETEST_TITLE_ROWS + retest.lines.length
  // The notice takes its row from the list, as long as one list row is left. A retest too
  // big for the pane says so there.
  const notice = (Boolean(model.view.notice) || retest === 'too-small') && available - NOTICE_ROWS >= 1
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
  let taken = detail === 'full' ? FULL_DETAIL_ROWS : detail === 'compact' ? COMPACT_DETAIL_ROWS : 0
  // The full output opens under the detail: its title and as many lines as leave one list
  // row, the rest counted on a line of its own.
  let full: PaneLayout['full'] = null
  if (model.view.showFull && detail !== 'none' && model.detail !== null) {
    const body = fullBody(model.detail, innerOf(columns))
    const room = available - taken - FULL_TITLE_ROWS - 1
    const shown = body.length <= room ? body.length : room - FULL_MORE_ROWS
    if (shown >= 1) {
      full = { lines: body.slice(0, shown), more: body.length - shown }
      taken += FULL_TITLE_ROWS + shown + (full.more > 0 ? FULL_MORE_ROWS : 0)
    }
  }
  return {
    tier, tooShort, header: { branch: tier !== 'narrow', commit: tier === 'wide' },
    counters, tabs, justWarned, historyTitle, notice, search, keys, list: { ...windowOf(model, available - taken), rows: available - taken }, detail,
    retest, full,
  }
}
