import { describe, expect, test } from 'bun:test'
import { turnedPage, type DrawnPane } from '../mod/drawn.ts'
import { visible, wrapCells } from '../mod/draw-text.ts'
import { FULL_NOT_KEPT, fullBody, fullDetailRows, layoutOf, PANE_MIN_LINES, retestBody, ROWS } from '../mod/layout.ts'
import { unreadableModel, type JustWarned, type PaneDetail, type PaneModel, type PaneRow } from '../src/core/pane.ts'

const row = (i: number, group = 'Today'): PaneRow => ({ hash: `h${i}`, id: `id${i}`, display: `cmd ${i}`, where: '', state: 'warns', count: 1, time: '10:00', group })

function model(n: number, over: { selected?: number; expanded?: boolean; warned?: boolean; groups?: string[] } = {}): PaneModel {
  const base = unreadableModel()
  const rows = Array.from({ length: n }, (_, i) => row(i, over.groups?.[i] ?? 'Today'))
  const warned: JustWarned = { hash: 'h0', at: 'x', display: 'cmd', count: 1, lastSeen: 'x', reason: null, evidence: '', fix: null }
  return {
    ...base, rows, selected: over.selected === undefined ? null : `h${over.selected}`,
    justWarned: over.warned ? warned : null, view: { ...base.view, expanded: over.expanded ?? false },
  }
}

test('narrow and short: no branch, short counters inside the header, digit tabs, no blank row before a card', () => {
  expect(layoutOf(model(20), 40, 15)).toEqual({
    tier: 'narrow', tooShort: false, height: 15, gaps: false, header: { branch: false, commit: false }, counters: 'in-header',
    tabs: 'digits', justWarned: false, historyTitle: true, historyGap: true, notice: false, search: null, keys: 0, list: { start: 0, count: 8, more: 12, rows: 10 }, detail: 'none', retest: null, full: null,
  })
})

test('medium: branch, the counter band, tab names, a blank row before each card', () => {
  // 30 rows less header, the head spacing's 4, tabs, the band's 4, the key bar, and gap, title and blank of History: 16; Just warned takes its gap and 7.
  expect(layoutOf(model(10, { warned: true }), 70, 30)).toEqual({
    tier: 'medium', tooShort: false, height: 30, gaps: true, header: { branch: true, commit: false }, counters: 'tiles',
    tabs: 'names', justWarned: true, historyTitle: true, historyGap: true, notice: false, search: null, keys: 0, list: { start: 0, count: 6, more: 4, rows: 8 }, detail: 'none', retest: null, full: null,
  })
})

test('wide: branch, commit and the counter band', () => {
  expect(layoutOf(model(10, { selected: 0, expanded: true }), 120, 50)).toEqual({
    tier: 'wide', tooShort: false, height: 50, gaps: true, header: { branch: true, commit: true }, counters: 'tiles',
    tabs: 'names', justWarned: false, historyTitle: true, historyGap: true, notice: false, search: null, keys: 0, list: { start: 0, count: 10, more: 0, rows: 27 }, detail: 'full', retest: null, full: null,
  })
})

test('narrow and tall: the counters keep their one short line', () => {
  expect(layoutOf(model(10), 40, 50).counters).toBe('short')
  expect(layoutOf(model(10), 55, 50).counters).toBe('short')
  expect(layoutOf(model(10), 56, 50).counters).toBe('tiles')
})

test('the counter band costs four rows: its top edge, figures, labels and bottom edge', () => {
  expect(ROWS.tiles).toBe(4)
  // Tall medium against short medium: the band, and the blank rows before the History card.
  expect(layoutOf(model(0), 70, 22).list.rows).toBe(22 - 1 - ROWS.headSpacing - 1 - ROWS.tiles - 1 - ROWS.cardGap - ROWS.historyTitle - ROWS.titleGap)
  expect(layoutOf(model(0), 70, 21).list.rows).toBe(21 - 1 - 1 - 1 - ROWS.historyTitle - ROWS.titleGap)
})

test('every card title has a blank row under it, budgeted from the list', () => {
  // At the least height that still has a title, the blank row under it gives way to the one list row.
  const least = layoutOf(model(10), 70, PANE_MIN_LINES + 1)
  expect([least.historyTitle, least.historyGap, least.list.rows]).toEqual([true, false, 1])
  const roomy = layoutOf(model(10), 70, PANE_MIN_LINES + 2)
  expect([roomy.historyTitle, roomy.historyGap, roomy.list.rows]).toEqual([true, true, 1])
})

