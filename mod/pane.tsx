import type { PaneDetail, PaneModel, PaneRow, PaneTab } from '../src/core/pane.ts'
import { cells, fit, padTo, spaces } from './draw-text.ts'
import { FULL_INDENT_CELLS, RETEST_LABEL_CELLS, ROWS, fullDetailRows, padOf, type PaneLayout } from './layout.ts'

export { fit } from './draw-text.ts'

/** Key prefix of a row Button; the id follows. */
export const ROW_KEY_PREFIX = 'row:'
/** Key of the Forget button. */
export const KEY_FORGET = 'forget'
/** Key of the Forget all button. */
export const KEY_FORGET_ALL = 'forget-all'
/** Key of the button that confirms forgetting everything. */
export const KEY_CONFIRM = 'forget-all-confirm'
/** Key of the button that backs out of forgetting everything. */
export const KEY_CANCEL = 'forget-all-cancel'
/** Key prefix of a tab Button; the tab follows (`tab:history`). */
export const KEY_TAB_PREFIX = 'tab:'
/** Key of the Retest button. */
export const KEY_RETEST = 'retest'
/** Key of the button that runs the shown call again. */
export const KEY_RETEST_CONFIRM = 'retest-confirm'
/** Key of the button that backs out of a retest. */
export const KEY_RETEST_CANCEL = 'retest-cancel'
/** Key of the Full output button. */
export const KEY_FULL = 'full'
/** Key of the button that shows the full output's next page. */
export const KEY_NEXT_PAGE = 'next-page'
/** Key of the button that shows the full output's previous page. */
export const KEY_PREV_PAGE = 'prev-page'
/** Key of the button that dismisses the Just warned card. */
export const KEY_DISMISS = 'dismiss'
/** Key of the Search button. */
export const KEY_SEARCH = 'search'
/** Key of the button that shows the key list. */
export const KEY_HELP = 'help'
/** Key of the hidden twin whose `j` moves the marker down a row. */
export const KEY_DOWN = 'down'
/** Key of the hidden twin whose `k` moves the marker up a row. */
export const KEY_UP = 'up'
/** Key prefix of a tab's hidden twin, which carries its digit; the tab follows (`tabkey:warnings`). */
export const KEY_TABKEY_PREFIX = 'tabkey:'
/** Key prefix of the hidden twin of a key the bar had no room for; the key follows (`twin:help`). */
export const KEY_TWIN_PREFIX = 'twin:'
/** Key of the search field. */
export const KEY_SEARCH_FIELD = 'search-field'
/** Key of the button that clears the search. */
export const KEY_SEARCH_CLEAR = 'search-clear'

// Every colour is a Claude Code theme key, so the pane follows the person's theme.
/** Headings and the call's own text. */
const HEADING = 'text'
/** Secondary text: labels, times, notes. */
const SECONDARY = 'inactive'
/** Rules. */
const FAINT = 'subtle'
/** The active tab's ground. */
const ACCENT = 'suggestion'
/** The marked row's and its detail's ground. */
const MARKED_BG = 'userMessageBackground'
/** Card titles. */
const TITLE = 'claude'
/** Text on a solid fill: the status pill, the active tab, the exit chip. */
const ON_FILL = 'inverseText'
/** The footer key bar's ground. */
const BAR_BG = 'composerSidebarBackground'
const SUCCESS = 'success'
const WARNING = 'warning'
const ERROR = 'error'

/** The one line a body too short for the pane shows. */
const TOO_SHORT = 'Pane too short; make the window taller.'

/** The tabs in order, with the digit that names each on a narrow pane. */
const TABS: ReadonlyArray<{ id: PaneTab; name: string; digit: string }> = [
  { id: 'history', name: 'History', digit: '1' },
  { id: 'warnings', name: 'Warnings', digit: '2' },
  { id: 'stale', name: 'Stale', digit: '3' },
  { id: 'denied', name: 'Denied', digit: '4' },
]

/** An engine element constructor, called through the JSX factory. */
type Tag = (props: Record<string, unknown>) => unknown

/** The engine's elements, resolved from `$.ui.resolve`. */
export interface Elements { Box: unknown; Text: unknown; Button: unknown; Input?: unknown }

// A press does nothing here: the real actions run in `ui.press` hooks keyed by element key.
const noop = (): void => {}

/**
 * A run of text in one style; a Button when it carries `press` (out of sight when `hidden`,
 * there only for its hotkey); a text field `text`'s cells wide when it carries `field`.
 */
interface Seg {
  text: string; color?: string; bg?: string; bold?: boolean
  press?: { key: string; hotkey?: string; label?: string }; hidden?: true
  field?: { key: string; value: string; placeholder: string }
}
/** One drawn line: its segments across the pane, the ground under all of it, and the Button the whole line is. */
interface Line { key: string; segs: Seg[]; bg?: string; button?: string }

