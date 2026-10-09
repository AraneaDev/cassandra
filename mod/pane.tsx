import type { PaneModel, PaneRow } from '../src/core/pane.ts'

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

/**
 * Every line the pane draws besides its rows, when all of them show: the rule above the
 * list, `…N more`, the rule above the detail, reason, probe, fix, the rule below, stats,
 * the notice and the action row. The list gets the body's rows minus these, so the
 * action row stays on screen however many records there are.
 */
const CHROME = ['rule', 'more', 'detail rule', 'reason', 'probe', 'fix', 'foot rule', 'stats', 'notice', 'action row'] as const

/** How many lines the pane draws besides its rows, at most. */
export const PANE_CHROME_LINES = CHROME.length

/** The lines of the detail block: what a short body drops first. */
const DETAIL_LINES = (['detail rule', 'reason', 'probe', 'fix'] as const satisfies ReadonlyArray<typeof CHROME[number]>).length

/** How the pane fits its body: the rows the list gets, and whether the detail and the stats show. */
export interface PaneLayout { maxRows: number; detail: boolean; stats: boolean }

/**
 * Fit the pane to a body of `bodyRows` lines. A body too short for every line drops the
 * detail block first and gives its room to rows; one still too short for a row drops the
 * stats line too. The list always keeps one row, and the action row is always drawn.
 */
export function paneLayout(bodyRows: number): PaneLayout {
  if (bodyRows > PANE_CHROME_LINES) return { maxRows: bodyRows - PANE_CHROME_LINES, detail: true, stats: true }
  const chrome = PANE_CHROME_LINES - DETAIL_LINES
  if (bodyRows > chrome) return { maxRows: bodyRows - chrome, detail: false, stats: true }
  return { maxRows: Math.max(1, bodyRows - (chrome - 1)), detail: false, stats: false }
}

/** An engine element constructor, called through the JSX factory. */
type Tag = (props: Record<string, unknown>) => unknown

/** The engine's elements, resolved from `$.ui.resolve`. */
export interface Elements { Box: unknown; Text: unknown; Button: unknown }

// A press does nothing here: the real actions run in `ui.press` hooks keyed by element key.
const noop = (): void => {}

function clip(s: string, max: number): string {
  if (max < 1) return ''
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

/** Narrowest room the display keeps before the whole label is clipped instead. */
const MIN_DISPLAY = 4

/**
 * One row's label, never wider than `columns`: the command gives way first, so the
 * marker, the id, the package suffix and the tail (with `stale`) stay whole while they
 * can. Without room for the suffix too, the command and suffix are clipped together.
 */
function rowLabel(r: PaneRow, selected: boolean, columns: number): string {
  const head = `${selected ? '▸' : ' '} ${r.id} `
  const tail = ` ${r.kind} ${r.count}× ${r.day}${r.stale ? ' stale' : ''}`
  const room = columns - head.length - tail.length
  if (room - r.where.length >= MIN_DISPLAY) return `${head}${clip(r.display, room - r.where.length)}${r.where}${tail}`
  if (room >= MIN_DISPLAY) return `${head}${clip(`${r.display}${r.where}`, room)}${tail}`
  return clip(`${head}${r.display}${r.where}${tail}`, columns)
}

/**
 * Draws the pane as an element tree. Pure: no I/O. Buttons carry a no-op `onPress` and
 * are told apart by key; keyed text sits in a keyed Box, because Text drops its key.
 * `show` hides the detail block or the stats line on a short body (see `paneLayout`).
 */
export function drawPane(el: Elements, model: PaneModel, columns: number, show: Pick<PaneLayout, 'detail' | 'stats'> = { detail: true, stats: true }): unknown {
  const Box = el.Box as Tag
  const Text = el.Text as Tag
  const Button = el.Button as Tag
  const rule = '─'.repeat(Math.max(0, columns))
  // Every line is clipped to the body, so nothing wraps and the line count holds.
  const line = (s: string, dim = false): unknown => <Text dimColor={dim || undefined}>{clip(s, columns)}</Text>

  if (model.error) return <Box flexDirection="column">{line(model.error)}</Box>

  const body: unknown[] = []
  if (model.rows.length === 0) {
    body.push(line('Nothing remembered in this project.'))
  } else {
    for (const r of model.rows) {
      const sel = r.hash === model.selected
      body.push(
        <Button key={`${ROW_KEY_PREFIX}${r.id}`} plain onPress={noop} dimColor={r.stale || undefined}>
          {rowLabel(r, sel, columns)}
        </Button>,
      )
    }
    if (model.more > 0) body.push(line(`…${model.more} more`, true))
  }

  const detail: unknown[] = []
  if (model.detail && show.detail) {
    const reason = model.detail.reason === null ? 'reason (none captured)' : `reason (tool output) ${model.detail.reason}`
    detail.push(line(rule, true), line(reason), line(`probe ${model.detail.probe}`))
    if (model.detail.fix) detail.push(line(`fix ${model.detail.fix}`))
  }

  const foot: unknown[] = []
  if (model.stats && show.stats) foot.push(line(model.stats, true))
  if (model.notice) foot.push(line(model.notice))
  if (model.rows.length > 0) {
    foot.push(
      model.confirmAll ? (
        <Box key="confirm-row" gap={2}>
          <Button key={KEY_CONFIRM} onPress={noop}>{`Forget all ${model.total} ${model.total === 1 ? 'record' : 'records'}`}</Button>
          <Button key={KEY_CANCEL} onPress={noop}>Cancel</Button>
        </Box>
      ) : (
        <Box key="action-row" gap={2}>
          <Button key={KEY_FORGET} hotkey="f" onPress={noop}>Forget</Button>
          <Button key={KEY_FORGET_ALL} hotkey="a" onPress={noop}>Forget all</Button>
        </Box>
      ),
    )
  }

  return (
    <Box key="cassandra-pane" flexDirection="column">
      {line(rule, true)}
      {body}
      {detail}
      {line(rule, true)}
      {foot}
    </Box>
  )
}