test('the layout carries the pane height, so the drawing can end the pane in the key bar', () => {
  for (const rows of [PANE_MIN_LINES, 8, 15, 22, 50]) expect(layoutOf(model(2), 70, rows).height).toBe(rows)
})

test('below the minimum height only the one-line fallback is left', () => {
  expect(PANE_MIN_LINES).toBe(4)
  expect(layoutOf(model(10), 120, 3)).toEqual({
    tier: 'wide', tooShort: true, height: 3, gaps: false, header: { branch: false, commit: false }, counters: 'in-header',
    tabs: 'digits', justWarned: false, historyTitle: false, historyGap: false, notice: false, search: null, keys: 0, list: { start: 0, count: 0, more: 10, rows: 0 }, detail: 'none', retest: null, full: null,
  })
})

test('the width tiers switch at 56 and 100 columns', () => {
  expect(layoutOf(model(1), 55, 30).tier).toBe('narrow')
  expect(layoutOf(model(1), 56, 30).tier).toBe('medium')
  expect(layoutOf(model(1), 99, 30).tier).toBe('medium')
  expect(layoutOf(model(1), 100, 30).tier).toBe('wide')
})

test('the window follows the selection', () => {
  const layout = layoutOf(model(40, { selected: 35 }), 70, 15)
  expect(layout.list.count).toBe(8)
  expect(layout.list.start).toBeLessThanOrEqual(35)
  expect(layout.list.start + layout.list.count).toBeGreaterThan(35)
  expect(layout.list.start).toBe(28)
  expect(layout.list.more).toBe(40 - 36)
  expect(layoutOf(model(40, { selected: 39 }), 70, 15).list.more).toBe(0)
})

test('header, tabs, counters, list, the more line and key bar fit the rows at 40x15', () => {
  const layout = layoutOf(model(20), 40, 15)
  // header + tabs (counters sit in the header) + history title and the blank under it + day label + records + more line + key bar
  const used = 1 + 1 + 0 + 2 + 1 + layout.list.count + (layout.list.more > 0 ? 1 : 0) + 1
  expect(used).toBeLessThanOrEqual(15)
})

test('day-group labels and the blank line between groups cost rows inside the window', () => {
  const groups = ['Today', 'Today', 'Yesterday', 'Yesterday', 'Monday', 'Monday']
  // 16 rows, in-header counters: 11 list rows. Today (1+2) + blank+Yesterday (2+2) + blank+Monday (2+2) = 11.
  expect(layoutOf(model(6, { groups }), 70, 16).list).toEqual({ start: 0, count: 6, more: 0, rows: 11 })
  expect(layoutOf(model(6, { groups }), 70, 15).list).toEqual({ start: 0, count: 4, more: 2, rows: 10 })
})

test('Just warned keeps its rows and the list gives way', () => {
  const plain = layoutOf(model(40), 70, 30)
  const warned = layoutOf(model(40, { warned: true }), 70, 30)
  // Its rows, and the blank row before it.
  expect(plain.list.count - warned.list.count).toBe(ROWS.cardGap + ROWS.justWarned)
  // without room for it next to one list row, the card is dropped
  expect(layoutOf(model(40, { warned: true }), 70, 8).justWarned).toBe(false)
})

test('an expanded detail on a short pane drops to compact before the list loses its last row', () => {
  const full = layoutOf(model(40, { selected: 0, expanded: true }), 70, 30)
  expect(full.detail).toBe('full')
  const compact = layoutOf(model(40, { selected: 0, expanded: true }), 70, 12)
  expect(compact.detail).toBe('compact')
  expect(compact.list.count).toBeGreaterThanOrEqual(1)
  const none = layoutOf(model(40, { selected: 0, expanded: true }), 70, 5)
  expect(none.detail).toBe('none')
  expect(none.list.count).toBeGreaterThanOrEqual(1)
})

test('an empty list has an empty window', () => {
  expect(layoutOf(model(0), 70, 30).list).toEqual({ start: 0, count: 0, more: 0, rows: 16 })
})

