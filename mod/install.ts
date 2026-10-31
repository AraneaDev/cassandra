import { forget } from '../src/commands/forget.ts'
import { runCommand, type CommandResult } from '../src/commands/run.ts'
import { buildBriefing, callHash, check, recordBriefing, settle, type Call, type Outcome, type Warning } from '../src/core/engine.ts'
import type { Io } from '../src/core/io.ts'
import { paneModel, unreadableModel, type LastWarning, type PaneModel, type PaneTab, type PaneView } from '../src/core/pane.ts'
import { evidence } from '../src/core/describe.ts'
import { dataRoot, pathsFor } from '../src/core/paths.ts'
import { statusText } from '../src/core/status.ts'
import { bumpCompactions, clearModSession, markModSession, pruneModMarkers } from '../src/core/session.ts'
import { appendStat, type BriefBoundary } from '../src/core/stats.ts'
import { QUERY_TOOL, RESOLVE_TOOL, TOOL_PREFIX, queryText, resolveFailure } from '../src/core/tools.ts'
import { listRecords, readRecord } from '../src/core/record.ts'
import { resolveHash } from '../src/core/resolve.ts'
import { modIo, type ModHost } from '../src/io/mod.ts'
import { layoutOf, type PaneExtras } from './layout.ts'
import {
  KEY_CANCEL, KEY_CONFIRM, KEY_DISMISS, KEY_DOWN, KEY_FORGET, KEY_FORGET_ALL, KEY_FULL, KEY_HELP, KEY_NEXT_PAGE, KEY_PREV_PAGE, KEY_RETEST, KEY_RETEST_CANCEL, KEY_RETEST_CONFIRM, KEY_SEARCH,
  KEY_SEARCH_CLEAR, KEY_SEARCH_FIELD, KEY_TABKEY_PREFIX, KEY_TAB_PREFIX, KEY_TWIN_PREFIX, KEY_UP, ROW_KEY_PREFIX, drawPane, keyListRows, twinTarget,
  type Elements,
} from './pane.tsx'
import { callDigest, runRetest, type RetestHost, type Retesting } from './retest.ts'

/** A user-role row a plugin appends: text blocks the model reads, in the named loop (main when absent). */
export interface AppendArgs {
  message: { type: 'user'; content: Array<{ type: 'text'; text: string }> }
  agentId?: string
}

/** What an append resolves to: the stored row, or `{ deny }` when a plugin above refused it. */
export interface AppendResult {
  deny?: string
  [key: string]: unknown
}

/** What the pane keeps in `$.state` between redraws; `types/index.d.ts` declares the same contract to the engine. */
export interface PaneState {
  selected: string | null
  confirmAll: boolean
  rev: number
  notice: string | null
  tab: PaneTab
  expanded: boolean
  showFull: boolean
  fullPage: number
  query: string
  confirmRetest: string | null
  lastWarning: LastWarning | null
  searching: boolean
  showKeys: boolean
}

/** A reference to one of the pane's values, as `$.state` takes it. */
export type PaneRef<K extends keyof PaneState> = { readonly plugin: 'cassandra'; readonly key: K }

/** The arguments of `$.ui.open`, as far as the mod passes them. */
export interface OpenArgs {
  id: string
  title: string
  focus: boolean
  closeOnEscape: boolean
}

/** The slice of `$` the hooks use: the core's, the session's identity and its append, tool registration, state and the pane. */
export type ModEngine = ModHost & {
  session: { id(): Promise<string>; cwd(): Promise<string>; append(args: AppendArgs): Promise<AppendResult>; surfaces(): Promise<readonly string[]> }
  tool: {
    register(spec: { name: string; description: string; inputSchema?: Record<string, unknown> }): Promise<unknown>
    check(args: { tool: string; input: unknown }): Promise<{ decision: 'allow' | 'ask' | 'deny' }>
    call(args: { tool: string; consent?: string; [key: string]: unknown }): Promise<unknown>
  }
  command: { register(spec: { name: string; description?: string; argumentHint?: string }): Promise<unknown> }
  state: {
    get<K extends keyof PaneState>(ref: PaneRef<K>): Promise<{ value: PaneState[K] | undefined; version: number }>
    set<K extends keyof PaneState>(ref: PaneRef<K>, value: PaneState[K]): Promise<unknown>
  }
  ui: {
    status(text: string | undefined): void
    open(args: OpenArgs): Promise<unknown>
    resolve(e: PaneRenderEvent): Elements
    focus(args: { requestId: string; key: string }): Promise<{ deny?: string }>
    toast(text: string): void
  }
}

/** Which site the pane hooks match: the one pane this plugin opens. */
export interface PaneMatcher {
  component: 'Pane'
  requestId: string
}

/** A `ui.render` input for the pane, as far as the mod reads it. */
export interface PaneRenderEvent {
  /** Where the tree will be drawn: terminal, desktop, vscode or mobile. */
  surface?: string
  props: { bodyColumns?: number; scroll?: { bodyRows: number } }
  viewport?: { columns: number; rows: number }
  [key: string]: unknown
}

/** A `ui.press` input: the key of the Button pressed. */
export interface PressEvent {
  element: string
  /** Where the press came from: the surface whose drawing it pressed. */
  surface?: string
  [key: string]: unknown
}

/** A `ui.focus` input: the key of the element taking the ring, absent for one of the engine's stops. */
export interface FocusEvent {
  element?: string
  /** Where the ring moves: terminal, desktop, vscode or mobile. */
  surface?: string
  [key: string]: unknown
}

/** A `ui.input` input: an edit of, or Enter in, an Input the pane drew. */
export interface InputEvent {
  element: string
  kind: 'change' | 'submit'
  value: string
  [key: string]: unknown
}

/** A `session.compact` input, as far as the mod reads it. */
export interface CompactEvent {
  /** What is compacting; 'precompute' prepares a summary ahead of time and installs nothing. */
  trigger?: 'manual' | 'auto' | 'plugin' | 'precompute'
  agentId?: string
}

/** A `session.append` input: one row a loop of the session keeps. */
export interface AppendEvent {
  message: unknown
  door: string
  origin: { kind: string; name?: string; [key: string]: unknown }
  uuid: string
  agentId?: string
}

/** An `agent.spawn` input, as far as the mod reads it. */
export interface SpawnEvent {
  subagentType: string
  [key: string]: unknown
}

/** An `agent.spawn` result: the new loop's id, or the refusal. */
export interface SpawnResult {
  agentId?: string
  deny?: string
  [key: string]: unknown
}

/** A note owed to a loop: which boundary it crossed, and how many appends were refused. */
export interface Owed {
  boundary: BriefBoundary
  attempts: number
}

