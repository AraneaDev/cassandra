import { beforeAll, describe, expect, test } from 'bun:test'
import type { PaneModel } from '../src/core/pane.ts'

interface Node { type: string; props: Record<string, any>; children: any[] }
const g = globalThis as any
g.h = (type: string, props: Record<string, any> | null, ...children: any[]): Node => ({ type, props: props ?? {}, children: children.flat() })
g.Fragment = 'Fragment'
const el = { Box: 'Box', Text: 'Text', Button: 'Button' }

let drawPane: typeof import('../mod/pane.tsx').drawPane
let keys: typeof import('../mod/pane.tsx')
beforeAll(async () => {
  keys = await import('../mod/pane.tsx')
  drawPane = keys.drawPane
})

function walk(n: any, out: Node[] = []): Node[] {
  if (n && typeof n === 'object') {
    out.push(n)
    for (const c of n.children) walk(c, out)
  }
  return out
}
const text = (n: Node): string => n.children.map((c) => (typeof c === 'string' ? c : text(c))).join('')
const nodes = (m: PaneModel, cols = 100) => walk(drawPane(el, m, cols))
const lines = (m: PaneModel, cols = 100) => nodes(m, cols).filter((n) => n.type === 'Text').map(text)

const row = (id: string, stale = false) => ({ hash: id + 'ffffff', id, display: `npm test ${id}`, kind: 'failed' as const, count: 2, day: '10-09', stale })
const base: PaneModel = {
  rows: [row('aaaaaaaa'), row('bbbbbbbb', true)], more: 0, selected: 'aaaaaaaaffffff',
  detail: { reason: 'npm ERR! missing script: test', probe: 'git · nothing changed since', fix: 'use bun' },
  stats: null, confirmAll: false, total: 2, notice: null, error: null,
}

