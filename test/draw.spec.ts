import { beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFix } from '../src/core/fixes.ts'
import { fingerprint } from '../src/core/fingerprint.ts'
import { stateStamp } from '../src/core/freshness.ts'
import { paneModel, unreadableModel, type PaneDetail, type PaneModel, type PaneRow, type PaneView } from '../src/core/pane.ts'
import { pathsFor } from '../src/core/paths.ts'
import { upsertRecord } from '../src/core/record.ts'
import { nodeIo } from '../src/io/node.ts'
import type { Io } from '../src/core/io.ts'
import { cells, padTo } from '../mod/draw-text.ts'
import { fullDetailRows, layoutOf, PANE_MIN_LINES, ROWS } from '../mod/layout.ts'

interface Node { type: string; props: Record<string, any>; children: any[] }
const g = globalThis as any
g.h = (type: string, props: Record<string, any> | null, ...children: any[]): Node => ({ type, props: props ?? {}, children: children.flat() })
g.Fragment = 'Fragment'
const el = { Box: 'Box', Text: 'Text', Button: 'Button' }

let pane: typeof import('../mod/pane.tsx')
beforeAll(async () => {
  pane = await import('../mod/pane.tsx')
})

function walk(n: any, out: Node[] = []): Node[] {
  if (n && typeof n === 'object') {
    out.push(n)
    for (const c of n.children) walk(c, out)
  }
  return out
}
const text = (n: Node): string => n.children.map((c) => (typeof c === 'string' ? c : text(c))).join('')
/** What a line draws: a plain Button with a hotkey draws `k: ` before its label; a `display="none"` Box nothing. */
const drawnText = (n: Node): string => {
  if (n.type === 'Box' && n.props.display === 'none') return ''
  const own = n.children.map((c) => (typeof c === 'string' ? c : drawnText(c))).join('')
  return n.type === 'Button' && n.props.hotkey ? `${n.props.hotkey}: ${own}` : own
}

const NOW = new Date()
const iso = (minutesAgo: number): string => new Date(NOW.getTime() - minutesAgo * 60_000).toISOString()
const row = (i: number, over: Partial<PaneRow> = {}): PaneRow => ({
  hash: `${String(i).padStart(8, '0')}ffffffff`, id: String(i).padStart(8, '0'), display: `bun test case-${i}`, where: '',
  state: 'warns', count: 2, time: '12:39', group: 'Today', ...over,
})
const detail: PaneDetail = {
  exitCode: 1, reason: 'Expected: "git"  Received: "mtime"', full: 'line one\nline two', warnsNow: true,
  evidenceThen: 'HEAD 0cc107b, working tree clean', evidenceNow: 'HEAD 0cc107b, working tree clean',
  firstSeen: iso(40), lastSeen: iso(2), tries: 3, session: 'in this session', fix: 'Use bun run test instead.',
  retest: { ok: true, tool: 'Bash', input: { command: 'bun test case-0' }, cwd: '/p' },
}
function model(over: Partial<PaneModel> = {}, view: Partial<PaneView> = {}): PaneModel {
  const base = unreadableModel()
  const rows = over.rows ?? [row(0), row(1), row(2, { state: 'stale', group: 'Yesterday' }), row(3, { state: 'denied', group: 'Last week' })]
  return {
    ...base, error: null, project: 'cassandra', git: { branch: 'ci/release-please', head: '0cc107b' },
    tabs: { history: rows.length, warnings: 2, stale: 1, denied: 1 },
    counters: { warnNow: 2, remembered: rows.length, warningsToday: 3, clearedByRetest: 1 },
    rates: 'fp 4.0% · same_context 12.5%', rows, selected: rows[0]?.hash ?? null, detail: rows.length > 0 ? detail : null,
    total: rows.length, hashes: rows.map((r) => r.hash), ...over, view: { ...base.view, ...view },
  }
}
const warned = { hash: '00000000ffffffff', at: iso(1), display: 'bun test case-0', count: 3, lastSeen: iso(2), reason: 'boom', evidence: 'Repository unchanged since: HEAD 0cc107b, the same working tree clean.', fix: null }

/** The pane drawn at a size, through its own layout, as nodes and as its lines. */
function draw(m: PaneModel, columns: number, rows: number) {
  const layout = layoutOf(m, columns, rows)
  const root = pane.drawPane(el, m, columns, layout) as Node
  const lines = root.children as Node[]
  return { root, all: walk(root), lines, texts: lines.map(drawnText), layout }
}
const buttons = (all: Node[]) => all.filter((n) => n.type === 'Button')
const byKey = (all: Node[], key: string) => all.find((n) => n.props.key === key)

const SIZES: Array<[number, number]> = [[40, 15], [70, 30], [120, 50]]