/** A `command.run` input, as far as the mod reads it. */
export interface CommandEvent {
  command: string
  args: string
  /** Where the run came from: the person's Enter ('composer'), their remote client ('bridge'), a headless run ('sdk'), or something else. */
  origin?: { kind: string; [key: string]: unknown }
}

/** A `tool.call` input: the tool, the engine's own keys, and the tool's arguments beside them. */
export interface ToolCallEvent {
  tool: string
  tool_use_id?: string
  agentId?: string
  [key: string]: unknown
}

/** A `tool.call` result: answered, errored, or denied. */
export interface ToolCallOutcome {
  deny?: string
  isError?: boolean
  text?: string
  context?: readonly string[]
  [key: string]: unknown
}

/** A hook's `next`, which carries the dispatch's abort signal and who raised it (`plugin`: a `$` call's plugin, `engine` for the engine's own). */
export type Next<E, R> = ((e: E) => Promise<R>) & { signal?: AbortSignal; origin?: { plugin: string } }

/** The overloads of `on` this mod uses, typed structurally so CI can check them without the engine's types. */
export interface ModOn {
  (event: 'session.start', hook: ($: ModEngine, e: unknown, next: Next<unknown, unknown>) => Promise<unknown>): unknown
  (event: 'session.end', hook: ($: ModEngine, e: { sessionId: string }, next: Next<{ sessionId: string }, unknown>) => Promise<unknown>): unknown
  (event: 'session.compact', hook: ($: ModEngine, e: CompactEvent, next: Next<CompactEvent, { skip?: string }>) => Promise<unknown>): unknown
  (event: 'session.append', hook: ($: ModEngine, e: AppendEvent, next: Next<AppendEvent, unknown>) => Promise<unknown>): unknown
  (event: 'agent.spawn', hook: ($: ModEngine, e: SpawnEvent, next: Next<SpawnEvent, SpawnResult>) => Promise<unknown>): unknown
  (event: 'command.run', matcher: { command: string }, hook: ($: ModEngine, e: CommandEvent, next: Next<CommandEvent, unknown>) => Promise<{ text?: string; exitCode?: number }>): unknown
  (event: 'tool.call', matcher: { tool: RegExp }, hook: ($: ModEngine, e: ToolCallEvent, next: Next<ToolCallEvent, ToolCallOutcome>) => Promise<ToolCallOutcome>): unknown
  (event: 'ui.render', matcher: PaneMatcher, hook: ($: ModEngine, e: PaneRenderEvent, next: Next<PaneRenderEvent, unknown>) => Promise<unknown>): unknown
  (event: 'ui.press', matcher: PaneMatcher, hook: ($: ModEngine, e: PressEvent, next: Next<PressEvent, unknown>) => Promise<unknown>): unknown
  (event: 'ui.input', matcher: PaneMatcher, hook: ($: ModEngine, e: InputEvent, next: Next<InputEvent, unknown>) => Promise<unknown>): unknown
  (event: 'ui.focus', matcher: PaneMatcher, hook: ($: ModEngine, e: FocusEvent, next: Next<FocusEvent, unknown>) => Promise<unknown>): unknown
}

/**
 * The same calls the binary's hooks match: Bash and every MCP tool, except Cassandra's own two.
 * `classify()` ignores those already; the matcher keeps the hook from being dispatched for them.
 */
export const TRACKED = /^(?:Bash|mcp__(?!cassandra__(?:query|resolve)$).+)$/

/** Keys the engine puts on a `tool.call` input that are not the tool's arguments. */
const RESERVED = new Set(['tool', 'tool_use_id', 'consent', 'agentId'])

/** How often a live session rewrites its marker, so a prune by another session never orphans it. */
const MARKER_REFRESH_MS = 60 * 60 * 1000

/**
 * The core's slice of `$`, with each call spelled out. `claude plugin validate` follows `$`
 * only into a function declared in the same file, never across an import, so `$` cannot be
 * handed to `modIo` directly; this declared function hands it a plain object instead.
 */
function hostOf($: ModEngine): ModHost {
  return {
    fs: {
      read: (path) => $.fs.read(path),
      write: (path, text) => $.fs.write(path, text),
      list: (path) => $.fs.list(path),
      exists: (path) => $.fs.exists(path),
      stat: (path) => $.fs.stat(path),
    },
    process: { run: (argv, init) => $.process.run(argv, init) },
    env: {
      // `$.env.get` takes string literals only, so each name is spelled out.
      get: (name) => {
        switch (name) {
          case 'CASSANDRA_HOME': return $.env.get('CASSANDRA_HOME')
          case 'CLAUDE_PLUGIN_DATA': return $.env.get('CLAUDE_PLUGIN_DATA')
          case 'HOME': return $.env.get('HOME')
          default: return Promise.resolve(undefined)
        }
      },
    },
  }
}

/**
 * The calls a retest makes, each spelled out for the same reason as `hostOf`: the validator
 * follows `$` only into a function declared in this file.
 */
function retestHostOf($: ModEngine, claimed: () => Promise<boolean>): RetestHost {
  return {
    cwd: () => $.session.cwd(),
    claimed,
    check: (args) => $.tool.check(args),
    call: (args) => $.tool.call(args),
    toast: (text) => $.ui.toast(text),
  }
}

/** This plugin's name, as the engine stamps it on the rows the plugin appends. */
const PLUGIN_NAME = 'cassandra'

/** Refused appends after which an owed note is dropped. */
const MAX_ATTEMPTS = 5

/**
 * Hand the live failures to a loop whose transcript does not hold them: a new subagent's,
 * or one just compacted. The note is appended as a row the model reads; the stat is
 * written only once the append resolves, so an undelivered note leaves no trace. Resolves
 * to the entry still owed when the append was refused (null when done or dropped), and
 * never throws. Top-level because it takes `$`: the validator follows `$` nowhere else.
 */
async function handOver($: ModEngine, io: Io, owed: Owed, agentId: string | undefined): Promise<Owed | null> {
  let cwd: string
  let briefing: Awaited<ReturnType<typeof buildBriefing>>
  try {
    cwd = await $.session.cwd()
    briefing = await buildBriefing(io, cwd)
    if (!briefing) return null
  } catch {
    // A store that cannot be read: the boundary passes without a note.
    return null
  }
  try {
    const appended = await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: briefing.text }] }, agentId })
    // A plugin above refused the row: nothing was stored, and asking again gets the same answer.
    if (appended?.deny !== undefined) return null
  } catch {
    // A loop not running yet (a subagent registers just after its spawn) or already ended.
    const attempts = owed.attempts + 1
    return attempts >= MAX_ATTEMPTS ? null : { boundary: owed.boundary, attempts }
  }
  try {
    await recordBriefing(io, cwd, owed.boundary, briefing)
  } catch {
    // Delivered; only the stat is lost.
  }
  return null
}