const width = (segs: readonly Seg[]): number => segs.reduce((n, s) => n + cells(s.text), 0)
const blankLine = (key: string): Line => ({ key, segs: [] })

/** A pressable segment: its text is what a plain Button draws, `k: label` with a hotkey. */
function key(id: string, label: string, hotkey?: string): Seg {
  return { text: hotkey === undefined ? label : `${hotkey}: ${label}`, press: { key: id, ...(hotkey === undefined ? {} : { hotkey }) } }
}

/** Segments cut to `room` cells: the text crossing the edge ends in `…`; a Button is never cut, it is dropped whole. */
function clip(segs: readonly Seg[], room: number): Seg[] {
  const out: Seg[] = []
  let used = 0
  for (const s of segs) {
    const w = cells(s.text)
    if (used + w <= room) {
      out.push(s)
      used += w
      continue
    }
    if (s.press === undefined && room - used > 0) out.push({ ...s, text: fit(s.text, room - used) })
    break
  }
  return out
}

/** `left`, then `right` against the right edge of `room`; without room for both, `left` alone, cut. */
function spread(left: Seg[], right: Seg[], room: number): Seg[] {
  const gap = room - width(left) - width(right)
  return gap >= 0 ? [...left, { text: spaces(gap) }, ...right] : clip(left, room)
}

/** `segs` joined by `gap` cells. */
const joined = (groups: Seg[][], gap: number): Seg[] => groups.flatMap((g, i) => (i === 0 ? g : [{ text: spaces(gap) }, ...g]))

/** How the pane is laid across its width: the cells either side, and the room between. */
interface Frame { columns: number; pad: number; inner: number }

/** A line of `segs` set in from either edge, cut and padded to exactly the pane's width. */
function line(f: Frame, key: string, segs: Seg[], over: Pick<Line, 'bg' | 'button'> = {}): Line {
  const body = clip(segs, f.inner)
  const all = [{ text: spaces(f.pad) }, ...body, { text: spaces(f.columns - f.pad - width(body)) }]
  return { key, segs: over.bg === undefined ? all : all.map((s) => (s.bg === undefined ? { ...s, bg: over.bg } : s)), ...over }
}

/** `lines` made exactly `n` long: blank lines added, or the last ones dropped. */
function exactly(f: Frame, prefix: string, lines: Line[], n: number, bg?: string): Line[] {
  const out = lines.slice(0, n)
  while (out.length < n) out.push(line(f, `${prefix}-pad-${out.length}`, [], bg === undefined ? {} : { bg }))
  return out
}