test('a notice takes its own row from the list, while one list row is left', () => {
  const m = (notice: string | null) => ({ ...model(20), view: { ...model(20).view, notice } })
  const plain = layoutOf(m(null), 40, 15)
  const noticed = layoutOf(m('Could not forget the selected record.'), 40, 15)
  expect([plain.notice, noticed.notice]).toEqual([false, true])
  expect(plain.list.rows - noticed.list.rows).toBe(1)
  expect(layoutOf(m('x'), 40, PANE_MIN_LINES).notice).toBe(false)
  expect(layoutOf(m('x'), 40, PANE_MIN_LINES + 1).notice).toBe(false)
  expect(layoutOf(m('x'), 40, PANE_MIN_LINES + 2).notice).toBe(false)
  expect(layoutOf(m('x'), 40, PANE_MIN_LINES + 3).notice).toBe(true)
})

test('at the minimum height the History title gives its row to the one list row', () => {
  const least = layoutOf(model(10), 70, PANE_MIN_LINES)
  expect([least.historyTitle, least.list]).toEqual([false, { start: 0, count: 1, more: 9, rows: 1 }])
  const one = layoutOf(model(10), 70, PANE_MIN_LINES + 1)
  expect([one.historyTitle, one.list]).toEqual([true, { start: 0, count: 1, more: 9, rows: 1 }])
})

test('an unknown selection windows from the top', () => {
  const m = model(40)
  m.selected = 'gone'
  expect(layoutOf(m, 70, 15).list.start).toBe(0)
})

test('an open search field or an applied query takes one row from the list, before the notice', () => {
  const extras = { searching: true, showKeys: false, keyRows: 0, fullPage: 0 }
  const open = layoutOf(model(20), 70, 30, extras)
  expect(open.search).toBe('field')
  expect(open.list.rows).toBe(layoutOf(model(20), 70, 30).list.rows - 1)
  const applied = model(20)
  expect(layoutOf({ ...applied, view: { ...applied.view, query: 'bun' } }, 70, 30).search).toBe('query')
  // With one list row left, neither takes it.
  expect(layoutOf(model(20), 70, 5, extras).search).toBeNull()
})

test('the key list takes its title and rows from the list, leaves one list row, and is not drawn as a bare title', () => {
  const keys = (rows: number) => layoutOf(model(20), 70, rows, { searching: false, showKeys: true, keyRows: 12, fullPage: 0 })
  // Its 12 rows under the blank row before it, its title and the blank under that.
  expect(keys(40).keys).toBe(ROWS.cardGap + ROWS.keysTitle + ROWS.titleGap + 12)
  expect(keys(40).list.rows).toBe(layoutOf(model(20), 70, 40).list.rows - keys(40).keys)
  expect(keys(12).keys).toBe(layoutOf(model(20), 70, 12).list.rows - 1)
  expect(keys(12).list.rows).toBe(1)
  // Room for the title alone: no key list.
  expect(keys(6).keys).toBe(0)
  expect(layoutOf(model(20), 70, 40, { searching: false, showKeys: false, keyRows: 12, fullPage: 0 }).keys).toBe(0)
})

test('wrapCells cuts by cells and loses nothing; visible draws control characters as pictures', () => {
  expect(wrapCells('abcdefg', 3)).toEqual(['abc', 'def', 'g'])
  expect(wrapCells('', 3)).toEqual([''])
  expect(wrapCells('日本語', 3)).toEqual(['日', '本', '語'])
  expect(wrapCells('日本語x', 4).join('')).toBe('日本語x')
  expect(visible('a\u001b[2Jb\tc\nd\u007f')).toBe('a␛[2Jb␉c\nd␡')
})

test('retestBody: Bash shows the command, its directory and any other argument; other tools their input', () => {
  const bash = retestBody({ ok: true, tool: 'Bash', input: { command: 'bun test', description: 'run it', timeout: 5 }, cwd: '/p' }, 40)
  expect(bash).toEqual([{ label: 'run', text: 'bun test' }, { label: 'in', text: '/p' }, { label: 'with', text: '{"timeout":5}' }])
  const mcp = retestBody({ ok: true, tool: 'mcp__s__t', input: { a: 1 }, cwd: '/p' }, 40)
  expect(mcp).toEqual([{ label: 'tool', text: 'mcp__s__t' }, { label: 'input', text: '{' }, { label: '', text: '  "a": 1' }, { label: '', text: '}' }])
  // A Bash input without a command string is shown whole, as any other tool's.
  expect(retestBody({ ok: true, tool: 'Bash', input: { cmd: 1 }, cwd: '/p' }, 40)![0]).toEqual({ label: 'tool', text: 'Bash' })
  expect(retestBody({ ok: true, tool: 'Bash', input: { command: 'x' }, cwd: '/p' }, 19)).toBeNull()
})