/**
 * Claim the session before a boundary, because the classic SubagentStart and
 * SessionStart(compact) hooks beneath run inside `next` and must already see the claim
 * (after a /clear nothing has claimed the new id yet). Resolves to the io to use while
 * the claim stands, or null: unclaimed, the binary briefs and the mod owes nothing.
 * Never throws. Top-level because it takes `$`: the validator follows `$` nowhere else.
 */
async function holdClaim($: ModEngine, wrapIo: (io: Io) => Io, claim: (io: Io, id: string) => Promise<boolean>): Promise<Io | null> {
  try {
    const io = wrapIo(modIo(hostOf($)))
    return (await claim(io, await $.session.id())) ? io : null
  } catch {
    return null
  }
}

/** The id the pane is opened under, and the `requestId` its hooks match. */
const PANE_ID = 'cassandra'

// Where the pane keeps what it remembers between redraws. One const each, because the
// validator lists a module's state only from literal references.
/** The hash of the selected record. */
const SELECTED = { plugin: 'cassandra', key: 'selected' } as const
/** Whether the bulk-forget confirmation is showing. */
const CONFIRM_ALL = { plugin: 'cassandra', key: 'confirmAll' } as const
/** A revision the render hook reads, so a bump draws an open pane again. */
const REV = { plugin: 'cassandra', key: 'rev' } as const
/** The outcome of the last action, when it failed. */
const NOTICE = { plugin: 'cassandra', key: 'notice' } as const
/** The tab the list shows. */
const TAB = { plugin: 'cassandra', key: 'tab' } as const
/** Whether the marked row is open in place. */
const EXPANDED = { plugin: 'cassandra', key: 'expanded' } as const
/** Whether the marked record's full output shows. */
const SHOW_FULL = { plugin: 'cassandra', key: 'showFull' } as const
/** The page of the full output that shows, from 0. */
const FULL_PAGE = { plugin: 'cassandra', key: 'fullPage' } as const
/** The search the list is filtered by, '' for none. */
const QUERY = { plugin: 'cassandra', key: 'query' } as const
/** The hash of the record whose retest waits for its confirm. */
const CONFIRM_RETEST = { plugin: 'cassandra', key: 'confirmRetest' } as const
/** The warning this session raised last, until dismissed. */
const LAST_WARNING = { plugin: 'cassandra', key: 'lastWarning' } as const
/** Whether the search field is open. */
const SEARCHING = { plugin: 'cassandra', key: 'searching' } as const
/** Whether the key list is open. */
const SHOW_KEYS = { plugin: 'cassandra', key: 'showKeys' } as const

const TAB_IDS: readonly PaneTab[] = ['history', 'warnings', 'stale', 'denied']

/**
 * What one surface last drew: the row it marked selected, every row it showed, every record
 * it counted, the whole list the marker walks (the tab and search applied, in order), the
 * marked record when it offered a retest, and the record whose retest confirm it drew whole.
 */
export interface DrawnPane {
  selected: string | null
  hashes: ReadonlySet<string>
  counted: ReadonlySet<string>
  rows: readonly string[]
  retestable: string | null
  /** The record whose whole call this surface drew under a Run, when it did. */
  confirming: string | null
  /** The digest of the call that confirm showed (callDigest), so Run runs that call or nothing. */
  shown: string | null
  /** How many pages of the full output this surface could show, 0 when it drew none. */
  fullPages: number
}

/** What each surface last drew, by surface. Forget acts only on rows the person saw. */
export type DrawnBySurface = Map<string, DrawnPane>

/** What /cassandra pane answers once the pane is open. */
const PANE_OPENED = 'Opened the Cassandra pane.'

/** What /cassandra pane answers where nothing can show a pane. */
const PANE_HEADLESS = 'The pane needs an interactive session.'

/** What /cassandra pane answers to an origin that is not the person's own. */
const PANE_REFUSAL = 'The pane opens only from your own /cassandra command.'

/**
 * Bump the pane's revision, so an open pane that read it draws again. Never throws.
 * Top-level because it takes `$`: the validator follows `$` nowhere else.
 */
async function bumpRev($: ModEngine): Promise<void> {
  try {
    const { value } = await $.state.get(REV)
    await $.state.set(REV, (value ?? 0) + 1)
  } catch {
    // An open pane redraws at its next change instead.
  }
}

/** Re-read the live count and pin it under the prompt, and redraw an open pane. Never throws; a failure keeps the old line. */
async function refreshStatus($: ModEngine, io: Io): Promise<void> {
  try {
    $.ui.status(await statusText(io, await $.session.cwd()))
  } catch {
    // The previous line stays until the next change.
  }
  await dropEmptyConfirm($, io)
  await bumpRev($)
}

/**
 * Drop a bulk-forget confirmation once the store is empty, however it emptied, so the
 * confirm row does not come back with the next record. Never throws.
 */
async function dropEmptyConfirm($: ModEngine, io: Io): Promise<void> {
  try {
    if ((await $.state.get(CONFIRM_ALL)).value !== true) return
    if ((await listRecords(io, await pathsFor(io, await $.session.cwd()))).length === 0) await $.state.set(CONFIRM_ALL, false)
  } catch {
    // The confirmation stays until the person answers it.
  }
}

/** What the pane remembers, read fresh; a value never set reads as a fresh pane's. Rejects when the state cannot be read. */
async function readView($: ModEngine): Promise<PaneView> {
  const tab = (await $.state.get(TAB)).value
  return {
    tab: tab !== undefined && TAB_IDS.includes(tab) ? tab : 'history',
    selected: (await $.state.get(SELECTED)).value ?? null,
    expanded: (await $.state.get(EXPANDED)).value ?? false,
    confirmAll: (await $.state.get(CONFIRM_ALL)).value ?? false,
    confirmRetest: (await $.state.get(CONFIRM_RETEST)).value ?? null,
    showFull: (await $.state.get(SHOW_FULL)).value ?? false,
    query: (await $.state.get(QUERY)).value ?? '',
    notice: (await $.state.get(NOTICE)).value ?? null,
    lastWarning: (await $.state.get(LAST_WARNING)).value ?? null,
  }
}

/** Whether the search field and the key list are open, and the full output's page, for a model. Rejects when the state cannot be read. */
async function readExtras($: ModEngine, model: PaneModel): Promise<PaneExtras> {
  return {
    searching: (await $.state.get(SEARCHING)).value ?? false,
    showKeys: (await $.state.get(SHOW_KEYS)).value ?? false,
    keyRows: keyListRows(model).length,
    fullPage: (await $.state.get(FULL_PAGE)).value ?? 0,
  }
}

/**
 * Open the pane, unless nothing can show one. Neither confirmation survives into a fresh
 * open, nor an open search field, nor an old notice, nor a later page of the full output.
 * Rejects on a host failure.
 */
