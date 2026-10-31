/**
 * Renders captured `cassandra` CLI output as an SVG card for the README.
 *
 * The report is space-aligned text whose columns carry meaning, so the card is
 * monospaced and never reflows: each line becomes one `<text xml:space="preserve">`,
 * and its coloured runs become `<tspan>`s that share the line's advance and so cannot
 * push a column out of true. The typed command sits above a rule; a section heading
 * is bold, a parenthesised gloss and the `<-` note dim, the rest plain.
 *
 * Used by `scripts/readme-images.ts`.
 */
import { FONT, FRAME, GROUND, escapeXml } from './pane-svg.ts'

const BODY = '#b8c0cb'
const DIM = '#7a8593'
const BONE = '#ece5d5'

const FONT_SIZE = 13
const LINE_HEIGHT = 19
const CHAR_WIDTH = FONT_SIZE * 0.6
const PAD = 22

interface Part { text: string; fill: string; bold?: boolean }

/** A line of output as coloured parts. */
function partsOf(line: string): Part[] {
  if (line !== '' && !line.startsWith(' ')) return [{ text: line, fill: BONE, bold: true }]
  const note = line.search(/ {2}(\(|<-)/)
  return note < 0 ? [{ text: line, fill: BODY }] : [{ text: line.slice(0, note), fill: BODY }, { text: line.slice(note), fill: DIM }]
}

/** `output` as `command` printed it, as an SVG card. */
export function terminalSvg(command: string, output: string): string {
  const body = output.replace(/\n+$/, '').split('\n')
  const lines: Part[][] = [[{ text: '$ ', fill: DIM }, { text: command, fill: BONE }], [], ...body.map(partsOf)]
  const columns = Math.max(...lines.map((p) => p.reduce((n, r) => n + r.text.length, 0)))
  const width = Math.ceil(columns * CHAR_WIDTH + PAD * 2)
  const height = lines.length * LINE_HEIGHT + PAD * 2
  const texts = lines.map((parts, i) => {
    const spans = parts.map((r) => `<tspan fill="${r.fill}"${r.bold === true ? ' font-weight="bold"' : ''}>${escapeXml(r.text)}</tspan>`).join('')
    return `  <text x="${PAD}" y="${PAD + LINE_HEIGHT * (i + 1) - 5}" xml:space="preserve">${spans}</text>`
  })
  // The one piece of chrome: a rule between what was typed and what came back.
  const ruleY = PAD + LINE_HEIGHT + 5
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="${FONT}" font-size="${FONT_SIZE}">
  <rect width="${width}" height="${height}" rx="8" fill="${GROUND}"/>
  <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="8" fill="none" stroke="${FRAME}"/>
  <line x1="${PAD}" y1="${ruleY}" x2="${width - PAD}" y2="${ruleY}" stroke="${FRAME}" stroke-width="1"/>
${texts.join('\n')}
</svg>
`
}