describe('drawPane', () => {
  test('every line is exactly the pane wide and the pane never outgrows its rows, at every size', () => {
    const many = Array.from({ length: 40 }, (_, i) => row(i, { group: ['Today', 'Yesterday', 'Monday'][Math.floor(i / 14)]!, display: `bun run test --filter case-${i} ${'x'.repeat(i * 3)}`, where: i % 5 === 0 ? ' (in packages/a)' : '' }))
    const variants = [
      model({ rows: many, hashes: many.map((r) => r.hash), total: 40 }),
      model({ rows: many, total: 40, justWarned: warned, selected: many[20]!.hash }, { expanded: true, notice: 'Could not forget the selected record.' }),
      model({ rows: many, total: 40 }, { confirmAll: true }),
    ]
    for (const m of variants) {
      for (const [columns, rows] of [...SIZES, [24, 8], [56, 22], [99, 21], [100, 22], [160, 60]] as Array<[number, number]>) {
        for (let r = PANE_MIN_LINES; r <= rows; r++) {
          const { texts } = draw(m, columns, r)
          expect(texts.length).toBeLessThanOrEqual(r)
          for (const t of texts) expect(cells(t)).toBe(columns)
        }
      }
    }
  })

  test('at the four-row minimum, Just warned with an open row draws within its rows at the exact width', () => {
    const m = model({ justWarned: warned }, { expanded: true })
    for (const columns of [24, 40, 70, 120]) {
      const { texts } = draw(m, columns, PANE_MIN_LINES)
      expect(texts.length).toBeGreaterThan(0)
      expect(texts.length).toBeLessThanOrEqual(PANE_MIN_LINES)
      for (const t of texts) expect(cells(t)).toBe(columns)
    }
  })

  test('a full list fills its rows exactly', () => {
    const many = Array.from({ length: 40 }, (_, i) => row(i))
    for (const [columns, rows] of SIZES) {
      const m = model({ rows: many, total: 40, justWarned: warned }, { expanded: true })
      expect(draw(m, columns, rows).texts).toHaveLength(rows)
    }
  })

  test('narrow shows tab digits and no branch; medium tab names and branch; wide the commit too', () => {
    const narrow = draw(model(), 40, 15)
    expect(narrow.texts[0]).not.toContain('ci/release-please')
    expect(narrow.texts[1]).toContain(' History⁴ ')
    expect(narrow.texts[1]).toContain(' 2² ')
    expect(narrow.texts[1]).not.toContain('Warnings')
    const medium = draw(model(), 70, 30)
    expect(medium.texts[0]).toContain('ci/release-please')
    expect(medium.texts[0]).not.toContain('0cc107b')
    expect(medium.texts[1]).toContain('Warnings²')
    const wide = draw(model(), 120, 50)
    expect(wide.texts[0]).toContain('ci/release-please · 0cc107b')
    expect(wide.texts[1]).toMatch(/History⁴ +Warnings² +Stale¹ +Denied¹/)
  })

  test('the header: the project bold, the status pill against the right edge in a status colour', () => {
    const { lines, texts } = draw(model(), 70, 30)
    const name = walk(lines[0]!).find((n) => n.type === 'Text' && text(n).includes('cassandra'))!
    expect([name.props.bold, name.props.color]).toEqual([true, 'text'])
    expect(texts[0]).toEndWith(' 2 would warn   ')
    const pill = walk(lines[0]!).find((n) => n.type === 'Text' && text(n) === ' 2 would warn ')!
    expect([pill.props.backgroundColor, pill.props.color]).toEqual(['error', 'inverseText'])
    const calm = draw(model({ tabs: { history: 4, warnings: 0, stale: 4, denied: 0 } }), 70, 30)
    const ok = walk(calm.lines[0]!).find((n) => n.type === 'Text' && text(n) === ' nothing would warn ')!
    expect(ok.props.backgroundColor).toBe('success')
  })

  test('tabs are keyed Buttons, the active one on the accent ground', () => {
    const { all } = draw(model({}, { tab: 'stale' }), 120, 50)
    const tabs = buttons(all).filter((b) => String(b.props.key).startsWith(pane.KEY_TAB_PREFIX))
    expect(tabs.map((b) => b.props.key)).toEqual(['tab:history', 'tab:warnings', 'tab:stale', 'tab:denied'])
    const on = walk(tabs[2]!).find((n) => n.type === 'Text')!
    expect(on.props.backgroundColor).toBe('suggestion')
    expect(walk(tabs[0]!).find((n) => n.type === 'Text')!.props.backgroundColor).toBeUndefined()
    // The card is titled after the tab it lists.
    expect(draw(model({}, { tab: 'stale' }), 120, 50).texts.some((t) => t.includes('◷ Stale'))).toBe(true)
  })

  test('counters: tiles when wide and tall, one short line when medium, in the header when short', () => {
    const wide = draw(model(), 120, 50)
    expect(wide.texts[2]).toMatch(/^ {2}2 +4 +3 +1 +$/)
    expect(wide.texts[3]).toMatch(/warn now +remembered +warnings today +cleared by retest/)
    expect(wide.texts[4]!.trim()).toBe('')
    const medium = draw(model(), 70, 30)
    expect(medium.texts[2]).toContain('2 warn now   4 remembered   3 today   1 cleared')
    const short = draw(model(), 70, 15)
    expect(short.texts[0]).toContain('4 remembered')
    expect(short.texts[2]).toContain('◷ History')
  })

  test('card titles are set into a faint rule, the title in Claude orange, the note at the end', () => {
    const { lines, texts } = draw(model(), 70, 30)
    const at = texts.findIndex((t) => t.includes('History ─'))
    expect(texts[at]).toMatch(/^ {2}── ◷ History ─+ 4 records ── {2}$/)
    const title = walk(lines[at]!).find((n) => n.type === 'Text' && text(n).trim() === 'History')!
    expect([title.props.color, title.props.bold]).toEqual(['claude', true])
    expect(walk(lines[at]!).find((n) => n.type === 'Text' && text(n).startsWith('──'))!.props.color).toBe('subtle')
  })

  test('the Just warned card takes its seven rows: what ran, what matched, because, still bad, the fix, a blank', () => {
    const m = model({ justWarned: { ...warned, fix: 'Use bun run test.' } })
    const { texts, all } = draw(m, 70, 30)
    const at = texts.findIndex((t) => t.includes('! Just warned'))
    expect(texts[at]).toContain('d: Dismiss ──')
    expect(texts.slice(at + 1, at + ROWS.justWarned - 1).map((t) => t.trim().split(/\s{2,}| /)[0])).toEqual(['you', 'matched', 'because', 'still', 'fix'])
    expect(texts[at + 1]).toContain('bun test case-0')
    expect(texts[at + 2]).toContain('the same call, 3× before')
    expect(texts[at + ROWS.justWarned - 1]!.trim()).toBe('')
    expect(texts[at + ROWS.justWarned]).toContain('◷ History')
    expect(byKey(all, pane.KEY_DISMISS)?.props.hotkey).toBe('d')
    // Without a fix note, blank lines keep the card's rows.
    const plain = draw(model({ justWarned: warned }), 70, 30).texts
    const top = plain.findIndex((t) => t.includes('! Just warned'))
    expect(plain.slice(top + 5, top + ROWS.justWarned).map((t) => t.trim())).toEqual(['', ''])
    expect(plain[top + ROWS.justWarned]).toContain('◷ History')
  })

  test('day groups under bold labels, a blank line between them, the marked row tinted', () => {
    const { lines, texts, all } = draw(model(), 70, 30)
    const label = (name: string) => texts.findIndex((t) => t.trim() === name)
    expect(label('Today')).toBeGreaterThan(0)
    expect(texts[label('Yesterday') - 1]!.trim()).toBe('')
    expect(texts[label('Last week') - 1]!.trim()).toBe('')
    expect(walk(lines[label('Today')]!).find((n) => n.type === 'Text' && text(n).includes('Today'))!.props.bold).toBe(true)
    const rows = buttons(all).filter((b) => String(b.props.key).startsWith(pane.ROW_KEY_PREFIX))
    expect(rows.map((r) => r.props.key)).toEqual(['row:00000000', 'row:00000001', 'row:00000002', 'row:00000003'])
    const tint = (b: Node) => walk(b).filter((n) => n.type === 'Text').every((n) => n.props.backgroundColor === 'userMessageBackground')
    expect(rows.map(tint)).toEqual([true, false, false, false])
    expect(text(rows[2]!)).toMatch(/×2 {2}stale +$/)
    expect(text(rows[3]!)).toMatch(/×2 {2}denied +$/)
    expect(text(rows[0]!)).toMatch(/^ {2} ▸ 12:39 {2}bun test case-0 +×2 +$/)
  })

  test('an expanded row opens in place: why it failed, would it warn now, seen, session and the fix', () => {
    const { texts, lines } = draw(model({}, { expanded: true }), 120, 50)
    const at = texts.findIndex((t) => t.includes('▾ 12:39'))
    const block = texts.slice(at + 1, at + 1 + fullDetailRows(detail))
    for (const label of ['why it failed', 'would it warn now', 'seen', 'session', 'fix']) expect(block.some((t) => t.includes(label))).toBe(true)
    expect(block[0]).toContain(' exit 1 ')
    expect(block[1]).toContain('Expected: "git"  Received: "mtime"')
    expect(block[2]).toContain('yes')
    expect(block.some((t) => t.includes('3 tries'))).toBe(true)
    expect(texts[at + 1 + fullDetailRows(detail)]).toContain('▸')
    for (const l of lines.slice(at + 1, at + 1 + fullDetailRows(detail))) expect(l.props.backgroundColor).toBe('userMessageBackground')
    // Compact on a shorter pane: three rows, every label still there.
    const short = draw(model({}, { expanded: true }), 70, 12)
    expect(short.layout.detail).toBe('compact')
    const c = short.texts.findIndex((t) => t.includes('▾'))
    const compact = short.texts.slice(c + 1, c + 1 + ROWS.compactDetail).join('\n')
    for (const label of ['why it failed', 'would it warn now', 'seen', 'session']) expect(compact).toContain(label)
    // Not expanded: no detail at all.
    expect(draw(model(), 120, 50).texts.some((t) => t.includes('why it failed'))).toBe(false)
  })

  test("a denial's detail offers no retest; a call with its input stored does", () => {
    const denied = model({ detail: { ...detail, retest: { ok: false, why: 'denied' } } }, { expanded: true })
    expect(byKey(draw(denied, 120, 50).all, pane.KEY_RETEST)).toBeUndefined()
    const ok = byKey(draw(model(), 120, 50).all, pane.KEY_RETEST)!
    expect([text(ok), ok.props.hotkey]).toEqual(['Retest', 'r'])
  })

  test('the key bar: Forget and Forget all with f and a, on its faint ground', () => {
    const { all, lines, texts } = draw(model(), 70, 30)
    const f = byKey(all, pane.KEY_FORGET)!
    const a = byKey(all, pane.KEY_FORGET_ALL)!
    expect([text(f), f.props.hotkey]).toEqual(['Forget', 'f'])
    expect([text(a), a.props.hotkey]).toEqual(['Forget all', 'a'])
    const bar = lines.at(-1)!
    expect([bar.props.key, bar.props.backgroundColor]).toEqual(['action-row', 'composerSidebarBackground'])
    expect(texts.at(-1)).toContain('r: Retest  f: Forget  a: Forget all  o: Full output  h: Keys')
    expect(draw(model(), 120, 50).texts.at(-1)).toContain('r: Retest  f: Forget  a: Forget all  o: Full output  s: Search  h: Keys')
    // Narrow, the keys that matter least give way; Forget and Forget all stay.
    const narrow = draw(model(), 40, 15).texts.at(-1)!
    expect(narrow).toContain('f: Forget  a: Forget all')
    expect(narrow).not.toContain('Search')
  })

  test('confirming Forget all swaps the keys for the exact count and Cancel', () => {
    const b = buttons(draw(model({}, { confirmAll: true }), 70, 30).all)
    const keysSeen = b.map((x) => x.props.key)
    expect(keysSeen).toContain(pane.KEY_CONFIRM)
    expect(keysSeen).not.toContain(pane.KEY_FORGET)
    expect(text(byKey(b, pane.KEY_CONFIRM)!)).toBe('Forget all 4 records')
    expect(text(byKey(b, pane.KEY_CANCEL)!)).toBe('Cancel')
    const one = model({ rows: [row(0)], total: 1, hashes: [row(0).hash] }, { confirmAll: true })
    expect(text(byKey(draw(one, 70, 30).all, pane.KEY_CONFIRM)!)).toBe('Forget all 1 record')
  })

  test('the full output opens under the detail, windowed to the pane with a count of the rest', () => {
    const full = Array.from({ length: 60 }, (_, i) => `out ${i}`).join('\n')
    const { texts, layout } = draw(model({ detail: { ...detail, full } }, { expanded: true, showFull: true }), 70, 30)
    expect(texts).toHaveLength(30)
    expect(layout.full!.pages).toBeGreaterThan(1)
    expect(texts.some((t) => t.trim() === 'full output')).toBe(true)
    expect(texts.some((t) => t.trim() === `lines 1–${layout.full!.lines.length} of 60`)).toBe(true)
    for (const t of texts) expect(cells(t)).toBe(70)
    // All of it when it fits, and no count.
    const small = draw(model({ detail: { ...detail, full: 'one\ntwo' } }, { expanded: true, showFull: true }), 70, 30)
    expect(small.layout.full).toEqual({ lines: ['one', 'two'], first: 0, total: 2, page: 0, pages: 1 })
    expect(small.texts.some((t) => /lines \d/.test(t))).toBe(false)
  })

  describe('paging the full output', () => {
    const full = Array.from({ length: 60 }, (_, i) => `out ${i}`).join('\n')
    const paged = (fullPage: number, columns = 70, over: Partial<PaneView> = {}) => {
      const m = model({ detail: { ...detail, full } }, { expanded: true, showFull: true, ...over })
      const layout = layoutOf(m, columns, 30, { searching: false, showKeys: false, keyRows: 0, fullPage })
      const root = pane.drawPane(el, m, columns, layout) as Node
      const lines = root.children as Node[]
      return { all: walk(root), texts: lines.map(drawnText), layout }
    }
    const barKeys = (all: Node[]) => buttons(all).map((b) => String(b.props.key))

    test('the note counts the lines shown of the whole, on every page, each line the pane wide', () => {
      const { layout } = paged(0)
      const per = layout.full!.lines.length
      const last = layout.full!.pages - 1
      for (const [page, from, to] of [[0, 1, per], [1, per + 1, 2 * per], [last, last * per + 1, 60]] as const) {
        const { texts } = paged(page)
        expect(texts.some((t) => t.trim() === `lines ${from}–${to} of 60`)).toBe(true)
        expect(texts.some((t) => t.trim() === `out ${from - 1}`)).toBe(true)
        for (const t of texts) expect(cells(t)).toBe(70)
      }
    })

    test('n shows only when a next page exists, p only when a previous one does', () => {
      // Offered: drawn in the bar, or kept on a hidden twin when the bar has no room.
      const offered = (all: Node[]) => barKeys(all).map((k) => k.replace(pane.KEY_TWIN_PREFIX, ''))
      const last = paged(0).layout.full!.pages - 1
      expect(offered(paged(0).all)).toContain(pane.KEY_NEXT_PAGE)
      expect(offered(paged(0).all)).not.toContain(pane.KEY_PREV_PAGE)
      expect(offered(paged(1).all)).toEqual(expect.arrayContaining([pane.KEY_NEXT_PAGE, pane.KEY_PREV_PAGE]))
      expect(offered(paged(last).all)).toContain(pane.KEY_PREV_PAGE)
      expect(offered(paged(last).all)).not.toContain(pane.KEY_NEXT_PAGE)
      // With room for both, the bar draws them.
      const wide = paged(1, 160).texts.at(-1)!
      expect(wide).toContain('n: Next page')
      expect(wide).toContain('p: Previous page')
      // No paging keys while the full output is closed, or when it fits on one page.
      expect(offered(paged(0, 70, { showFull: false }).all).filter((k) => k.endsWith('-page'))).toEqual([])
      const small = model({ detail: { ...detail, full: 'one' } }, { expanded: true, showFull: true })
      expect(offered(draw(small, 70, 30).all).filter((k) => k.endsWith('-page'))).toEqual([])
    })

    test('dropped for width, the paging keys keep their hotkeys on hidden twins', () => {
      const { all, texts } = paged(1, 24)
      for (const t of texts) expect(cells(t)).toBe(24)
      const next = byKey(all, `${pane.KEY_TWIN_PREFIX}${pane.KEY_NEXT_PAGE}`)
      const prev = byKey(all, `${pane.KEY_TWIN_PREFIX}${pane.KEY_PREV_PAGE}`)
      expect(next?.props.hotkey).toBe('n')
      expect(prev?.props.hotkey).toBe('p')
    })
  })

  test('a pending retest for the marked row draws its whole call above Run and Cancel', () => {
    const { all, texts, layout } = draw(model({}, { confirmRetest: row(0).hash }), 70, 30)
    expect(layout.retest).not.toBeNull()
    expect(layout.retest).not.toBe('too-small')
    expect(texts.some((t) => t.includes('Retest'))).toBe(true)
    expect(byKey(all, pane.KEY_RETEST_CONFIRM)).toBeDefined()
    expect(byKey(all, pane.KEY_RETEST_CANCEL)).toBeDefined()
    expect(byKey(all, 'retest-row')).toBeDefined()
    for (const t of texts) expect(cells(t)).toBe(70)
  })

  test('a pending retest for another row than the marked one draws nothing', () => {
    const { all, layout } = draw(model({}, { confirmRetest: 'not-the-marked-row' }), 70, 30)
    expect(layout.retest).toBeNull()
    expect(byKey(all, pane.KEY_RETEST_CONFIRM)).toBeUndefined()
    expect(byKey(all, 'action-row')).toBeDefined()
  })

  test('a notice gets its own row above the key bar, whole at 40 columns, and the pane stays its height', () => {
    const notice = 'Could not forget the selected record.'
    const many = Array.from({ length: 20 }, (_, i) => row(i))
    const { texts, lines } = draw(model({ rows: many, total: 20 }, { notice }), 40, 15)
    expect(texts).toHaveLength(15)
    expect(texts.at(-2)).toBe(` ${notice} `.padEnd(40))
    expect(texts.at(-2)).toContain(notice)
    expect(lines.at(-2)!.props.key).toBe('notice')
    expect(texts.at(-1)).not.toContain('Could not')
    for (const t of texts) expect(cells(t)).toBe(40)
    // Where the layout has no row for it, it follows the keys in the bar.
    const least = draw(model({}, { notice: 'Forgot 1.' }), 120, PANE_MIN_LINES)
    expect(least.layout.notice).toBe(false)
    expect(least.texts.at(-1)).toContain('h: Keys  Forgot 1.')
  })

  test('more records below the window end the list with n more ↓; the tightest pane drops it, then the label and the title', () => {
    const many = Array.from({ length: 20 }, (_, i) => row(i))
    const m = model({ rows: many, total: 20 })
    const tall = draw(m, 70, 15)
    expect(tall.texts.at(-2)).toMatch(/^ {3}\d+ more ↓ +$/)
    expect(tall.texts.at(-2)).toContain(`${tall.layout.list.more} more ↓`)
    const least = draw(m, 70, PANE_MIN_LINES).texts
    expect(least).toHaveLength(PANE_MIN_LINES)
    expect(least.some((t) => t.includes('more ↓') || t.includes('◷') || t.trim() === 'Today')).toBe(false)
    const five = draw(m, 70, PANE_MIN_LINES + 1).texts
    expect(five.some((t) => t.includes('◷ History'))).toBe(true)
    expect(five.some((t) => t.includes('more ↓') || t.trim() === 'Today')).toBe(false)
  })

  test('the package suffix stays and the call gives way; nothing is wider than the pane', () => {
    const r = row(0, { display: 'bun run test --coverage --watch', where: ' (in packages/a)' })
    const m = model({ rows: [r], total: 1 })
    const narrow = text(byKey(draw(m, 40, 15).all, 'row:00000000')!)
    expect(cells(narrow)).toBe(40)
    expect(narrow).toBe('  ▸ 12:39  bun run … (in packages/a) ×2 ')
    expect(text(byKey(draw(m, 120, 50).all, 'row:00000000')!)).toContain('bun run test --coverage --watch (in packages/a)')
    for (const columns of [24, 12]) for (const t of draw(m, columns, 15).texts) expect(cells(t)).toBe(columns)
  })

  test('empty, the error line, and the too-short line', () => {
    const empty = model({ rows: [], total: 0, hashes: [], selected: null, detail: null })
    const drawn = draw(empty, 70, 30)
    expect(drawn.texts.some((t) => t.trim() === 'Nothing remembered in this project.')).toBe(true)
    expect(byKey(drawn.all, pane.KEY_FORGET)).toBeUndefined()
    expect(byKey(drawn.all, pane.KEY_FORGET_ALL)).toBeUndefined()
    const err = draw(unreadableModel(), 70, 30)
    expect(err.all.filter((n) => n.type === 'Text').map(text)).toEqual(["Cassandra could not read this project's store."])
    expect(buttons(err.all)).toEqual([])
    for (let r = 1; r < PANE_MIN_LINES; r++) {
      const short = draw(model(), 70, r)
      expect(short.all.filter((n) => n.type === 'Text').map(text)).toEqual(['Pane too short; make the window taller.'])
      expect(buttons(short.all)).toEqual([])
    }
    expect(draw(model(), 10, 3).all.filter((n) => n.type === 'Text').map(text)[0]).toBe('Pane too …')
  })

  test('every Button has onPress; only Box, Text and Button; Text holds strings; no prop is undefined', () => {
    const all = draw(model({ justWarned: warned }, { expanded: true, notice: 'n' }), 120, 50).all
    for (const b of buttons(all)) {
      expect(typeof b.props.onPress).toBe('function')
      expect(b.props.onPress()).toBeUndefined()
    }
    for (const n of all) {
      expect(['Box', 'Text', 'Button']).toContain(n.type)
      for (const v of Object.values(n.props)) expect(v).not.toBeUndefined()
    }
    for (const t of all.filter((n) => n.type === 'Text')) for (const c of t.children) expect(typeof c).toBe('string')
    const colours = new Set(all.flatMap((n) => [n.props.color, n.props.backgroundColor]).filter((c) => c !== undefined))
    const theme = ['text', 'inactive', 'subtle', 'suggestion', 'userMessageBackground', 'claude', 'success', 'warning', 'error', 'inverseText', 'composerSidebarBackground']
    for (const c of colours) expect(theme).toContain(c)
  })
})