async function openPane($: ModEngine): Promise<{ text: string; exitCode: number }> {
  if ((await $.session.surfaces()).length === 0) return { text: PANE_HEADLESS, exitCode: 1 }
  await $.state.set(CONFIRM_ALL, false)
  await $.state.set(CONFIRM_RETEST, null)
  await $.state.set(SEARCHING, false)
  await $.state.set(NOTICE, null)
  await $.state.set(FULL_PAGE, 0)
  await $.ui.open({ id: PANE_ID, title: 'Cassandra', focus: true, closeOnEscape: true })
  return { text: PANE_OPENED, exitCode: 0 }
}

/**
 * Draw the pane from the store and the view. A store or view that cannot be read draws
 * the error line; a drawing that fails falls back to what lies beneath. Never throws
 * of its own.
 */
async function renderPane($: ModEngine, e: PaneRenderEvent, next: Next<PaneRenderEvent, unknown>, wrapIo: (io: Io) => Io, drawn: DrawnBySurface): Promise<unknown> {
  try {
    const columns = e.props.bodyColumns ?? e.viewport?.columns ?? 80
    const bodyRows = e.props.scroll?.bodyRows ?? e.viewport?.rows ?? 24
    let model: PaneModel
    let extras: PaneExtras | undefined
    const io = wrapIo(modIo(hostOf($)))
    try {
      // Read so that a bump of the revision draws the pane again.
      await $.state.get(REV)
      model = await paneModel(io, await $.session.cwd(), await readView($), await $.session.id())
      extras = await readExtras($, model)
    } catch {
      model = unreadableModel()
    }
    const layout = layoutOf(model, columns, bodyRows, extras)
    const confirming = layout.retest !== null && layout.retest !== 'too-small'
    const { start, count } = layout.list
    // Not state: a render may not write it, and a press only needs this session's own drawing.
    drawn.set(e.surface ?? '', {
      selected: model.selected,
      hashes: new Set(model.rows.slice(start, start + count).map((r) => r.hash)),
      counted: new Set(model.hashes),
      rows: model.rows.map((r) => r.hash),
      retestable: model.detail?.retest.ok === true ? model.selected : null,
      confirming: confirming ? model.selected : null,
      shown: confirming && model.detail?.retest.ok === true
        ? await callDigest(io, model.detail.retest.tool, model.detail.retest.input, model.detail.retest.cwd) : null,
      fullPages: layout.full?.pages ?? 0,
    })
    return drawPane($.ui.resolve(e), model, columns, layout)
  } catch {
    return next(e)
  }
}

/** The record a row key names, when it is a row still remembered; null otherwise. */
async function rowHash($: ModEngine, io: Io, key: string): Promise<string | null> {
  const r = await resolveHash(io, await pathsFor(io, await $.session.cwd()), key.slice(ROW_KEY_PREFIX.length))
  return r.ok ? r.hash : null
}

/**
 * Select the row a key names, when it is a row still remembered; another row than the one
 * selected starts the full output from its first page. Never throws.
 */
async function selectRow($: ModEngine, wrapIo: (io: Io) => Io, key: string | undefined): Promise<void> {
  if (!key?.startsWith(ROW_KEY_PREFIX)) return
  try {
    const hash = await rowHash($, wrapIo(modIo(hostOf($))), key)
    if (hash === null) return
    if (hash !== ((await $.state.get(SELECTED)).value ?? null)) await $.state.set(FULL_PAGE, 0)
    await $.state.set(SELECTED, hash)
  } catch {
    // The selection stays where it was.
  }
}

/**
 * The row this surface drew as marked: the selection when it was drawn here, else the row
 * drawn as selected. Rejects when the state cannot be read.
 */
async function markedRow($: ModEngine, drawn: DrawnPane): Promise<string | null> {
  const selected = (await $.state.get(SELECTED)).value ?? null
  return selected !== null && drawn.hashes.has(selected) ? selected : drawn.selected
}

/**
 * Enter on a row, or a click: the marked row opens or closes in place; another row is
 * marked instead (the focus hook has usually marked it already). Either way the full output
 * starts from its first page. Rejects on a state failure.
 */
async function pressRow($: ModEngine, io: Io, key: string, drawn: DrawnPane | undefined): Promise<void> {
  const hash = await rowHash($, io, key)
  if (hash === null) return
  await $.state.set(FULL_PAGE, 0)
  if (drawn && hash === (await markedRow($, drawn))) {
    await $.state.set(SELECTED, hash)
    await $.state.set(EXPANDED, !((await $.state.get(EXPANDED)).value ?? false))
    return
  }
  await $.state.set(SELECTED, hash)
}

/**
 * `j` or `k`: mark the next or previous row of the list this surface drew, stopping at
 * either end. It moves from the selection wherever it is in that list, not only inside the
 * window shown, so a held key walks past the window's edge. A retest waiting for its
 * confirm is dropped: the confirm showed the old row's call. Resolves to the key of the row
 * now marked, for the ring to follow; null when nothing moved. Rejects on a state failure.
 */
async function moveMarker($: ModEngine, drawn: DrawnPane | undefined, by: 1 | -1): Promise<string | null> {
  if (!drawn || drawn.rows.length === 0) return null
  const selected = (await $.state.get(SELECTED)).value ?? null
  const start = selected !== null && drawn.rows.includes(selected) ? selected : drawn.selected
  const from = drawn.rows.indexOf(start ?? '')
  const to = drawn.rows[Math.min(drawn.rows.length - 1, Math.max(0, (from < 0 ? 0 : from) + by))]!
  await $.state.set(SELECTED, to)
  await $.state.set(SHOW_FULL, false)
  await $.state.set(FULL_PAGE, 0)
  await $.state.set(CONFIRM_RETEST, null)
  return `${ROW_KEY_PREFIX}${to.slice(0, 8)}`
}

/**
 * Switch the list to `tab`: the marked row stays marked when the new tab lists it, else the
 * tab's first row is marked, closed. A waiting retest is dropped, and the full output starts
 * from its first page. Rejects on a host failure.
 */
async function switchTab($: ModEngine, io: Io, cwd: string, tab: PaneTab): Promise<void> {
  const view = await readView($)
  const model = await paneModel(io, cwd, { ...view, tab }, await $.session.id())
  await $.state.set(TAB, tab)
  await $.state.set(CONFIRM_RETEST, null)
  await $.state.set(FULL_PAGE, 0)
  if (model.selected === view.selected) return
  await $.state.set(SELECTED, model.selected)
  await $.state.set(EXPANDED, false)
  await $.state.set(SHOW_FULL, false)
}

/**
 * `n` or `p`: show the next or previous page of the full output this surface drew, stopping
 * at its first and last page. Nothing drawn here, or no full output drawn, turns nothing.
 * Rejects on a state failure.
 */