test('fullBody wraps the stored output with tabs as spaces; without it, the excerpt and a note', () => {
  const d = { full: 'a\tb\n' + 'x'.repeat(25), reason: 'boom' } as PaneDetail
  expect(fullBody(d, 13)).toEqual(['a    b', 'xxxxxxxxxx', 'xxxxxxxxxx', 'xxxxx'])
  expect(fullBody({ ...d, full: null }, 100)).toEqual(['boom', FULL_NOT_KEPT])
  expect(fullBody({ ...d, full: null, reason: null }, 100)[0]).toBe('(no output captured)')
})

test('the confirm shows DEL and C1 characters in a stored argument as visible text, never raw', () => {
  const input = { q: 'a\u007fb\u009bc' }
  const mcp = retestBody({ ok: true, tool: 'mcp__s__t', input, cwd: '/p' }, 60)!
  expect(mcp.map((l) => l.text).join('\n')).toContain('"q": "a␡b\\u009bc"')
  const bash = retestBody({ ok: true, tool: 'Bash', input: { command: 'x', env: '\u0085' }, cwd: '/p' }, 60)!
  expect(bash.at(-1)).toEqual({ label: 'with', text: '{"env":"\\u0085"}' })
  for (const l of [...mcp, ...bash]) expect(l.text).not.toMatch(/[\u007f-\u009f]/)
  expect(visible('\u0080\u009f')).toBe('\\u0080\\u009f')
})

test('an open detail takes the rows its lines need, no padding to the most it can take', () => {
  const d: PaneDetail = {
    exitCode: 1, reason: 'boom', full: null, warnsNow: true, evidenceThen: 'x', evidenceNow: 'x',
    firstSeen: 'x', lastSeen: 'x', tries: 1, session: 's', fix: null, retest: { ok: true, tool: 'Bash', input: { command: 'cmd 0' }, cwd: '/p' },
  }
  expect(fullDetailRows(d)).toBe(7)
  expect(fullDetailRows({ ...d, fix: 'f' })).toBe(8)
  expect(fullDetailRows({ ...d, fix: 'f', retest: { ok: false, why: 'denied' } })).toBe(ROWS.fullDetail)
  const open = { ...model(10, { selected: 0, expanded: true }), detail: d }
  const closed = { ...open, view: { ...open.view, expanded: false } }
  expect(layoutOf(closed, 120, 50).list.rows - layoutOf(open, 120, 50).list.rows).toBe(7)
})

test('the retest confirm budgets a blank row above its title', () => {
  const d: PaneDetail = {
    exitCode: 1, reason: 'boom', full: null, warnsNow: true, evidenceThen: 'x', evidenceNow: 'x',
    firstSeen: 'x', lastSeen: 'x', tries: 1, session: 's', fix: null, retest: { ok: true, tool: 'Bash', input: { command: 'cmd 0' }, cwd: '/p' },
  }
  const base = { ...model(10, { selected: 0 }), detail: d }
  const asking = { ...base, view: { ...base.view, confirmRetest: 'h0' } }
  const layout = layoutOf(asking, 70, 30)
  expect(layout.retest).not.toBeNull()
  expect(layout.retest).not.toBe('too-small')
  const lines = (layout.retest as { lines: unknown[] }).lines.length
  expect(layoutOf(base, 70, 30).list.rows - layout.list.rows).toBe(ROWS.retestGap + ROWS.retestTitle + ROWS.titleGap + lines)
})