describe('search, the key list and the hidden twins', () => {
  const withInput = { ...el, Input: 'Input' }
  const drawWith = (m: PaneModel, columns: number, rows: number, extras: { searching?: boolean; showKeys?: boolean }) => {
    const layout = layoutOf(m, columns, rows, { searching: extras.searching ?? false, showKeys: extras.showKeys ?? false, keyRows: pane.keyListRows(m).length, fullPage: 0 })
    const root = pane.drawPane(withInput, m, columns, layout) as Node
    const lines = root.children as Node[]
    return { all: walk(root), lines, texts: lines.map(drawnText), layout }
  }

  test('the open search field takes the row under the History title, as wide as the row allows, at every width', () => {
    for (const columns of [40, 70, 120]) {
      const { all, lines, texts, layout } = drawWith(model({}, { query: 'bun' }), columns, 30, { searching: true })
      expect(layout.search).toBe('field')
      // The Input draws no text of its own here: it fills the Box sized for it.
      const box = byKey(all, `${pane.KEY_SEARCH_FIELD}-box`)!
      lines.forEach((l, i) => expect(cells(texts[i]!) + (walk(l).includes(box) ? box.props.width : 0)).toBe(columns))
      const field = byKey(all, pane.KEY_SEARCH_FIELD)!
      expect(field.type).toBe('Input')
      expect(field.props.value).toBe('bun')
      expect(typeof field.props.onSubmit).toBe('function')
      expect(field.props.onSubmit()).toBeUndefined()
      const at = texts.findIndex((t) => t.includes('search'))
      expect(texts[at - 1]).toContain('History')
      if (columns > 40) expect(byKey(all, pane.KEY_SEARCH_CLEAR)?.props.hotkey).toBe('x')
    }
  })

  test('an applied search shows its query and x: Clear; a pane too short for it shows neither', () => {
    const { texts } = drawWith(model({}, { query: 'bun test' }), 80, 30, {})
    const line = texts.find((t) => t.includes('search'))!
    expect(line).toContain('bun test')
    expect(line).toContain('x: Clear')
    expect(drawWith(model({}, { query: 'bun' }), 80, 5, {}).layout.search).toBeNull()
  })

  test('the key list opens under the list, rates first, and never pushes the pane past its rows', () => {
    for (const [columns, rows] of [[40, 15], [80, 30], [120, 50]] as const) {
      const { texts, layout } = drawWith(model(), columns, rows, { showKeys: true })
      expect(texts.length).toBeLessThanOrEqual(rows)
      for (const t of texts) expect(cells(t)).toBe(columns)
      const title = texts.findIndex((t) => t.includes('Keys'))
      expect(texts[title + 1]).toContain('fp 4.0%')
      expect(texts.slice(title).length - 1).toBe(layout.keys)
    }
  })

  test('the tabs carry j, k and each digit on hidden twins; a key the bar has no room for keeps its hotkey on one', () => {
    const { all, texts } = drawWith(model(), 40, 30, {})
    const twins = all.filter((n) => n.type === 'Box' && n.props.display === 'none').map((n) => n.children[0] as Node)
    const hot = Object.fromEntries(twins.map((b) => [b.props.key, b.props.hotkey]))
    expect(hot).toMatchObject({ down: 'j', up: 'k', 'tabkey:history': '1', 'tabkey:warnings': '2', 'tabkey:stale': '3', 'tabkey:denied': '4' })
    expect(Object.keys(hot).filter((k) => k.startsWith(pane.KEY_TWIN_PREFIX)).length).toBeGreaterThan(0)
    for (const t of twins) expect(typeof t.props.label).toBe('string')
    for (const t of texts) expect(cells(t)).toBe(40)
  })

  test('twinTarget sends the ring to the tab after a twin, back to the tab before, or nowhere', () => {
    expect(pane.twinTarget('down', null)).toBe('tab:history')
    expect(pane.twinTarget('up', 'tab:history')).toBeNull()
    expect(pane.twinTarget('tabkey:stale', 'tab:warnings')).toBe('tab:stale')
    expect(pane.twinTarget('tabkey:stale', 'tab:stale')).toBe('tab:warnings')
    expect(pane.twinTarget('tabkey:history', 'tab:history')).toBeNull()
    expect(pane.twinTarget('twin:help', null)).toBeNull()
    expect(pane.twinTarget('tab:stale', null)).toBeUndefined()
    expect(pane.twinTarget('tabkey:nope', null)).toBeUndefined()
  })
})

