import { describe, expect, test } from 'bun:test'
import { unreadableModel, type PaneModel, type PaneRow } from '../src/core/pane.ts'
import { paneSvg } from '../scripts/pane-svg.ts'
import { terminalSvg } from '../scripts/terminal-svg.ts'

const row = (i: number, display: string): PaneRow => ({
  hash: `${String(i).padStart(8, '0')}ffffffff`, id: String(i).padStart(8, '0'), display, where: '',
  state: 'warns', count: 2, time: '12:39', group: 'Today',
})

/** A fixed model whose calls carry the characters XML reserves. */
function model(): PaneModel {
  const base = unreadableModel()
  const rows = [row(0, 'bun test a.test.ts && echo <done>'), row(1, 'cat x | grep "a<b"')]
  return {
    ...base, error: null, project: 'demo', git: { branch: 'main', head: 'abc1234' },
    tabs: { history: 2, warnings: 2, stale: 0, denied: 0 },
    counters: { warnNow: 2, remembered: 2, warningsToday: 1, clearedByRetest: 0 },
    rows, selected: rows[0]!.hash, total: 2, hashes: rows.map((r) => r.hash),
  }
}

/** The text content of every `<text>` element, tags and entities left as written. */
const texts = (svg: string): string[] => [...svg.matchAll(/<text [^>]*>(.*?)<\/text>/g)].map((m) => m[1]!)
const unescape = (s: string): string => s.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

describe('paneSvg', () => {
  test('draws one <text> per pane row, each the drawn row exactly', () => {
    for (const [columns, rows] of [[60, 12], [120, 20], [44, 16]] as const) {
      const { svg, text } = paneSvg(model(), columns, rows)
      const drawn = texts(svg)
      expect(drawn).toHaveLength(text.length)
      expect(text.length).toBeLessThanOrEqual(rows)
      expect(drawn.map(unescape)).toEqual(text)
    }
  })

  test('escapes < and & in what the calls say', () => {
    const { svg, text } = paneSvg(model(), 80, 12)
    expect(text.some((l) => l.includes('&& echo <done>'))).toBe(true)
    expect(svg).toContain('&amp;&amp; echo &lt;done&gt;')
    for (const t of texts(svg)) expect(t.replace(/<\/?tspan[^>]*>/g, '')).not.toMatch(/<|&(?!amp;|lt;|gt;)/)
  })
})

describe('terminalSvg', () => {
  test('draws the command and one <text> per output line, escaped', () => {
    const svg = terminalSvg('cassandra stats', 'a & b\n    same_context  2  <- note\n')
    const drawn = texts(svg).map(unescape)
    expect(drawn).toEqual(['$ cassandra stats', '', 'a & b', '    same_context  2  <- note'])
    expect(svg).toContain('&lt;- note')
  })
})