async function turnPage($: ModEngine, drawn: DrawnPane | undefined, by: 1 | -1): Promise<void> {
  if (!drawn || drawn.fullPages === 0) return
  const last = drawn.fullPages - 1
  const at = Math.min(last, Math.max(0, (await $.state.get(FULL_PAGE)).value ?? 0))
  await $.state.set(FULL_PAGE, Math.min(last, Math.max(0, at + by)))
}

/** The tab a tab's Button or its hidden twin names; null for any other key. */
function tabOf(key: string): PaneTab | null {
  const id = key.startsWith(KEY_TAB_PREFIX) ? key.slice(KEY_TAB_PREFIX.length) : key.startsWith(KEY_TABKEY_PREFIX) ? key.slice(KEY_TABKEY_PREFIX.length) : null
  return TAB_IDS.find((t) => t === id) ?? null
}

/** What a search field's text is kept as: one line, trimmed. */
const searchText = (value: string): string => value.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim()

/** Run one forget for the pane: its failure becomes the notice, and any change redraws. Never throws. */
async function paneForget($: ModEngine, io: Io, run: () => Promise<CommandResult | null>, failure: string): Promise<void> {
  let notice: string | null
  try {
    const r = await run()
    if (r === null) {
      // Nothing seen to act on: redraw, so the person sees the store as it is now,
      // without the outcome of an older action beside it.
      await $.state.set(NOTICE, null).catch(() => undefined)
      await bumpRev($)
      return
    }
    notice = r.code === 0 ? null : r.text
  } catch {
    notice = failure
  }
  try {
    await $.state.set(NOTICE, notice)
  } catch {
    // The pane shows the outcome at its next redraw, or not at all.
  }
  await refreshStatus($, io)
}

/**
 * The record Forget acts on: a row this surface drew. The row focus selected, when it was
 * drawn here (the ring sits on it even before the redraw), else the row drawn as
 * selected. Null when nothing was drawn here or that record is gone.
 */
async function forgetTarget($: ModEngine, io: Io, cwd: string, drawn: DrawnPane | undefined): Promise<string | null> {
  if (!drawn) return null
  const target = await markedRow($, drawn)
  if (target === null) return null
  const stored = await listRecords(io, await pathsFor(io, cwd))
  return stored.some((r) => r.hash === target) ? target : null
}

/** The notice of a confirm that could not forget every record. */
const FORGET_ALL_FAILED = 'Could not forget every record.'

/**
 * Forget exactly the records this surface counted on its confirm button, and no others.
 * A newer record stays and is named in the notice; a counted record already gone is
 * skipped. Nothing drawn here, or nothing counted left, deletes nothing: the confirmation
 * drops and the pane redraws. A store that cannot be counted deletes nothing either, and
 * says so. Rejects on a state failure.
 */
async function confirmForgetAll($: ModEngine, io: Io, cwd: string, drawn: DrawnPane | undefined): Promise<void> {
  let stored: string[]
  try {
    stored = (await listRecords(io, await pathsFor(io, cwd))).map((r) => r.hash)
  } catch {
    await $.state.set(NOTICE, FORGET_ALL_FAILED)
    await bumpRev($)
    return
  }
  const targets = stored.filter((h) => drawn?.counted.has(h))
  if (stored.length === 0 || targets.length === 0) {
    // Nothing counted is left to confirm: drop the row and redraw the store as it is.
    await $.state.set(CONFIRM_ALL, false)
    await $.state.set(NOTICE, null)
    await bumpRev($)
    return
  }
  const kept = stored.length - targets.length
  await $.state.set(CONFIRM_ALL, false)
  let failed = false
  const paths = await pathsFor(io, cwd)
  for (const hash of targets) {
    try {
      if ((await forget(io, paths, hash, false)).code !== 0) failed = true
    } catch {
      failed = true
    }
  }
  // A delete that fails quietly leaves the record behind: count it as a failure.
  try {
    const left = new Set((await listRecords(io, paths)).map((r) => r.hash))
    if (targets.some((h) => left.has(h))) failed = true
  } catch {
    failed = true
  }
  const n = targets.length
  const notice = failed
    ? FORGET_ALL_FAILED
    : kept === 0 ? null : `Forgot ${n} ${n === 1 ? 'record' : 'records'}; ${kept} newer ${kept === 1 ? 'record was' : 'records were'} kept.`
  await $.state.set(NOTICE, notice).catch(() => undefined)
  await refreshStatus($, io)
}

/** What a press leaves to do once it is done: where the focus ring goes, and a retest to run. */
interface Pressed {
  /** The element the ring moves to (the row `j`/`k` marked, the search field `s` opened), or null. */
  ring: string | null
  /** The confirmed retest, run after the press so it holds up no other press while the call runs. */
  retest?: () => Promise<void>
}

/**
 * Run the retest the person confirmed, then show what it came to and redraw. Never throws.
 * Top-level because it takes `$`: the validator follows `$` nowhere else.
 */
async function retestConfirmed($: ModEngine, io: Io, hash: string, shown: string, retesting: Retesting, claimed: () => Promise<boolean>): Promise<void> {
  let notice: string | null
  try {
    notice = (await runRetest(retestHostOf($, claimed), io, hash, shown, retesting)).notice
  } catch {
    notice = 'The retest could not be run; nothing changed.'
  }
  await $.state.set(NOTICE, notice).catch(() => undefined)
  await refreshStatus($, io)
}

/**
 * Run: the retest this surface drew whole, and only that one. Anything else (no confirm
 * waiting, or one this surface could not show whole) drops the confirm and runs nothing.
 * Resolves to the run, for after the press. Rejects on a state failure.
 */
async function confirmRetest($: ModEngine, io: Io, drawn: DrawnPane | undefined, retesting: Retesting, claimed: () => Promise<boolean>): Promise<Pressed> {
  const hash = (await $.state.get(CONFIRM_RETEST)).value ?? null
  await $.state.set(CONFIRM_RETEST, null)
  await $.state.set(NOTICE, null)
  if (hash === null || drawn?.confirming !== hash || drawn.shown === null) return { ring: null }
  const shown = drawn.shown
  return { ring: null, retest: () => retestConfirmed($, io, hash, shown, retesting, claimed) }
}

/**
 * Act on a press in the pane, by the key of the Button pressed. Resolves to what is left to
 * do once the press is done (see Pressed). Never throws.
 */