describe('keyListRows', () => {
  test('the warning rates come first, then the keys', () => {
    const rows = pane.keyListRows(model())
    expect(rows[0]).toBe('fp 4.0% · same_context 12.5%')
    expect(rows.slice(1).some((r) => r.startsWith('r ') && r.includes('retest'))).toBe(true)
    expect(rows.slice(1).some((r) => r.startsWith('h '))).toBe(true)
    expect(pane.keyListRows(model({ rates: null }))[0]).toBe('No warning raised yet, so no rates.')
  })
})

describe('fit', () => {
  test('cuts with … and is never wider than the width', () => {
    expect(pane.fit('hello world', 20)).toBe('hello world')
    expect(pane.fit('hello world', 8)).toBe('hello w…')
    expect(pane.fit('hello', 1)).toBe('…')
    expect(pane.fit('hello', 0)).toBe('')
    expect(pane.fit('hello', -3)).toBe('')
    for (const s of ['日本語のテキスト', 'a👍b👍c', 'é́ combining', 'plain']) {
      for (let w = 0; w <= 12; w++) expect(cells(pane.fit(s, w))).toBeLessThanOrEqual(w)
    }
    expect(pane.fit('日本語', 4)).toBe('日…')
  })
})

describe('cells', () => {
  test('a text-presentation symbol is 1 cell, 2 with U+FE0F, and an emoji-presentation one stays 2', () => {
    for (const c of ['⚠', '✔', '©', '™', '↔', '▶', '☺']) {
      expect(cells(c)).toBe(1)
      expect(cells(`${c}\uFE0F`)).toBe(2)
    }
    for (const c of ['✅', '👍', '🚀', '❌']) expect(cells(c)).toBe(2)
    expect(cells('a⚠b')).toBe(3)
    expect(cells('a⚠\uFE0Fb')).toBe(4)
  })

  test('fit and padTo give rows with symbols exactly the width', () => {
    for (const s of ['⚠ warned', '⚠\uFE0F warned', '✔ ok ✅', '© ™ ↔ ▶ ☺']) {
      for (let w = 4; w <= 14; w++) {
        expect(cells(padTo(s, w))).toBe(w)
        expect(cells(pane.fit(s, w))).toBeLessThanOrEqual(w)
      }
    }
  })
})

