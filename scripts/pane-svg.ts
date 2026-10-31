/**
 * Renders the `/cassandra pane` as an SVG card for the README, from the pane's own code.
 *
 * The model comes from `paneModel`, the layout from `layoutOf` and the lines from
 * `drawPane`, the same three calls the mod makes. `drawPane` returns an element tree;
 * a small `h` shim collects it here, and every Text run becomes a `<tspan>` with its
 * theme colour mapped to a fixed hex, so the image is the pane as it draws rather than a
 * second layout that could drift from it. One `<text xml:space="preserve">` per pane
 * row, monospaced and never reflowed, every row exactly the pane's width.
 *
 * Used by `scripts/readme-images.ts`; see there for the staged demo data.
 */
import { cells } from '../mod/draw-text.ts'
import { layoutOf, type PaneExtras } from '../mod/layout.ts'
import { drawPane } from '../mod/pane.tsx'
import type { PaneModel } from '../src/core/pane.ts'

export const GROUND = '#10151d'
export const FRAME = '#26303d'
export const FONT = 'ui-monospace, SFMono-Regular, &#34;SF Mono&#34;, Menlo, Consolas, &#34;DejaVu Sans Mono&#34;, monospace'

/** The Claude Code theme keys the pane draws with, as a dark theme shows them. */
const THEME: Record<string, string> = {
  text: '#ece5d5',
  inactive: '#7a8593',
  subtle: '#3a4553',
  suggestion: '#9a8fd0',
  userMessageBackground: '#1d2633',
  claude: '#d97757',
  success: '#7fb3a3',
  warning: '#d8a13f',
  error: '#cf6a63',
  inverseText: '#10151d',
  composerSidebarBackground: '#171e28',
}

const FONT_SIZE = 13
const LINE_HEIGHT = 19
const CHAR_WIDTH = FONT_SIZE * 0.6
const PAD = 22

/** One run of a drawn row: its text and the theme keys it is drawn in. */
export interface Run { text: string; color?: string; bg?: string; bold?: boolean }

interface Node { type: string; props: Record<string, unknown>; children: unknown[] }

export const escapeXml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** The element tree `drawPane` returns, built by a shim in place of the engine's `h`. */
function tree(model: PaneModel, columns: number, rows: number, extras?: PaneExtras): Node {
  const g = globalThis as Record<string, unknown>
  const saved = { h: g.h, Fragment: g.Fragment }
  g.h = (type: string, props: Record<string, unknown> | null, ...children: unknown[]): Node => ({ type, props: props ?? {}, children: children.flat() })
  g.Fragment = 'Fragment'
  try {
    return drawPane({ Box: 'Box', Text: 'Text', Button: 'Button' }, model, columns, layoutOf(model, columns, rows, extras)) as Node
  } finally {
    g.h = saved.h
    g.Fragment = saved.Fragment
  }
}

/**
 * The runs a node draws, styles inherited downwards as the engine does: a Box's ground, a
 * Text's colour, ground and weight. A hidden Box draws nothing; a plain Button with a hotkey
 * draws `k: ` before its label.
 */
function runsOf(n: unknown, inherited: Omit<Run, 'text'>, out: Run[]): Run[] {
  if (typeof n === 'string' || typeof n === 'number') {
    out.push({ ...inherited, text: String(n) })
    return out
  }
  if (n === null || typeof n !== 'object') return out
  const node = n as Node
  if (node.type === 'Box' && node.props.display === 'none') return out
  const style = { ...inherited }
  if (typeof node.props.backgroundColor === 'string') style.bg = node.props.backgroundColor
  if (node.type === 'Text') {
    if (typeof node.props.color === 'string') style.color = node.props.color
    if (node.props.bold === true) style.bold = true
  }
  if (node.type === 'Button' && typeof node.props.hotkey === 'string') out.push({ ...style, text: `${node.props.hotkey}: ` })
  for (const c of node.children) runsOf(c, style, out)
  return out
}

/** The pane's rows as runs, top to bottom, each exactly `columns` cells. Throws when one is not. */
export function paneRuns(model: PaneModel, columns: number, rows: number, extras?: PaneExtras): Run[][] {
  const root = tree(model, columns, rows, extras)
  const lines = root.children.map((l) => runsOf(l, {}, []))
  lines.forEach((runs, i) => {
    const w = runs.reduce((n, r) => n + cells(r.text), 0)
    if (w !== columns) throw new Error(`pane row ${i} is ${w} cells, not ${columns}`)
  })
  return lines
}

/** A row as plain text, for checking an image without opening it. */
export const plain = (runs: Run[]): string => runs.map((r) => r.text).join('')

/** One run's colour and weight as SVG attributes; no colour reads as the theme's text. */
function paint(r: Run): string {
  const fill = THEME[r.color ?? 'text'] ?? THEME.text
  return r.bold === true ? `fill="${fill}" font-weight="bold"` : `fill="${fill}"`
}

/** The pane's rows as an SVG card: grounds as rectangles behind, one `<text>` per row. */
export function svgOf(lines: Run[][], columns: number): string {
  const width = Math.ceil(columns * CHAR_WIDTH + PAD * 2)
  const height = lines.length * LINE_HEIGHT + PAD * 2
  const top = (row: number): number => PAD + LINE_HEIGHT * row
  const drawn: string[] = []
  lines.forEach((runs, row) => {
    let col = 0
    for (const r of runs) {
      const w = cells(r.text)
      if (r.bg !== undefined && w > 0) {
        drawn.push(`  <rect x="${(PAD + col * CHAR_WIDTH).toFixed(1)}" y="${top(row)}" width="${(w * CHAR_WIDTH).toFixed(1)}" height="${LINE_HEIGHT}" fill="${THEME[r.bg] ?? GROUND}"/>`)
      }
      col += w
    }
  })
  lines.forEach((runs, row) => {
    const spans = runs.map((r) => `<tspan ${paint(r)}>${escapeXml(r.text)}</tspan>`).join('')
    drawn.push(`  <text x="${PAD}" y="${top(row) + LINE_HEIGHT - 5}" xml:space="preserve">${spans}</text>`)
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="${FONT}" font-size="${FONT_SIZE}">
  <rect width="${width}" height="${height}" rx="8" fill="${GROUND}"/>
  <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="8" fill="none" stroke="${FRAME}"/>
${drawn.join('\n')}
</svg>
`
}

/** The pane for `model` at `columns` by `rows`, as an SVG and as its plain rows. */
export function paneSvg(model: PaneModel, columns: number, rows: number, extras?: PaneExtras): { svg: string; text: string[] } {
  const lines = paneRuns(model, columns, rows, extras)
  return { svg: svgOf(lines, columns), text: lines.map(plain) }
}
