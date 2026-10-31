import { expect, test } from 'bun:test'
import { layoutOf, PANE_MIN_LINES } from '../mod/layout.ts'
import { unreadableModel, type JustWarned, type PaneModel, type PaneRow } from '../src/core/pane.ts'

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

test('narrow and short: no branch, short counters inside the header, digit tabs', () => {
  expect(layoutOf(model(20), 40, 15)).toEqual({
    tier: 'narrow', tooShort: false, header: { branch: false, commit: false }, counters: 'in-header',
    tabs: 'digits', justWarned: false, historyTitle: true, list: { start: 0, count: 9, more: 11, rows: 11 }, detail: 'none',
  })
})

test('medium: branch, short counters, tab names', () => {
  expect(layoutOf(model(10, { warned: true }), 70, 30)).toEqual({
    tier: 'medium', tooShort: false, header: { branch: true, commit: false }, counters: 'short',
    tabs: 'names', justWarned: true, historyTitle: true, list: { start: 0, count: 10, more: 0, rows: 19 }, detail: 'none',
  })
})

test('wide: branch, commit and tile counters', () => {
  expect(layoutOf(model(10, { selected: 0, expanded: true }), 120, 50)).toEqual({
    tier: 'wide', tooShort: false, header: { branch: true, commit: true }, counters: 'tiles',
    tabs: 'names', justWarned: false, historyTitle: true, list: { start: 0, count: 10, more: 0, rows: 34 }, detail: 'full',
  })
})

test('below the minimum height only the one-line fallback is left', () => {
  expect(PANE_MIN_LINES).toBe(4)
  expect(layoutOf(model(10), 120, 3)).toEqual({
    tier: 'wide', tooShort: true, header: { branch: false, commit: false }, counters: 'in-header',
    tabs: 'digits', justWarned: false, historyTitle: false, list: { start: 0, count: 0, more: 10, rows: 0 }, detail: 'none',
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
  expect(layout.list.count).toBe(9)
  expect(layout.list.start).toBeLessThanOrEqual(35)
  expect(layout.list.start + layout.list.count).toBeGreaterThan(35)
  expect(layout.list.start).toBe(27)
  expect(layout.list.more).toBe(40 - 36)
  expect(layoutOf(model(40, { selected: 39 }), 70, 15).list.more).toBe(0)
})

test('header, tabs, counters, list, the more line and key bar fit the rows at 40x15', () => {
  const layout = layoutOf(model(20), 40, 15)
  // header + tabs (counters sit in the header) + history title + day label + records + more line + key bar
  const used = 1 + 1 + 0 + 1 + 1 + layout.list.count + (layout.list.more > 0 ? 1 : 0) + 1
  expect(used).toBeLessThanOrEqual(15)
})

test('day-group labels and the blank line between groups cost rows inside the window', () => {
  const groups = ['Today', 'Today', 'Yesterday', 'Yesterday', 'Monday', 'Monday']
  // 15 rows, in-header counters: 11 list rows. Today (1+2) + blank+Yesterday (2+2) + blank+Monday (2+2) = 11.
  expect(layoutOf(model(6, { groups }), 70, 15).list).toEqual({ start: 0, count: 6, more: 0, rows: 11 })
  expect(layoutOf(model(6, { groups }), 70, 14).list).toEqual({ start: 0, count: 4, more: 2, rows: 10 })
})

test('Just warned keeps its rows and the list gives way', () => {
  const plain = layoutOf(model(40), 70, 30)
  const warned = layoutOf(model(40, { warned: true }), 70, 30)
  expect(plain.list.count - warned.list.count).toBe(6)
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
  expect(layoutOf(model(0), 70, 30).list).toEqual({ start: 0, count: 0, more: 0, rows: 25 })
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