describe('redraw cost', () => {
  test('one full redraw of a store of 1,000 records stays well under the bound', async () => {
    // A real store on disk: the in-memory double lists a directory by scanning every file,
    // which no real filesystem does.
    const tmp = mkdtempSync(join(tmpdir(), 'cass-redraw-'))
    const cwd = join(tmp, 'proj')
    mkdirSync(cwd)
    writeFileSync(join(cwd, 'a.txt'), 'one')
    let now = ''
    const io: Io = { ...nodeIo, env: async (name) => (name === 'CASSANDRA_HOME' ? join(tmp, 'home') : nodeIo.env(name)), now: () => now }
    try {
      const paths = await pathsFor(io, cwd)
      const stamp = await stateStamp(io, cwd)
      const hashes: string[] = []
      for (let i = 0; i < 1000; i++) {
        const hash = (await fingerprint(io, 'Bash', { command: `false ${i}` }))!
        now = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString()
        await upsertRecord(io, paths, hash, {
          tool: 'Bash', display: `false ${i}`, kind: 'failure', stateStamp: stamp.value, stateKind: stamp.kind as 'mtime',
          sessionId: 's1', compactions: 0, errorExcerpt: 'Exit code 1',
        })
        hashes.push(hash)
      }
      await writeFix(io, paths, hashes[997]!, { kind: 'elsewhere', at: '2026-10-09T00:00:00Z', files: [], more: 0 } as never)
      // Moving between rows: each redraw selects another row.
      const redraw = async (selected: string) => {
        const m = await paneModel(io, cwd, { ...unreadableModel().view, selected }, 's1')
        const layout = layoutOf(m, 100, 40)
        return { layout, all: walk(pane.drawPane(el, m, 100, layout)) }
      }
      await redraw(hashes[999]!)
      const runs: number[] = []
      for (const h of hashes.slice(-5)) {
        const t0 = performance.now()
        const { layout, all } = await redraw(h)
        runs.push(performance.now() - t0)
        const rows = all.filter((n) => n.type === 'Button' && String(n.props.key).startsWith('row:'))
        expect(rows).toHaveLength(layout.list.count)
        const marked = rows.find((n) => walk(n).some((t) => t.props.backgroundColor === 'userMessageBackground'))
        expect(marked?.props.key).toBe(`row:${h.slice(0, 8)}`)
      }
      const ms = Math.max(...runs)
      expect(ms).toBeLessThan(2000)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  }, 60_000)
})

describe('spacing and narrow counters', () => {
  test('an open detail is followed by exactly one blank row before the next day group', () => {
    const m = model({ selected: row(1).hash }, { expanded: true })
    const { texts, lines } = draw(m, 120, 50)
    const at = texts.findIndex((t) => t.includes('▾'))
    const end = at + 1 + fullDetailRows(detail)
    for (const l of lines.slice(at + 1, end)) expect(l.props.backgroundColor).toBe('userMessageBackground')
    expect(texts[end - 1]).toContain('fix')
    expect(texts[end]!.trim()).toBe('')
    expect(lines[end]!.props.backgroundColor).toBeUndefined()
    expect(texts[end + 1]!.trim()).toBe('Yesterday')
  })

  test('the retest confirm has a blank row above its title, and the pane keeps to its rows', () => {
    for (const rows of [16, 30]) {
      const { texts, layout } = draw(model({}, { confirmRetest: row(0).hash }), 70, rows)
      expect(layout.retest).not.toBe('too-small')
      const title = texts.findIndex((t) => t.includes('↻'))
      expect(title).toBeGreaterThan(0)
      expect(texts[title - 1]!.trim()).toBe('')
      expect(texts.length).toBeLessThanOrEqual(rows)
    }
  })

  test('at 40 to 55 columns all four counters show whole on their one line', () => {
    const counts = [
      { warnNow: 2, remembered: 4, warningsToday: 3, clearedByRetest: 1 },
      { warnNow: 12, remembered: 140, warningsToday: 12, clearedByRetest: 10 },
    ]
    for (const counters of counts) {
      for (let columns = 40; columns <= 55; columns++) {
        const { texts, layout } = draw(model({ counters }), columns, 30)
        expect(layout.counters).toBe('short')
        const line = texts[2]!
        expect(cells(line)).toBe(columns)
        expect(line).not.toContain('…')
        for (const n of Object.values(counters)) expect(line).toMatch(new RegExp(`(^| )${n} [a-z]`))
        expect(line).toMatch(/cleared\s*$/)
      }
    }
  })

  test('medium panes keep the short counter labels', () => {
    const { texts } = draw(model(), 70, 30)
    expect(texts[2]).toContain('2 warn now   4 remembered   3 today   1 cleared')
  })
})

test('an open detail draws exactly fullDetailRows lines, with its fix and retest lines, in every combination', () => {
  const tinted = (d: PaneDetail) => {
    const { texts, lines } = draw(model({ detail: d }, { expanded: true }), 120, 50)
    const at = texts.findIndex((t) => t.includes('▾'))
    let n = 0
    while (lines[at + 1 + n]?.props.backgroundColor === 'userMessageBackground') n++
    return texts.slice(at + 1, at + 1 + n)
  }
  for (const fix of [null, 'Use bun run test instead.']) {
    for (const retest of [detail.retest, { ok: false, why: 'denied' } as const]) {
      const d: PaneDetail = { ...detail, fix, retest }
      const block = tinted(d)
      expect(block).toHaveLength(fullDetailRows(d))
      expect(block.some((t) => t.includes('Use bun run test instead.'))).toBe(fix !== null)
      expect(block.some((t) => t.includes('not offered for a denied call'))).toBe(!retest.ok)
      expect(block.every((t) => t.trim() !== '')).toBe(true)
    }
  }
})
