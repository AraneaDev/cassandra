/**
 * Text as the pane prints it: measured in terminal cells, cut to a width with `…`, and
 * padded. Widths are counted per grapheme: East Asian wide and emoji graphemes take two
 * cells, a grapheme of only combining marks none, the rest one. A cut never splits a
 * grapheme. Pure.
 */

const WIDE =
  /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]|[\u{1f300}-\u{1faff}\u{20000}-\u{3fffd}]|\p{Extended_Pictographic}/u
const MARKS_ONLY = /^\p{M}+$/u
/** Printable ASCII only: one cell a code unit. */
const ASCII = /^[\x20-\x7e]*$/

const segmenter = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  : null

/** The graphemes of `text`, in order; code points where the runtime cannot segment. */
const graphemes = (text: string): string[] =>
  segmenter ? Array.from(segmenter.segment(text), (s) => s.segment) : Array.from(text)

const graphemeCells = (g: string): number => (MARKS_ONLY.test(g) ? 0 : WIDE.test(g) ? 2 : 1)

/** The cells `text` takes in a terminal. */
export function cells(text: string): number {
  if (ASCII.test(text)) return text.length
  return graphemes(text).reduce((n, g) => n + graphemeCells(g), 0)
}

/** `text` cut to at most `width` cells, its last cell an ellipsis when anything was cut. */
export function fit(text: string, width: number): string {
  if (width <= 0) return ''
  if (cells(text) <= width) return text
  let used = 0
  let out = ''
  for (const g of graphemes(text)) {
    used += graphemeCells(g)
    if (used > width - 1) break
    out += g
  }
  return `${out}…`
}

/** `n` spaces; none for a negative `n`. */
export const spaces = (n: number): string => ' '.repeat(Math.max(0, n))

/** `text` fitted to `width` cells and padded out to exactly that width. */
export const padTo = (text: string, width: number): string => {
  const t = fit(text, width)
  return t + spaces(width - cells(t))
}