const SUPERSCRIPT = '⁰¹²³⁴⁵⁶⁷⁸⁹'
const superscript = (n: number): string => String(n).replace(/\d/g, (d) => SUPERSCRIPT[Number(d)]!)
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`
const two = (n: number): string => String(n).padStart(2, '0')

/** Local HH:MM of an ISO time; '' when it does not parse. */
function clock(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : `${two(d.getHours())}:${two(d.getMinutes())}`
}

/** Local MM-DD HH:MM of an ISO time; '' when it does not parse. */
function stamp(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : `${two(d.getMonth() + 1)}-${two(d.getDate())} ${clock(iso)}`
}

/**
 * A card's title set into a rule: `── ◷ History ───…─── 7 records ──`, the title in Claude's
 * orange, the rule faint. The note goes first when the width is short, then the rule.
 */
function titleRule(f: Frame, key: string, glyph: Seg, title: string, note: Seg[]): Line {
  const head: Seg[] = [{ text: '── ', color: FAINT }, glyph, { text: ' ' }, { text: title, color: TITLE, bold: true }, { text: ' ' }]
  const tail: Seg[] = note.length > 0 ? [{ text: ' ' }, ...note, { text: ' ──', color: FAINT }] : [{ text: '──', color: FAINT }]
  const withNote = f.inner - width(head) - width(tail)
  if (withNote >= 1) return line(f, key, [...head, { text: '─'.repeat(withNote), color: FAINT }, ...tail])
  const bare = f.inner - width(head)
  if (bare >= 1) return line(f, key, [...head, { text: '─'.repeat(bare), color: FAINT }])
  return line(f, key, [{ text: title, color: TITLE, bold: true }])
}

/** The status pill: how many records would warn now, on the error ground, or a calm state on success. */
function pill(model: PaneModel): Seg {
  const n = model.tabs.warnings
  return n > 0
    ? { text: ` ${n} would warn `, color: ON_FILL, bg: ERROR, bold: true }
    : { text: ' nothing would warn ', color: ON_FILL, bg: SUCCESS, bold: true }
}

/**
 * The header: the project in bold, its branch and short commit dim, the counters when the
 * pane is too short for their own row, and the status pill against the right edge. What
 * does not fit goes: the counters, then branch and commit; the project's name is cut last.
 */
function header(f: Frame, model: PaneModel, layout: PaneLayout): Line {
  const name: Seg = { text: model.project, color: HEADING, bold: true }
  const git: string[] = []
  if (model.git && layout.header.branch && model.git.branch) git.push(model.git.branch)
  if (model.git && (layout.header.commit || (layout.header.branch && !model.git.branch))) git.push(model.git.head)
  const gitSegs: Seg[] = git.length > 0 ? [{ text: '  ' }, { text: git.join(' · '), color: SECONDARY }] : []
  const status = pill(model)
  const room = f.inner - width([status]) - 1
  const counted = layout.counters === 'in-header' ? inHeaderCounters(model) : []
  const fits = (segs: Seg[]): boolean => width(segs) <= room
  // As many counters as fit, in order, after the name and its git, else after the name alone.
  for (const lead of [[name, ...gitSegs], [name]]) {
    if (!fits(lead)) continue
    const segs = [...lead]
    for (const c of counted) if (fits([...segs, { text: '  ' }, ...c])) segs.push({ text: '  ' }, ...c)
    return line(f, 'header', spread(segs, [status], f.inner))
  }
  if (room >= 1) return line(f, 'header', spread(clip([name], room), [status], f.inner))
  return line(f, 'header', [status])
}

/** The counters the header holds on a short pane: warn now is the pill already. */
function inHeaderCounters(model: PaneModel): Seg[][] {
  const c = model.counters
  return [figure(c.remembered, HEADING, 'remembered'), figure(c.warningsToday, WARNING, 'today'), figure(c.clearedByRetest, SUCCESS, 'cleared')]
}

/** A figure in bold, coloured only when it is not zero, and its label dim. */
function figure(n: number, color: string, label: string): Seg[] {
  return [{ text: String(n), bold: true, color: n > 0 ? color : HEADING }, { text: ` ${label}`, color: SECONDARY }]
}

/** A Button out of sight, there only for its hotkey: it takes no cells. */
const twin = (id: string, label: string, hotkey: string): Seg => ({ text: '', hidden: true, press: { key: id, hotkey, label } })

/**
 * The tabs: each with its count as a superscript, the active one on the accent ground. Digits
 * stand in for the others' names on a narrow pane. A plain Button with a hotkey draws `1: `
 * before its name, so each tab's digit rides on a hidden twin just before it, and so do `j`
 * and `k`, before the first tab; the focus hook moves the ring off a twin (`twinTarget`).
 */
function tabs(f: Frame, model: PaneModel, layout: PaneLayout): Line {
  const active = model.view.tab
  const groups = TABS.map((t, i): Seg[] => {
    const on = t.id === active
    const label = layout.tabs === 'names' || on ? t.name : t.digit
    const tab: Seg = {
      text: ` ${label}${superscript(model.tabs[t.id])} `,
      press: { key: `${KEY_TAB_PREFIX}${t.id}` },
      ...(on ? { color: ON_FILL, bg: ACCENT, bold: true } : { color: SECONDARY }),
    }
    const lead = i === 0 ? [twin(KEY_DOWN, 'Next row', 'j'), twin(KEY_UP, 'Previous row', 'k')] : []
    return [...lead, twin(`${KEY_TABKEY_PREFIX}${t.id}`, t.name, t.digit), tab]
  })
  return line(f, 'tabs', joined(groups, layout.tabs === 'names' ? 2 : 1))
}

/**
 * Where a focus ring headed for a hidden twin goes instead: onto the tab it sits before, or,
 * when the ring comes from that tab (a backward walk), onto the tab before it; null keeps the
 * ring where it is (backward past the first tab, or onto a bar key's twin). Undefined for any
 * element not a twin.
 */
export function twinTarget(element: string, focused: string | null): string | null | undefined {
  // A bar key's twin sits after every key the bar drew: the ring stops before it.
  if (element.startsWith(KEY_TWIN_PREFIX)) return null
  const id = element === KEY_DOWN || element === KEY_UP
    ? TABS[0]!.id
    : element.startsWith(KEY_TABKEY_PREFIX) ? element.slice(KEY_TABKEY_PREFIX.length) : null
  const at = TABS.findIndex((t) => t.id === id)
  if (at < 0) return undefined
  if (focused !== `${KEY_TAB_PREFIX}${TABS[at]!.id}`) return `${KEY_TAB_PREFIX}${TABS[at]!.id}`
  const before = element === KEY_DOWN || element === KEY_UP ? undefined : TABS[at - 1]
  return before === undefined ? null : `${KEY_TAB_PREFIX}${before.id}`
}

/** The four counters: a row of figures over a row of labels, then a blank line; or one short line. */
function counters(f: Frame, model: PaneModel, layout: PaneLayout): Line[] {
  const c = model.counters
  // Each counter's figure, colour, tile label, short label and narrow label.
  const all: Array<[number, string, string, string, string]> = [
    [c.warnNow, ERROR, 'warn now', 'warn now', 'warn'],
    [c.remembered, HEADING, 'remembered', 'remembered', 'kept'],
    [c.warningsToday, WARNING, 'warnings today', 'today', 'today'],
    [c.clearedByRetest, SUCCESS, 'cleared by retest', 'cleared', 'cleared'],
  ]
  if (layout.counters === 'short') {
    // A narrow pane tries the short labels, then shorter ones closer set, so all four stay whole.
    const tries: Array<[3 | 4, number]> = layout.tier === 'narrow' ? [[3, 3], [4, 2], [4, 1]] : [[3, 3]]
    const set = tries.map(([label, gap]) => joined(all.map((k) => figure(k[0], k[1], k[label])), gap))
    return [line(f, 'counters', set.find((segs) => width(segs) <= f.inner) ?? set[set.length - 1]!)]
  }
  if (layout.counters !== 'tiles') return []
  const slot = Math.floor(f.inner / all.length)
  const widths = all.map((_, i) => slot + (i < f.inner - slot * all.length ? 1 : 0))
  const figures = all.map(([n, color], i): Seg => ({ text: padTo(String(n), widths[i]!), bold: true, color: n > 0 ? color : HEADING }))
  const labels = all.map(([, , label], i): Seg => ({ text: padTo(fit(label, widths[i]! - 1), widths[i]!), color: SECONDARY }))
  return exactly(f, 'tiles', [line(f, 'tiles-figures', figures), line(f, 'tiles-labels', labels)], ROWS.tiles)
}

/** A label padded to its column, dim, then its value. */
const field = (label: string, labelWidth: number, value: Seg[]): Seg[] => [{ text: padTo(label, labelWidth), color: SECONDARY }, ...value]

/** The Just warned card: what was run, what it matched, why that failed, the evidence and the fix. */
function justWarned(f: Frame, model: PaneModel): Line[] {
  const w = model.justWarned
  if (w === null) return []
  const note: Seg[] = [{ text: clock(w.at), color: SECONDARY }, { text: ' ' }, key(KEY_DISMISS, 'Dismiss', 'd')]
  const lw = 10
  const lines = [
    titleRule(f, 'warned-title', { text: '!', color: WARNING, bold: true }, 'Just warned', note),
    line(f, 'warned-ran', field('you ran', lw, [{ text: w.display, color: HEADING }])),
    line(f, 'warned-matched', field('matched', lw, [{ text: `the same call, ${w.count}× before ` }, { text: `(last ${clock(w.lastSeen)})`, color: SECONDARY }])),
    line(f, 'warned-because', field('because', lw, [w.reason === null ? { text: '(no output captured)', color: SECONDARY } : { text: w.reason, color: ERROR }])),
    line(f, 'warned-evidence', field('still bad', lw, [{ text: w.evidence }])),
  ]
  if (w.fix) lines.push(line(f, 'warned-fix', field('fix', lw, [{ text: w.fix, color: SUCCESS }])))
  return exactly(f, 'warned', lines, ROWS.justWarned)
}

/** The least of the call's own text a row keeps before its suffix is cut with it. */
const MIN_DISPLAY = 4

/**
 * One record as a list row, exactly the pane wide: its state marker, time, the call with its
 * package suffix, and the tries with `stale` or `denied` against the right edge. The call
 * gives way first, so the marker, the time, the suffix and the tail stay whole while they can.
 */
function rowLine(f: Frame, r: PaneRow, marked: boolean, open: boolean): Line {
  const markColor = r.state === 'warns' ? ERROR : r.state === 'denied' ? WARNING : SECONDARY
  const head: Seg[] = [{ text: ` ${open ? '▾' : '▸'} `, color: markColor }, { text: `${r.time}  `, color: SECONDARY }]
  const tail: Seg[] = [{ text: ` ×${r.count}`, color: SECONDARY }]
  if (r.state === 'stale') tail.push({ text: '  stale', color: SECONDARY })
  if (r.state === 'denied') tail.push({ text: '  denied', color: WARNING })
  const room = f.inner - width(head) - width(tail)
  const callColor = r.state === 'stale' ? SECONDARY : HEADING
  let call: Seg[]
  if (room - cells(r.where) >= MIN_DISPLAY) {
    call = [{ text: fit(r.display, room - cells(r.where)), color: callColor }, { text: r.where, color: SECONDARY }]
  } else if (room >= MIN_DISPLAY) {
    call = [{ text: fit(`${r.display}${r.where}`, room), color: callColor }]
  } else {
    return line(f, `row-${r.id}`, [...head, { text: `${r.display}${r.where}`, color: callColor }], { button: `${ROW_KEY_PREFIX}${r.id}`, ...(marked ? { bg: MARKED_BG } : {}) })
  }
  return line(f, `row-${r.id}`, spread([...head, ...call], tail, f.inner), { button: `${ROW_KEY_PREFIX}${r.id}`, ...(marked ? { bg: MARKED_BG } : {}) })
}

/** The exit code as a chip, when the output began with one. */
const exitChip = (d: PaneDetail): Seg[] => (d.exitCode === null ? [] : [{ text: ` exit ${d.exitCode} `, color: ON_FILL, bg: ERROR, bold: true }, { text: '  ' }])
const reasonSeg = (d: PaneDetail): Seg => (d.reason === null ? { text: '(no output captured)', color: SECONDARY } : { text: d.reason, color: ERROR })
const warnsSeg = (d: PaneDetail): Seg => (d.warnsNow ? { text: 'yes', color: ERROR, bold: true } : { text: 'no', color: SUCCESS, bold: true })
const seenText = (d: PaneDetail): string => {
  const span = d.firstSeen === d.lastSeen ? stamp(d.lastSeen) : `${stamp(d.firstSeen)} → ${stamp(d.lastSeen)}`
  return `${span} · ${plural(d.tries, 'try', 'tries')}`
}

/**
 * The marked row opened in place, on the marked row's ground: why it failed, whether it
 * would warn now with the evidence then and now, when it was seen, which session, the fix.
 * Exactly the rows the layout gave it, full or compact.
 */
function detailLines(f: Frame, d: PaneDetail, size: 'full' | 'compact'): Line[] {
  const bg = { bg: MARKED_BG }
  const indent: Seg = { text: '   ' }
  const lw = 18
  const at = (k: string, segs: Seg[]): Line => line(f, `detail-${k}`, [indent, ...segs], bg)
  if (size === 'compact') {
    return exactly(f, 'detail', [
      at('why', field('why it failed', lw, [...exitChip(d), reasonSeg(d)])),
      at('warns', field('would it warn now', lw, [warnsSeg(d), { text: ` · now ${d.evidenceNow}` }])),
      at('seen', [...field('seen', 5, [{ text: seenText(d) }]), { text: '  ' }, ...field('session', 8, [{ text: d.session }])]),
    ], ROWS.compactDetail, MARKED_BG)
  }
  const lines = [
    at('why', field('why it failed', lw, exitChip(d))),
    at('reason', field('', lw, [reasonSeg(d)])),
    at('warns', field('would it warn now', lw, [warnsSeg(d)])),
    at('then', field('  then', lw, [{ text: d.evidenceThen }])),
    at('now', field('  now', lw, [{ text: d.evidenceNow }])),
    at('seen', field('seen', lw, [{ text: seenText(d) }])),
    at('session', field('session', lw, [{ text: d.session }])),
  ]
  if (d.fix) lines.push(at('fix', field('fix', lw, [{ text: d.fix, color: SUCCESS }])))
  if (!d.retest.ok) lines.push(at('retest', field('retest', lw, [{ text: NO_RETEST[d.retest.why], color: SECONDARY }])))
  return exactly(f, 'detail', lines, fullDetailRows(d), MARKED_BG)
}

/** Why the marked record offers no retest, as its detail says it. */
const NO_RETEST: Record<Extract<PaneDetail['retest'], { ok: false }>['why'], string> = {
  'denied': 'not offered for a denied call',
  'no-input': 'not possible: the call\'s input was not kept',
  'too-large': 'not possible: the call\'s input was too large to keep',
}

/**
 * The open detail's full output, on the marked row's ground: its title, the page of its lines
 * the layout gave it, blank lines filling a shorter last page to a whole one, and, when it
 * runs to more than one page, which lines of how many show.
 */
function fullLines(f: Frame, full: NonNullable<PaneLayout['full']>): Line[] {
  const bg = { bg: MARKED_BG }
  const indent: Seg = { text: spaces(FULL_INDENT_CELLS) }
  const range = `lines ${full.first + 1}–${full.first + full.lines.length} of ${full.total}`
  return [
    line(f, 'full-title', [indent, { text: 'full output', color: SECONDARY, bold: true }], bg),
    ...exactly(f, 'full', full.lines.map((t, i) => line(f, `full-${i}`, [indent, { text: t }], bg)), full.per, MARKED_BG),
    ...(full.pages > 1 ? [line(f, 'full-more', [indent, { text: range, color: SECONDARY }], bg)] : []),
  ]
}

/**
 * The retest confirm: its title rule, then the whole call as the layout wrapped it, each
 * label dim and the call's text plain. Run and Cancel are the key bar's.
 */
function retestLines(f: Frame, lines: NonNullable<Exclude<PaneLayout['retest'], 'too-small'>>['lines']): Line[] {
  const note: Seg[] = [{ text: 'runs through your permission settings', color: SECONDARY }]
  return [
    blankLine('retest-gap'),
    titleRule(f, 'retest-title', { text: '↻', color: WARNING, bold: true }, 'Retest', note),
    ...lines.map((l, i) => line(f, `retest-${i}`, [{ text: padTo(l.label, RETEST_LABEL_CELLS), color: SECONDARY }, { text: l.text, color: HEADING }])),
  ]
}

/** What a retest too big for the pane says in place of its confirm. */
export const RETEST_TOO_SMALL = 'Pane too small for the whole call; enlarge it.'

/** The notice the pane shows: a retest it cannot show whole, else the last action's. */
const noticeOf = (model: PaneModel, layout: PaneLayout): string | null =>
  layout.retest === 'too-small' ? RETEST_TOO_SMALL : model.view.notice

/**
 * The History card's list: the layout's window onto the rows, each day group under its bold
 * label with a blank line between groups, the marked row tinted and opened in place when
 * expanded, and `n more ↓` when records follow. Never more than the layout's rows: on the
 * tightest pane the first label goes, then the more line.
 */
function listLines(f: Frame, model: PaneModel, layout: PaneLayout): Line[] {
  const { start, count, more, rows } = layout.list
  if (model.rows.length === 0) {
    return [line(f, 'empty', [{ text: model.total === 0 ? 'Nothing remembered in this project.' : 'Nothing in this tab.', color: SECONDARY }])]
  }
  const shown = model.rows.slice(start, start + count)
  const cost = (labels: boolean, moreLine: boolean): number =>
    shown.reduce((n, r, i) => n + 1 + (i === 0 ? (labels ? 1 : 0) : r.group === shown[i - 1]!.group ? 0 : 2), 0) + (moreLine ? 1 : 0)
  let firstLabel = true
  let moreLine = more > 0
  if (cost(firstLabel, moreLine) > rows) firstLabel = false
  if (cost(firstLabel, moreLine) > rows) moreLine = false
  const open = model.view.expanded && layout.detail !== 'none' && model.detail !== null
  const out: Line[] = []
  shown.forEach((r, i) => {
    const prev = i === 0 ? null : shown[i - 1]!.group
    if (prev !== null && prev !== r.group) out.push(blankLine(`gap-${r.id}`))
    if ((i === 0 && firstLabel) || (prev !== null && prev !== r.group)) out.push(line(f, `group-${r.id}`, [{ text: r.group, color: HEADING, bold: true }]))
    const marked = r.hash === model.selected
    out.push(rowLine(f, r, marked, marked && open))
    if (marked && open) out.push(...detailLines(f, model.detail!, layout.detail as 'full' | 'compact'))
    if (marked && open && layout.full !== null) out.push(...fullLines(f, layout.full))
  })
  if (moreLine) out.push(line(f, 'more', [{ text: ` ${more} more ↓`, color: SECONDARY }]))
  return out
}

/** One key in the bar: its segment, and how much it matters when the bar is short of room (lower stays). */
interface BarKey { seg: Seg; keep: number }

/** The last action's notice on a row of its own, above the key bar. */
const noticeLine = (f: Frame, notice: string): Line => line(f, 'notice', [{ text: notice, color: WARNING }])

/**
 * The search row under the History title: the field, open and as wide as the row allows, or
 * the query it applied; either way with `x: Clear` against the right edge.
 */
function searchLine(f: Frame, model: PaneModel, search: 'field' | 'query'): Line {
  const label: Seg = { text: 'search  ', color: SECONDARY }
  const clear = [{ text: '  ' }, key(KEY_SEARCH_CLEAR, 'Clear', 'x')]
  const query = model.view.query
  if (search === 'query') return line(f, 'search', spread([label, { text: query, color: HEADING, bold: true }], clear, f.inner))
  // Too narrow for Clear as well: the field keeps the row, Clear goes.
  const withClear = f.inner - width([label]) - width(clear)
  const room = Math.max(1, withClear >= 1 ? withClear : f.inner - width([label]))
  const field: Seg = { text: spaces(room), field: { key: KEY_SEARCH_FIELD, value: query, placeholder: 'part of a call, then Enter' } }
  return line(f, 'search', [label, field, ...(withClear >= 1 ? clear : [])])
}

/** The History title's note: how many records it lists, and the search they match when no search row shows it. */
function historyNote(model: PaneModel, layout: PaneLayout): Seg[] {
  const count: Seg = { text: plural(model.rows.length, 'record', 'records'), color: SECONDARY }
  if (!model.view.query || layout.search !== null) return [count]
  return [count, { text: ' matching ', color: SECONDARY }, { text: model.view.query, color: HEADING, bold: true }]
}

/** The key list `h` opens, in the rows the layout gave it: its title, the rates, then the keys. */
function keyList(f: Frame, model: PaneModel, rows: number): Line[] {
  const title = titleRule(f, 'keys-title', { text: '?', color: SECONDARY }, 'Keys', [])
  const body = keyListRows(model).slice(0, rows - 1).map((t, i) => line(f, `keys-${i}`, [{ text: t, color: i === 0 ? SECONDARY : HEADING }]))
  return [title, ...body]
}

/**
 * The footer key bar on its faint ground. Normally the keys that act here, in order, the
 * ones that matter least left out when the width is short (their hotkeys kept on hidden
 * twins). While a Forget all waits for its answer, the confirm and Cancel; while a retest
 * does, Run (only under the whole call) and Cancel. A notice the layout gave no row of its own follows the keys.
 */
function keyBar(f: Frame, model: PaneModel, layout: PaneLayout): Line {
  const bg = { bg: BAR_BG }
  const text = noticeOf(model, layout)
  const notice: Seg[] = text && !layout.notice ? [{ text: '  ' }, { text, color: WARNING }] : []
  if (model.view.confirmAll && model.total > 0) {
    const confirm = key(KEY_CONFIRM, `Forget all ${plural(model.total, 'record', 'records')}`)
    return line(f, 'confirm-row', [...joined([[confirm], [key(KEY_CANCEL, 'Cancel')]], 2), ...notice], bg)
  }
  // A retest waiting for its answer: Run only when the whole call is drawn above.
  if (layout.retest !== null) {
    const run = layout.retest === 'too-small' ? [] : [[key(KEY_RETEST_CONFIRM, 'Run')]]
    return line(f, 'retest-row', [...joined([...run, [key(KEY_RETEST_CANCEL, 'Cancel')]], 2), ...notice], bg)
  }
  const retest = model.detail?.retest
  const keys: BarKey[] = []
  if (retest?.ok) keys.push({ seg: key(KEY_RETEST, 'Retest', 'r'), keep: 2 })
  if (model.selected !== null) keys.push({ seg: key(KEY_FORGET, 'Forget', 'f'), keep: 0 })
  if (model.total > 0) keys.push({ seg: key(KEY_FORGET_ALL, 'Forget all', 'a'), keep: 1 })
  if (model.detail !== null) keys.push({ seg: key(KEY_FULL, 'Full output', 'o'), keep: 4 })
  // Paging the full output, only towards a page there is.
  const full = layout.full
  if (full !== null && full.page < full.pages - 1) keys.push({ seg: key(KEY_NEXT_PAGE, 'Next page', 'n'), keep: 2.5 })
  if (full !== null && full.page > 0) keys.push({ seg: key(KEY_PREV_PAGE, 'Previous page', 'p'), keep: 2.5 })
  if (model.total > 0) keys.push({ seg: key(KEY_SEARCH, 'Search', 's'), keep: 5 })
  // A search applied where the pane has no row for it: clearing it stays in reach.
  if (model.view.query && layout.search === null) keys.push({ seg: key(KEY_SEARCH_CLEAR, 'Clear search', 'x'), keep: 1.5 })
  keys.push({ seg: key(KEY_HELP, 'Keys', 'h'), keep: 3 })
  const kept = new Set<BarKey>()
  let used = 0
  for (const k of [...keys].sort((a, b) => a.keep - b.keep)) {
    const w = cells(k.seg.text) + (kept.size > 0 ? 2 : 0)
    if (used + w > f.inner) continue
    kept.add(k)
    used += w
  }
  const segs = joined(keys.filter((k) => kept.has(k)).map((k) => [k.seg]), 2)
  // A key left out keeps its hotkey on a hidden twin, so a narrow pane still answers it.
  const twins = keys.filter((k) => !kept.has(k)).map(({ seg: { text, press } }) =>
    twin(`${KEY_TWIN_PREFIX}${press!.key}`, text.slice(press!.hotkey!.length + 2), press!.hotkey!))
  return line(f, 'action-row', [...segs, ...twins, ...notice], bg)
}

/**
 * The rows of the key list `h` opens: the warning rates first, so they stay in reach without
 * a tile of their own, then every key and what it does.
 */
export function keyListRows(model: PaneModel): string[] {
  return [
    model.rates ?? 'No warning raised yet, so no rates.',
    '1–4    switch tabs',
    'j k    move the marker (or the arrows)',
    'Enter  open or close the marked row',
    'r      retest the marked call (asks first)',
    'f      forget the marked record',
    'a      forget every record (asks first)',
    'o      the marked record\'s full output',
    'n p    the next or previous page of the full output',
    's      search the calls; Enter applies it',
    'x      clear the search',
    'd      dismiss the Just warned card',
    'h      show or hide this list',
  ]
}

/**
 * Neighbouring text segments joined, so a line is few Texts: two of one style, or a run of
 * blanks and its neighbour on the same ground (a blank cell looks alike in any colour).
 */
function merged(segs: readonly Seg[]): Seg[] {
  const out: Seg[] = []
  const style = (s: Seg): string => JSON.stringify([s.color ?? null, s.bg ?? null, s.bold ?? false])
  const blank = (s: Seg): boolean => /^ *$/.test(s.text)
  // A Button or a field is an element of its own: never joined, never dropped for drawing no text.
  const own = (s: Seg): boolean => s.press !== undefined || s.field !== undefined
  for (const s of segs) {
    if (s.text === '' && !own(s)) continue
    const last = out[out.length - 1]
    if (last === undefined || own(last) || own(s) || last.bg !== s.bg) {
      out.push(s)
    } else if (style(last) === style(s) || blank(s)) {
      out[out.length - 1] = { ...last, text: last.text + s.text }
    } else if (blank(last)) {
      out[out.length - 1] = { ...s, text: last.text + s.text }
    } else {
      out.push(s)
    }
  }
  return out
}

/** The props a segment's Text is drawn with. */
const textProps = (s: Seg): Record<string, unknown> => ({
  wrap: 'truncate-end',
  ...(s.color === undefined ? {} : { color: s.color }),
  ...(s.bg === undefined ? {} : { backgroundColor: s.bg }),
  ...(s.bold ? { bold: true } : {}),
})

/**
 * Draws the pane as an element tree, top to bottom: header, tabs, counters, the Just warned
 * card, the History card and the key bar, each in exactly the rows `layout` budgets, every
 * line exactly `columns` cells so nothing wraps. Pure: no I/O. Buttons carry a no-op
 * `onPress` and are told apart by key; keyed text sits in a keyed Box, because Text drops
 * its key. A store that cannot be read, or a body shorter than the pane's least, draws one line.
 */
export function drawPane(el: Elements, model: PaneModel, columns: number, layout: PaneLayout): unknown {
  const Box = el.Box as Tag
  const Text = el.Text as Tag
  const Button = el.Button as Tag
  // Mobile draws no text field: there the search shows what it holds as text.
  const Input = el.Input as Tag | undefined

  const one = (s: string): unknown => <Box flexDirection="column"><Text wrap="truncate-end">{fit(s, columns)}</Text></Box>
  if (model.error) return one(model.error)
  if (layout.tooShort) return one(TOO_SHORT)

  const pad = padOf(columns)
  const f: Frame = { columns, pad, inner: Math.max(0, columns - 2 * pad) }
  const glyph: Seg = { text: '◷', color: SECONDARY }
  const tab = TABS.find((t) => t.id === model.view.tab)?.name ?? 'History'
  const lines: Line[] = [
    header(f, model, layout),
    tabs(f, model, layout),
    ...counters(f, model, layout),
    ...(layout.justWarned ? justWarned(f, model) : []),
    ...(layout.historyTitle ? [titleRule(f, 'history-title', glyph, tab, historyNote(model, layout))] : []),
    ...(layout.search === null ? [] : [searchLine(f, model, layout.search)]),
    ...listLines(f, model, layout),
    ...(layout.keys > 0 ? keyList(f, model, layout.keys) : []),
    ...(layout.retest !== null && layout.retest !== 'too-small' ? retestLines(f, layout.retest.lines) : []),
    ...(layout.notice && noticeOf(model, layout) ? [noticeLine(f, noticeOf(model, layout)!)] : []),
    keyBar(f, model, layout),
  ]

  const drawSeg = (s: Seg): unknown => {
    if (s.field !== undefined) {
      const room = cells(s.text)
      const shown = padTo(fit(s.field.value, room), room)
      return (
        <Box key={`${s.field.key}-box`} width={room} flexShrink={0} overflow="hidden">
          {Input === undefined
            ? <Text {...textProps({ text: shown, color: HEADING })}>{shown}</Text>
            : <Input key={s.field.key} value={s.field.value} placeholder={s.field.placeholder} submitLabel="search" onSubmit={noop} />}
        </Box>
      )
    }
    if (s.press !== undefined && s.hidden) {
      return (
        <Box key={`${s.press.key}-twin`} display="none">
          <Button key={s.press.key} plain label={s.press.label} {...(s.press.hotkey === undefined ? {} : { hotkey: s.press.hotkey })} onPress={noop} />
        </Box>
      )
    }
    return s.press === undefined
      ? <Text {...textProps(s)}>{s.text}</Text>
      : (
          <Button key={s.press.key} plain {...(s.press.hotkey === undefined ? {} : { hotkey: s.press.hotkey })} onPress={noop}>
            {s.press.hotkey === undefined ? <Text {...textProps(s)}>{s.text}</Text> : s.text.slice(s.press.hotkey.length + 2)}
          </Button>
        )
  }
  const drawLine = (l: Line): unknown => {
    const segs = merged(l.segs.length > 0 ? l.segs : [{ text: spaces(columns), ...(l.bg === undefined ? {} : { bg: l.bg }) }])
    const body = l.button === undefined
      ? segs.map(drawSeg)
      : <Button key={l.button} plain onPress={noop}>{segs.map((s) => <Text {...textProps(s)}>{s.text}</Text>)}</Button>
    return (
      <Box key={l.key} flexDirection="row" width={columns} overflow="hidden" {...(l.bg === undefined ? {} : { backgroundColor: l.bg })}>
        {body}
      </Box>
    )
  }
  return (
    <Box key="cassandra-pane" flexDirection="column">
      {lines.map(drawLine)}
    </Box>
  )
}