describe('paging the full output', () => {
  const d: PaneDetail = {
    exitCode: 1, reason: 'boom', full: Array.from({ length: 60 }, (_, i) => `out ${i}`).join('\n'), warnsNow: true, evidenceThen: 'x', evidenceNow: 'x',
    firstSeen: 'x', lastSeen: 'x', tries: 1, session: 's', fix: null, retest: { ok: true, tool: 'Bash', input: { command: 'cmd 0' }, cwd: '/p' },
  }
  const base = model(10, { selected: 0, expanded: true })
  const showing = { ...base, detail: d, view: { ...base.view, showFull: true } }
  const at = (fullPage: number, detail: PaneDetail = d) =>
    layoutOf({ ...showing, detail }, 70, 30, { searching: false, showKeys: false, keyRows: 0, fullPage }).full!

  test('each page windows the next lines, and the last page holds what is left', () => {
    const first = at(0)
    const per = first.lines.length
    expect(per).toBeGreaterThan(1)
    expect(per).toBeLessThan(60)
    expect(first).toEqual({ lines: Array.from({ length: per }, (_, i) => `out ${i}`), first: 0, total: 60, page: 0, pages: Math.ceil(60 / per), per })
    expect(at(1).lines).toEqual(Array.from({ length: per }, (_, i) => `out ${per + i}`))
    expect(at(1).first).toBe(per)
    const pages = first.pages
    const last = at(pages - 1)
    expect(last.page).toBe(pages - 1)
    expect(last.first).toBe((pages - 1) * per)
    expect(last.lines).toEqual(Array.from({ length: 60 - (pages - 1) * per }, (_, i) => `out ${(pages - 1) * per + i}`))
    expect(last.lines.length).toBeGreaterThan(0)
  })

  test('a page past either end clamps to the first or the last, never an empty window', () => {
    const pages = at(0).pages
    expect(at(-3)).toEqual(at(0))
    expect(at(pages)).toEqual(at(pages - 1))
    expect(at(999).lines.length).toBeGreaterThan(0)
  })

  test('output that fits is one page; without extras the first page shows', () => {
    const small = at(4, { ...d, full: 'one\ntwo' })
    expect(small).toEqual({ lines: ['one', 'two'], first: 0, total: 2, page: 0, pages: 1, per: 2 })
    expect(layoutOf(showing, 70, 30).full).toEqual(at(0))
  })

  test('the list keeps the rows the page does not take: the paged block costs its title, its lines and the note', () => {
    const closed = layoutOf({ ...showing, view: { ...showing.view, showFull: false } }, 70, 30)
    const page = layoutOf(showing, 70, 30)
    expect(closed.list.rows - page.list.rows).toBe(ROWS.fullTitle + ROWS.titleGap + page.full!.lines.length + ROWS.fullMore)
  })

  test('every page takes the rows of a whole page, the shorter last one too, so the list keeps the same rows', () => {
    const per = at(0).lines.length
    // One line past two whole pages: the last page holds a single line.
    const odd = { ...d, full: Array.from({ length: 2 * per + 1 }, (_, i) => `out ${i}`).join('\n') }
    const laid = (fullPage: number) => layoutOf({ ...showing, detail: odd }, 70, 30, { searching: false, showKeys: false, keyRows: 0, fullPage })
    const first = laid(0)
    const last = laid(2)
    expect(first.full!.pages).toBe(3)
    expect(last.full!.lines).toEqual([`out ${2 * per}`])
    expect(first.full!.per).toBe(per)
    expect(last.full!.per).toBe(per)
    expect(last.list.rows).toBe(first.list.rows)
    const closed = layoutOf({ ...showing, detail: odd, view: { ...showing.view, showFull: false } }, 70, 30)
    expect(closed.list.rows - last.list.rows).toBe(ROWS.fullTitle + ROWS.titleGap + per + ROWS.fullMore)
  })

  test('output on one page takes only its own lines', () => {
    const small = layoutOf({ ...showing, detail: { ...d, full: 'one\ntwo' } }, 70, 30)
    const closed = layoutOf({ ...showing, detail: { ...d, full: 'one\ntwo' }, view: { ...showing.view, showFull: false } }, 70, 30)
    expect(small.full!.per).toBe(2)
    expect(closed.list.rows - small.list.rows).toBe(ROWS.fullTitle + ROWS.titleGap + 2)
  })
})

test('a page that is not a number never sticks while turning', () => {
  const drawn = { fullPages: 4 } as DrawnPane
  expect(turnedPage(drawn, Number.NaN, 1)).toBe(1)
  expect(turnedPage(drawn, Number.NaN, -1)).toBe(0)
  expect(turnedPage(drawn, 1.7, 1)).toBe(2)
})