async function onPanePress($: ModEngine, e: PressEvent, wrapIo: (io: Io) => Io, drawn: DrawnBySurface, retesting: Retesting, claimed: () => Promise<boolean>): Promise<Pressed> {
  const done = { ring: null }
  try {
    const io = wrapIo(modIo(hostOf($)))
    const cwd = await $.session.cwd()
    const here = drawn.get(e.surface ?? '')
    // A bar key's hidden twin acts as the key itself.
    const element = e.element.startsWith(KEY_TWIN_PREFIX) ? e.element.slice(KEY_TWIN_PREFIX.length) : e.element
    const tab = tabOf(element)
    if (tab !== null) {
      await switchTab($, io, cwd, tab)
      return done
    }
    switch (element) {
      case KEY_FORGET:
        await paneForget($, io, async () => {
          const target = await forgetTarget($, io, cwd, here)
          return target === null ? null : forget(io, await pathsFor(io, cwd), target, false)
        }, 'Could not forget the selected record.')
        return done
      // An old failure line must not sit beside the confirm row, nor outlive the cancel.
      case KEY_FORGET_ALL:
        await $.state.set(NOTICE, null)
        // Nothing to confirm on an empty store.
        if ((await listRecords(io, await pathsFor(io, cwd))).length > 0) await $.state.set(CONFIRM_ALL, true)
        return done
      case KEY_CANCEL:
        await $.state.set(NOTICE, null)
        await $.state.set(CONFIRM_ALL, false)
        return done
      case KEY_CONFIRM:
        await confirmForgetAll($, io, cwd, here)
        return done
      case KEY_DOWN:
        return { ring: await moveMarker($, here, 1) }
      case KEY_UP:
        return { ring: await moveMarker($, here, -1) }
      // Each reference spelled out: the validator lists state only from literal references.
      // The full output shows in the open detail, so opening it opens the row too.
      case KEY_FULL: {
        const full = !((await $.state.get(SHOW_FULL)).value ?? false)
        await $.state.set(SHOW_FULL, full)
        await $.state.set(FULL_PAGE, 0)
        if (full) await $.state.set(EXPANDED, true)
        return done
      }
      case KEY_NEXT_PAGE:
        await turnPage($, here, 1)
        return done
      case KEY_PREV_PAGE:
        await turnPage($, here, -1)
        return done
      case KEY_HELP:
        await $.state.set(SHOW_KEYS, !((await $.state.get(SHOW_KEYS)).value ?? false))
        return done
      case KEY_DISMISS:
        await $.state.set(LAST_WARNING, null)
        return done
      case KEY_SEARCH:
        await $.state.set(SEARCHING, true)
        return { ring: KEY_SEARCH_FIELD }
      case KEY_SEARCH_CLEAR:
        await $.state.set(QUERY, '')
        await $.state.set(SEARCHING, false)
        return done
      // Marks the retest as waiting for its confirm, which shows the whole call.
      case KEY_RETEST:
        if (here?.retestable) {
          await $.state.set(NOTICE, null)
          await $.state.set(CONFIRM_RETEST, here.retestable)
        }
        return done
      case KEY_RETEST_CANCEL:
        await $.state.set(NOTICE, null)
        await $.state.set(CONFIRM_RETEST, null)
        return done
      case KEY_RETEST_CONFIRM:
        return await confirmRetest($, io, here, retesting, claimed)
      default:
        if (element.startsWith(ROW_KEY_PREFIX)) await pressRow($, io, element, here).catch(() => undefined)
        return done
    }
  } catch {
    // The press changes nothing.
    return done
  }
}

/** Enter in the search field: apply what it holds (empty clears) and close it. Never throws. */
async function onPaneInput($: ModEngine, e: InputEvent): Promise<void> {
  if (e.element !== KEY_SEARCH_FIELD || e.kind !== 'submit') return
  try {
    await $.state.set(QUERY, searchText(e.value))
    await $.state.set(SEARCHING, false)
  } catch {
    // The search stays as it was.
  }
}

/**
 * Remember the warning this call raised, with its record as it stood then (before this call
 * settles it), so the pane's Just warned card shows what was warned, and redraw an open
 * pane. Never throws: a lost card must not cost the warning itself.
 */
async function noteWarning($: ModEngine, io: Io, call: Call, hash: string): Promise<void> {
  try {
    const r = await readRecord(io, await pathsFor(io, call.cwd), hash).catch(() => null)
    const snapshot = r === null ? {} : { count: r.count, lastSeen: r.lastSeen, evidence: evidence(r) }
    await $.state.set(LAST_WARNING, { hash, at: io.now(), ...snapshot })
  } catch {
    // The card misses this warning; the agent still gets it.
  }
  await bumpRev($)
}

/** What /cassandra shows when it cannot answer; the engine already labels it "cassandra: ". */
const COMMAND_FALLBACK = 'could not read what this project remembers.'

/** Origins that are a person typing, or a headless run someone started on purpose. */
const BULK_ORIGINS = new Set(['composer', 'bridge', 'sdk'])

/** What /cassandra answers to a bulk forget that did not come from a person or a headless run. */
const BULK_REFUSAL = 'forget --all only runs when you type it yourself; nothing was forgotten.'

/** Serve /cassandra with the CLI's own text. Never throws. */
async function answerCommand($: ModEngine, io: Io, args: string | undefined, origin: CommandEvent['origin']): Promise<{ text: string; exitCode: number }> {
  try {
    // A bare /cassandra may arrive with no args at all.
    const parts = (args ?? '').split(/\s+/).filter(Boolean)
    // The pane is for the person: a plugin, a schedule or a peer may not open it.
    if (parts[0] === 'pane') return BULK_ORIGINS.has(origin?.kind ?? '') ? await openPane($) : { text: PANE_REFUSAL, exitCode: 1 }
    // Wiping every record is for a person or a headless run; a plugin, a schedule or a peer may not.
    if (parts[0] === 'forget' && parts.includes('--all') && !BULK_ORIGINS.has(origin?.kind ?? '')) {
      return { text: BULK_REFUSAL, exitCode: 1 }
    }
    const r = await runCommand(io, await $.session.cwd(), parts)
    // Only a forget that forgot something changes the count (a partial --all still starts so).
    if (parts[0] === 'forget' && r.text.startsWith('Forgot')) await refreshStatus($, io)
    return { text: r.text, exitCode: r.code }
  } catch {
    return { text: COMMAND_FALLBACK, exitCode: 1 }
  }
}

/** The tool's own arguments, as the classic hook's `tool_input` carries them. */
export function toolInput(e: ToolCallEvent): Record<string, unknown> {
  return Object.fromEntries(Object.entries(e).filter(([k]) => !RESERVED.has(k)))
}

/** Serve one of Cassandra's own tools. Never calls `next`: nothing beneath serves them. */
async function answerTool($: ModEngine, wrapIo: (io: Io) => Io, e: ToolCallEvent): Promise<ToolCallOutcome> {
  try {
    const io = wrapIo(modIo(hostOf($)))
    const cwd = await $.session.cwd()
    const input = toolInput(e)
    const resolving = e.tool === `${TOOL_PREFIX}${RESOLVE_TOOL.name}`
    const text = resolving ? await resolveFailure(io, cwd, input) : await queryText(io, cwd, input)
    if (resolving && text.startsWith('cassandra: Forgot')) await refreshStatus($, io)
    return { result: text }
  } catch {
    return { result: 'cassandra: could not answer.' }
  }
}