describe('drawPane', () => {
  test('one keyed Button per row, selected highlighted, stale dimmed', () => {
    const rows = nodes(base).filter((n) => n.type === 'Button' && String(n.props.key).startsWith(keys.ROW_KEY_PREFIX))
    expect(rows.map((r) => r.props.key)).toEqual(['row:aaaaaaaa', 'row:bbbbbbbb'])
    expect(text(rows[0]!)).toStartWith('▸')
    expect(text(rows[1]!)).not.toStartWith('▸')
    expect(rows[1]!.props.dimColor).toBe(true)
    expect(text(rows[1]!)).toEndWith('stale')
    expect(rows[0]!.props.dimColor).toBeFalsy()
  })

  test('every Button has onPress; only Box, Text, Button; text is a string', () => {
    const all = nodes({ ...base, confirmAll: true })
    for (const b of all.filter((n) => n.type === 'Button')) {
      expect(typeof b.props.onPress).toBe('function')
      expect(b.props.onPress()).toBeUndefined()
    }
    for (const n of all) expect(['Box', 'Text', 'Button']).toContain(n.type)
    for (const t of all.filter((n) => n.type === 'Text')) for (const c of t.children) expect(typeof c).toBe('string')
  })

  test('detail lines, and no fix line when null', () => {
    const l = lines(base)
    expect(l).toContain('reason (tool output) npm ERR! missing script: test')
    expect(lines({ ...base, detail: { ...base.detail!, reason: null } })).toContain('reason (none captured)')
    expect(l).toContain('probe git · nothing changed since')
    expect(l).toContain('fix use bun')
    const none = lines({ ...base, detail: { ...base.detail!, fix: null } })
    expect(none.some((x) => x.startsWith('fix '))).toBe(false)
  })

  test('forget buttons', () => {
    const b = nodes(base).filter((n) => n.type === 'Button')
    const f = b.find((x) => x.props.key === keys.KEY_FORGET)!
    const a = b.find((x) => x.props.key === keys.KEY_FORGET_ALL)!
    expect([text(f), f.props.hotkey]).toEqual(['Forget', 'f'])
    expect([text(a), a.props.hotkey]).toEqual(['Forget all', 'a'])
  })

  test('confirming swaps the buttons', () => {
    const b = nodes({ ...base, confirmAll: true }).filter((n) => n.type === 'Button')
    const keysSeen = b.map((x) => x.props.key)
    expect(keysSeen).toContain(keys.KEY_CONFIRM)
    expect(keysSeen).toContain(keys.KEY_CANCEL)
    expect(keysSeen).not.toContain(keys.KEY_FORGET)
    expect(keysSeen).not.toContain(keys.KEY_FORGET_ALL)
    expect(text(b.find((x) => x.props.key === keys.KEY_CONFIRM)!)).toBe('Forget all 2 records')
    expect(text(b.find((x) => x.props.key === keys.KEY_CANCEL)!)).toBe('Cancel')
  })

  test('the confirm button counts one record in the singular', () => {
    const b = nodes({ ...base, confirmAll: true, total: 1 }).filter((n) => n.type === 'Button')
    expect(text(b.find((x) => x.props.key === keys.KEY_CONFIRM)!)).toBe('Forget all 1 record')
  })

  test('stats are dimmed, more is a line, notice shows, keyed text sits in a Box', () => {
    const m = { ...base, stats: 'fp 4.2% · same_context 11.1%', more: 3, notice: 'Forgot 1.' }
    const t = nodes(m).filter((n) => n.type === 'Text')
    expect(t.find((x) => text(x) === 'fp 4.2% · same_context 11.1%')!.props.dimColor).toBe(true)
    expect(t.map(text)).toContain('…3 more')
    expect(t.map(text)).toContain('Forgot 1.')
    expect(nodes(base).filter((n) => n.type === 'Text').every((n) => n.props.key === undefined)).toBe(true)
  })

  test('empty and error', () => {
    const empty = { ...base, rows: [], detail: null, selected: null, total: 0 }
    expect(lines(empty)).toContain('Nothing remembered in this project.')
    expect(nodes(empty).some((n) => n.props.key === keys.KEY_FORGET)).toBe(false)
    const err = nodes({ ...empty, error: 'Cassandra could not read this project\'s store.' })
    expect(err.filter((n) => n.type === 'Text').map(text)).toEqual(['Cassandra could not read this project\'s store.'])
    expect(err.some((n) => n.type === 'Button')).toBe(false)
  })

  test('long displays are clipped with an ellipsis to fit the columns', () => {
    const long = { ...base, rows: [{ ...row('aaaaaaaa'), display: 'x'.repeat(200) }] }
    const r = nodes(long, 80).find((n) => n.props.key === 'row:aaaaaaaa')!
    expect(text(r).length).toBe(80)
    expect(text(r)).toEndWith(' failed 2× 10-09')
    expect(text(r)).toContain('…')
    const rule = lines(long, 40).find((x) => /^─+$/.test(x))!
    expect(rule.length).toBe(40)
  })

  test('at a narrow width nothing is wider than the columns: rows with marker and stale, the detail and the notice', () => {
    const narrow: PaneModel = {
      ...base,
      rows: [{ ...row('aaaaaaaa'), display: 'x'.repeat(200) }, { ...row('bbbbbbbb', true), display: 'y'.repeat(200) }],
      detail: { reason: 'r'.repeat(200), probe: 'p'.repeat(200), fix: 'f'.repeat(200) },
      stats: 'fp 4.2% · same_context 11.1% and more words here',
      notice: 'Could not remove some fix notes; check the permissions under /a/very/long/path/fixes.',
    }
    for (const cols of [30, 12]) {
      const all = nodes(narrow, cols)
      const drawn = [...all.filter((n) => n.type === 'Text'), ...all.filter((n) => n.type === 'Button' && String(n.props.key).startsWith('row:'))].map(text)
      for (const l of drawn) expect(l.length).toBeLessThanOrEqual(cols)
      expect(drawn.some((l) => l.startsWith('▸'))).toBe(true)
    }
    const stale = nodes(narrow, 60).find((n) => n.props.key === 'row:bbbbbbbb')!
    expect(text(stale).length).toBe(60)
    expect(text(stale)).toEndWith('stale')
  })

  test('the chrome around the rows is exactly PANE_CHROME_LINES lines when everything shows', () => {
    const full: PaneModel = { ...base, more: 5, stats: 'fp 1.0% · same_context 2.0%', notice: 'Could not forget the selected record.' }
    for (const m of [full, { ...full, confirmAll: true }]) {
      const all = nodes(m)
      const texts = all.filter((n) => n.type === 'Text').length
      const rows = all.filter((n) => n.type === 'Button' && String(n.props.key).startsWith('row:')).length
      const actionRows = all.filter((n) => n.props.key === 'action-row' || n.props.key === 'confirm-row').length
      expect(texts + actionRows).toBe(keys.PANE_CHROME_LINES)
      expect(rows).toBe(m.rows.length)
    }
  })
})
