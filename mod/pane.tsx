import type { PaneModel, PaneRow } from '../src/core/pane.ts'

// The engine's mod runtime supplies the JSX factory `h` as a global.
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- used by the JSX transform
declare function h(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): unknown

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

/** An engine element constructor, called through the JSX factory. */
type Tag = (props: Record<string, unknown>) => unknown

/** The engine's elements, resolved from `$.ui.resolve`. */
interface Elements { Box: unknown; Text: unknown; Button: unknown }

// A press does nothing here: the real actions run in `ui.press` hooks keyed by element key.
const noop = (): void => {}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, Math.max(0, max - 1))}…` : s
}

function rowLabel(r: PaneRow, selected: boolean, max: number): string {
  const tail = `${r.kind} ${r.count}× ${r.day}${r.stale ? ' stale' : ''}`
  return `${selected ? '▸' : ' '} ${r.id} ${clip(r.display, max)} ${tail}`
}

/**
 * Draws the pane as an element tree. Pure: no I/O. Buttons carry a no-op `onPress` and
 * are told apart by key; keyed text sits in a keyed Box, because Text drops its key.
 */
export function drawPane(el: Elements, model: PaneModel, columns: number): unknown {
  const Box = el.Box as Tag
  const Text = el.Text as Tag
  const Button = el.Button as Tag
  const rule = '─'.repeat(Math.max(0, columns))
  const line = (s: string, dim = false): unknown => <Text dimColor={dim || undefined}>{s}</Text>

  if (model.error) return <Box flexDirection="column">{line(model.error)}</Box>

  const max = Math.max(10, columns - 30)
  const body: unknown[] = []
  if (model.rows.length === 0) {
    body.push(line('Nothing remembered in this project.'))
  } else {
    for (const r of model.rows) {
      const sel = r.hash === model.selected
      body.push(
        <Button key={`${ROW_KEY_PREFIX}${r.id}`} plain onPress={noop} dimColor={r.stale || undefined} variant={sel ? 'primary' : undefined}>
          {rowLabel(r, sel, max)}
        </Button>,
      )
    }
    if (model.more > 0) body.push(line(`…${model.more} more`, true))
  }

  const detail: unknown[] = []
  if (model.detail) {
    detail.push(line(rule, true), line(`reason ${clip(model.detail.reason, max)}`), line(`probe ${clip(model.detail.probe, max)}`))
    if (model.detail.fix) detail.push(line(`fix ${clip(model.detail.fix, max)}`))
  }

  const foot: unknown[] = []
  if (model.stats) foot.push(line(model.stats, true))
  if (model.notice) foot.push(line(model.notice))
  if (model.rows.length > 0) {
    foot.push(
      model.confirmAll ? (
        <Box key="confirm-row" gap={2}>
          <Button key={KEY_CONFIRM} onPress={noop}>{`Forget all ${model.total} records`}</Button>
          <Button key={KEY_CANCEL} onPress={noop}>Cancel</Button>
        </Box>
      ) : (
        <Box key="action-row" gap={2}>
          <Button key={KEY_FORGET} hotkey="f" onPress={noop}>[Forget]</Button>
          <Button key={KEY_FORGET_ALL} hotkey="a" onPress={noop}>[Forget all]</Button>
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