/**
 * The text of an errored result that means the call never ran. A permission rule or an
 * ungranted approval does not come back as `{ deny }` from the engine: it is an errored,
 * non-aborted result with this text (found by a spike against the real engine). The
 * classic binary records nothing for these, so neither does the mod.
 */
export const NOT_RUN_TEXT = /^(?:Permission to use .* has been denied\.|[^\n]*requires approval[^\n]*|[^\n]*haven't granted[^\n]*)$/

/**
 * A Bash result the engine wrapped as a tool-use error: input it refused or a hook that
 * blocked the call, so the command never ran. A command that ran and failed comes back
 * as plain text (`Exit code N …`). Bash only, because other tools use the same wrapper
 * for failures that did happen.
 */
export const BASH_NOT_RUN_TEXT = /^<tool_use_error>/

/**
 * What a call came to, from what the engine answered.
 *
 * An explicit `{ deny }` (from another plugin) is a denial. An errored result is the
 * user's interrupt when the dispatch was aborted, a call that never ran when the text
 * says a permission was refused (or, for Bash, the engine refused or a hook blocked it),
 * and otherwise a failure.
 */
export function outcomeOf(r: ToolCallOutcome, aborted: boolean, tool?: string): Outcome {
  if (r.deny !== undefined) return { kind: 'denial', reason: r.deny }
  if (r.isError === true) {
    if (aborted) return { kind: 'interrupt' }
    if (r.text !== undefined && NOT_RUN_TEXT.test(r.text)) return { kind: 'not_run' }
    if (tool === 'Bash' && r.text !== undefined && BASH_NOT_RUN_TEXT.test(r.text)) return { kind: 'not_run' }
    return { kind: 'failure', reason: r.text }
  }
  return { kind: 'success' }
}

/**
 * Run the pane's retest of a call and settle it as any call is settled, with no warning
 * before it: a pass forgets the record (with its fix note) and logs `retest_cleared`, a
 * failure updates the record and logs `retest_failed`; neither is a warning's outcome, so
 * no `false_positive` or `confirmed`. A call that never ran (a denial, a refused
 * permission, an interrupt) changes nothing. What it came to is left in `retesting` for
 * the retest that is waiting on it. The result comes back as the engine gave it.
 */
async function settleRetest($: ModEngine, io: Io, call: Call, hash: string, e: ToolCallEvent, next: Next<ToolCallEvent, ToolCallOutcome>, retesting: Retesting): Promise<ToolCallOutcome> {
  const result = await next(e)
  const entry = retesting.get(hash) ?? { state: 'running', cwd: call.cwd }
  try {
    const outcome = outcomeOf(result, next.signal?.aborted === true, call.tool)
    if (outcome.kind !== 'success' && outcome.kind !== 'failure') {
      retesting.set(hash, { ...entry, state: 'not_run' })
      return result
    }
    const changed = await settle(io, call, outcome, null)
    await appendStat(io, await pathsFor(io, call.cwd), { kind: outcome.kind === 'success' ? 'retest_cleared' : 'retest_failed', hash })
    retesting.set(hash, { ...entry, state: outcome.kind === 'success' ? 'passed' : 'failed' })
    if (changed) await refreshStatus($, io)
  } catch {
    // The call happened; only the bookkeeping is lost.
  }
  return result
}

/**
 * Cassandra as an in-process mod.
 *
 * One `tool.call` hook does what the binary needs four classic events and a pending
 * marker for: it checks before the call, runs it, and settles on the result it sees
 * directly. `agent.spawn` and `session.compact` owe a loop a note of the live failures,
 * which `session.append` hands over at that loop's next qualifying row. Everything is
 * wrapped: the call runs exactly once whatever the core does, and its result is never
 * lost or changed beyond the one added line of context.
 */
export function install(on: ModOn, wrapIo: (io: Io) => Io = (io) => io): void {
  let claimed: { id: string; root: string; at: number } | null = null
  // Notes owed to a loop ('main' or a subagent's id), handed over at that loop's next row:
  // a new subagent's loop is not running when its spawn resolves, and a row appended when
  // a compaction resolves lands before the boundary and is summarised away.
  const owed = new Map<string, Owed>()

  // Claim the session before the call, because the classic PreToolUse hook runs beneath
  // this one and must already see the claim. Lazily, on every call, because a /clear
  // changes the session id without a session.start. True only while the claim stands:
  // without it the binary still records, so the mod must not record as well.
  const claim = async (io: Io, id: string): Promise<boolean> => {
    // The data root can move after the first claim (the classic hooks may write the
    // pointer), so the claim is only reusable while the root it was made under holds.
    const root = await dataRoot(io).catch(() => null)
    if (root === null) return false
    if (claimed && claimed.id === id && claimed.root === root && Date.now() - claimed.at < MARKER_REFRESH_MS) return true
    if (!(await markModSession(io, id))) return false
    claimed = { id, root, at: Date.now() }
    return true
  }

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    try {
      const io = wrapIo(modIo(hostOf($)))
      await pruneModMarkers(io)
      await claim(io, await $.session.id())
    } catch {
      // The first tool call claims the session instead.
    }
    // Apart from the claim: an engine that refuses the tools costs only the tools.
    try {
      await $.tool.register(QUERY_TOOL)
      await $.tool.register(RESOLVE_TOOL)
    } catch {
      // The session goes on without Cassandra's tools.
    }
    // Apart from the tools: an engine that refuses the command costs only /cassandra.
    try {
      await $.command.register({ name: 'cassandra', description: 'Show what Cassandra remembers failing in this project', argumentHint: '[list | why <id> | forget <id> | forget --all | stats | pane]' })
    } catch {
      // The session goes on without /cassandra.
    }
    try {
      await refreshStatus($, wrapIo(modIo(hostOf($))))
    } catch {
      // No io to read with: the line stays empty until the store changes.
    }
    return started
  })

  on('session.end', async ($, e, next) => {
    try {
      await clearModSession(wrapIo(modIo(hostOf($))), e.sessionId)
    } catch {
      // Pruned after a day.
    }
    if (claimed?.id === e.sessionId) claimed = null
    owed.clear()
    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    // A precompute prepares a summary for a later compaction and installs nothing: the
    // window is intact, so nothing is owed and nothing is counted.
    if (e.trigger === 'precompute') return next(e)
    const io = await holdClaim($, wrapIo, claim)
    const compacted = await next(e)
    if (!io || compacted?.skip !== undefined) return compacted
    owed.set(e.agentId ?? 'main', { boundary: 'compaction', attempts: 0 })
    if (e.agentId !== undefined) return compacted
    try {
      await bumpCompactions(io, await pathsFor(io, await $.session.cwd()), await $.session.id())
    } catch {
      // A missed count only blurs one boundary attribution.
    }
    return compacted
  })

  on('agent.spawn', async ($, e, next) => {
    const io = await holdClaim($, wrapIo, claim)
    const spawned = await next(e)
    // A fork inherits the transcript and already sees the failures.
    if (io && e.subagentType !== 'fork' && spawned?.deny === undefined && spawned?.agentId) {
      owed.set(spawned.agentId, { boundary: 'subagent', attempts: 0 })
    }
    return spawned
  })

  on('session.append', async ($, e, next) => {
    const stored = await next(e)
    try {
      const loop = e.agentId ?? 'main'
      const entry = owed.get(loop)
      // The compaction's own rows come before its boundary; a row of ours is our note.
      if (!entry || e.door === 'compaction' || (e.origin?.kind === 'plugin' && e.origin.name === PLUGIN_NAME)) return stored
      // A subagent's opening rows (its prompt, its attachments) arrive before its loop is
      // registered, where the append is refused. Its first tool result means it is running
      // and will make another request, so the note is read; it never lands between the
      // blocks of one response. A subagent that never uses a tool gets no note.
      if (entry.boundary === 'subagent' && e.door !== 'tool-result') return stored
      // Deleted first, so the note's own append never hands it over again.
      owed.delete(loop)
      const again = await handOver($, wrapIo(modIo(hostOf($))), entry, e.agentId)
      // Re-owed only if no newer boundary has owed this loop a note in the meantime.
      if (again && !owed.has(loop)) owed.set(loop, again)
    } catch {
      // The row is stored; only the note is lost.
    }
    return stored
  })

  on('command.run', { command: 'cassandra' }, async ($, e) => {
    let io: Io
    try {
      io = wrapIo(modIo(hostOf($)))
    } catch {
      return { text: COMMAND_FALLBACK, exitCode: 1 }
    }
    return answerCommand($, io, e.args, e.origin)
  })

  const drawn: DrawnBySurface = new Map()
  // The retests the pane started, until the tracked hook below has settled each one.
  const retesting: Retesting = new Map()
  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e, next) => renderPane($, e, next, wrapIo, drawn))

  // Presses and focus moves run one at a time, in order, so a Forget reads the selection
  // the press or the move before it left.
  let pressing: Promise<unknown> = Promise.resolve()
  on('ui.press', { component: 'Pane', requestId: PANE_ID }, async ($, e, next) => {
    const claimed = async (): Promise<boolean> => claim(wrapIo(modIo(hostOf($))), await $.session.id())
    const done = pressing.then(() => onPanePress($, e, wrapIo, drawn, retesting, claimed))
    pressing = done
    const { ring, retest } = await done
    // A press that fails beneath still counts as taken here: the action already ran.
    const pressed = await next(e).catch(() => ({ element: e.element }))
    // After the press, never inside it: the move raises ui.focus, which waits its turn behind this press.
    if (ring !== null) await $.ui.focus({ requestId: PANE_ID, key: ring }).catch(() => undefined)
    // Outside the queue, so the pane still answers while the call runs (or its permission prompt waits).
    if (retest) await retest()
    return pressed
  })

  on('ui.input', { component: 'Pane', requestId: PANE_ID }, async ($, e, next) => {
    const done = pressing.then(() => onPaneInput($, e))
    pressing = done
    await done
    return next(e).catch(() => ({ element: e.element, value: e.value }))
  })

  // The element the ring was last moved onto, by surface, so a backward walk onto a hidden twin is told apart.
  const focused = new Map<string, string>()
  on('ui.focus', { component: 'Pane', requestId: PANE_ID }, async ($, e, next) => {
    const twin = e.element === undefined ? undefined : twinTarget(e.element, focused.get(e.surface ?? '') ?? null)
    // Backward past the first tab: the ring stays where it is.
    if (twin === null) return {}
    const element = twin ?? e.element
    const done = pressing.then(() => selectRow($, wrapIo, element)).catch(() => undefined)
    pressing = done
    await done
    // A move that fails beneath leaves the ring where it was.
    try {
      const moved = await next(twin === undefined ? e : { ...e, element: twin })
      if (element === undefined) focused.delete(e.surface ?? '')
      else focused.set(e.surface ?? '', element)
      return moved
    } catch {
      return { deny: 'cassandra: the focus could not move.' }
    }
  })

  on('tool.call', { tool: new RegExp(`^${TOOL_PREFIX}(?:${QUERY_TOOL.name}|${RESOLVE_TOOL.name})$`) }, async ($, e) => answerTool($, wrapIo, e))

  on('tool.call', { tool: TRACKED }, async ($, e, next) => {
    let io: Io
    let call: Call
    let warning: Warning | null = null
    let retested: string | null = null
    let refused: string | null = null
    try {
      io = wrapIo(modIo(hostOf($)))
      const sessionId = await $.session.id()
      // An unclaimed session is the binary's: stand aside through the same path as a core error.
      if (!(await claim(io, sessionId))) throw new Error('cassandra: session not claimed')
      // A surface list that cannot be read only words the warning without the pane.
      const surfaces = await $.session.surfaces().catch(() => [])
      call = { tool: e.tool, input: toolInput(e), cwd: await $.session.cwd(), sessionId, agentId: e.agentId, paneAvailable: surfaces.length > 0 }
      // The pane's own retest, raised by this plugin: the person asked for it, so it is not
      // warned about. A model's call of the same fingerprint is any other call.
      const hash = retesting.size > 0 && next.origin?.plugin === PLUGIN_NAME ? await callHash(io, call) : null
      const pending = hash === null ? undefined : retesting.get(hash)
      if (hash !== null && pending?.state === 'pending') {
        // It runs only from the directory its confirm showed.
        if (call.cwd !== pending.cwd) {
          refused = `Retest refused: the shell is now in ${call.cwd}, not ${pending.cwd}.`
          retesting.set(hash, { ...pending, state: 'not_run', reason: refused })
        } else {
          retesting.set(hash, { ...pending, state: 'running' })
          retested = hash
        }
      } else {
        warning = await check(io, call)
      }
    } catch {
      return next(e)
    }
    if (refused !== null) return { deny: refused }
    if (retested !== null) return settleRetest($, io, call, retested, e, next, retesting)
    if (warning) await noteWarning($, io, call, warning.hash)

    const result = await next(e)

    try {
      const changed = await settle(io, call, outcomeOf(result, next.signal?.aborted === true, call.tool), warning?.hash ?? null)
      if (changed) await refreshStatus($, io)
    } catch {
      // The call happened; only the bookkeeping is lost.
    }
    if (!warning || result?.deny !== undefined) return result
    return { ...result, context: [...(result.context ?? []), warning.text] }
  })
}
