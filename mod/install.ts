import { forget } from '../src/commands/forget.ts'
import { runCommand, type CommandResult } from '../src/commands/run.ts'
import { buildBriefing, check, recordBriefing, settle, type Call, type Outcome, type Warning } from '../src/core/engine.ts'
import type { Io } from '../src/core/io.ts'
import { removeFix } from '../src/core/fixes.ts'
import { paneModel, unreadableModel, type PaneModel, type PaneView } from '../src/core/pane.ts'
import { dataRoot, pathsFor } from '../src/core/paths.ts'
import { statusText } from '../src/core/status.ts'
import { bumpCompactions, clearModSession, markModSession, pruneModMarkers } from '../src/core/session.ts'
import type { BriefBoundary } from '../src/core/stats.ts'
import { QUERY_TOOL, RESOLVE_TOOL, TOOL_PREFIX, queryText, resolveFailure } from '../src/core/tools.ts'
import { listRecords } from '../src/core/record.ts'
import { resolveHash } from '../src/core/resolve.ts'
import { modIo, type ModHost } from '../src/io/mod.ts'
import { KEY_CANCEL, KEY_CONFIRM, KEY_FORGET, KEY_FORGET_ALL, ROW_KEY_PREFIX, drawPane, paneLayout, type Elements } from './pane.tsx'

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
  tool: { register(spec: { name: string; description: string; inputSchema?: Record<string, unknown> }): Promise<unknown> }
  command: { register(spec: { name: string; description?: string; argumentHint?: string }): Promise<unknown> }
  state: {
    get<K extends keyof PaneState>(ref: PaneRef<K>): Promise<{ value: PaneState[K] | undefined; version: number }>
    set<K extends keyof PaneState>(ref: PaneRef<K>, value: PaneState[K]): Promise<unknown>
  }
  ui: { status(text: string | undefined): void; open(args: OpenArgs): Promise<unknown>; resolve(e: PaneRenderEvent): Elements }
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

/** A hook's `next`, which carries the dispatch's abort signal. */
export type Next<E, R> = ((e: E) => Promise<R>) & { signal?: AbortSignal }

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

/** What one surface last drew: the row it marked selected, every row it showed, and every record it counted. */
export interface DrawnPane {
  selected: string | null
  hashes: ReadonlySet<string>
  counted: ReadonlySet<string>
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

/** What the pane remembers, read fresh. Rejects when the state cannot be read. */
async function readView($: ModEngine): Promise<PaneView> {
  const selected = (await $.state.get(SELECTED)).value ?? null
  const confirmAll = (await $.state.get(CONFIRM_ALL)).value ?? false
  const notice = (await $.state.get(NOTICE)).value ?? null
  return { selected, confirmAll, notice }
}

/**
 * Open the pane, unless nothing can show one. The confirmation never survives into a
 * fresh open, and neither does an old notice. Rejects on a host failure.
 */
async function openPane($: ModEngine): Promise<{ text: string; exitCode: number }> {
  if ((await $.session.surfaces()).length === 0) return { text: PANE_HEADLESS, exitCode: 1 }
  await $.state.set(CONFIRM_ALL, false)
  await $.state.set(NOTICE, null)
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
    const layout = paneLayout(e.props.scroll?.bodyRows ?? e.viewport?.rows ?? 24)
    let model: PaneModel
    try {
      // Read so that a bump of the revision draws the pane again.
      await $.state.get(REV)
      model = await paneModel(wrapIo(modIo(hostOf($))), await $.session.cwd(), await readView($), layout.maxRows)
    } catch {
      model = unreadableModel()
    }
    // Not state: a render may not write it, and a press only needs this session's own drawing.
    drawn.set(e.surface ?? '', { selected: model.selected, hashes: new Set(model.rows.map((r) => r.hash)), counted: new Set(model.hashes) })
    return drawPane($.ui.resolve(e), model, columns, layout)
  } catch {
    return next(e)
  }
}

/** Select the row a key names, when it is a row still remembered. Never throws. */
async function selectRow($: ModEngine, wrapIo: (io: Io) => Io, key: string | undefined): Promise<void> {
  if (!key?.startsWith(ROW_KEY_PREFIX)) return
  try {
    const io = wrapIo(modIo(hostOf($)))
    const r = await resolveHash(io, await pathsFor(io, await $.session.cwd()), key.slice(ROW_KEY_PREFIX.length))
    if (r.ok) await $.state.set(SELECTED, r.hash)
  } catch {
    // The selection stays where it was.
  }
}

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

/** Act on a press in the pane, by the key of the Button pressed. Never throws. */
/**
 * The record Forget acts on: a row this surface drew. The row focus selected, when it was
 * drawn here (the ring sits on it even before the redraw), else the row drawn as
 * selected. Null when nothing was drawn here or that record is gone.
 */
async function forgetTarget($: ModEngine, io: Io, cwd: string, drawn: DrawnPane | undefined): Promise<string | null> {
  if (!drawn) return null
  const selected = (await $.state.get(SELECTED)).value ?? null
  const target = selected !== null && drawn.hashes.has(selected) ? selected : drawn.selected
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
      if ((await forget(io, paths, hash, false)).code !== 0 || !(await removeFix(io, paths, hash))) failed = true
    } catch {
      failed = true
    }
  }
  const n = targets.length
  const notice = failed
    ? FORGET_ALL_FAILED
    : kept === 0 ? null : `Forgot ${n} ${n === 1 ? 'record' : 'records'}; ${kept} newer ${kept === 1 ? 'record was' : 'records were'} kept.`
  await $.state.set(NOTICE, notice).catch(() => undefined)
  await refreshStatus($, io)
}

async function onPanePress($: ModEngine, e: PressEvent, wrapIo: (io: Io) => Io, drawn: DrawnBySurface): Promise<void> {
  try {
    const io = wrapIo(modIo(hostOf($)))
    const cwd = await $.session.cwd()
    switch (e.element) {
      case KEY_FORGET:
        await paneForget($, io, async () => {
          const target = await forgetTarget($, io, cwd, drawn.get(e.surface ?? ''))
          return target === null ? null : forget(io, await pathsFor(io, cwd), target, false)
        }, 'Could not forget the selected record.')
        return
      // An old failure line must not sit beside the confirm row, nor outlive the cancel.
      case KEY_FORGET_ALL:
        await $.state.set(NOTICE, null)
        // Nothing to confirm on an empty store.
        if ((await listRecords(io, await pathsFor(io, cwd))).length > 0) await $.state.set(CONFIRM_ALL, true)
        return
      case KEY_CANCEL:
        await $.state.set(NOTICE, null)
        await $.state.set(CONFIRM_ALL, false)
        return
      case KEY_CONFIRM:
        await confirmForgetAll($, io, cwd, drawn.get(e.surface ?? ''))
        return
      default:
        await selectRow($, wrapIo, e.element).catch(() => undefined)
    }
  } catch {
    // The press changes nothing.
  }
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
  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e, next) => renderPane($, e, next, wrapIo, drawn))

  // Presses and focus moves run one at a time, in order, so a Forget reads the selection
  // the press or the move before it left.
  let pressing: Promise<void> = Promise.resolve()
  on('ui.press', { component: 'Pane', requestId: PANE_ID }, async ($, e, next) => {
    const done = pressing.then(() => onPanePress($, e, wrapIo, drawn))
    pressing = done
    await done
    // A press that fails beneath still counts as taken here: the action already ran.
    return next(e).catch(() => ({ element: e.element }))
  })

  on('ui.focus', { component: 'Pane', requestId: PANE_ID }, async ($, e, next) => {
    const done = pressing.then(() => selectRow($, wrapIo, e.element)).catch(() => undefined)
    pressing = done
    await done
    // A move that fails beneath leaves the ring where it was.
    return next(e).catch(() => ({ deny: 'cassandra: the focus could not move.' }))
  })

  on('tool.call', { tool: new RegExp(`^${TOOL_PREFIX}(?:${QUERY_TOOL.name}|${RESOLVE_TOOL.name})$`) }, async ($, e) => answerTool($, wrapIo, e))

  on('tool.call', { tool: TRACKED }, async ($, e, next) => {
    let io: Io
    let call: Call
    let warning: Warning | null
    try {
      io = wrapIo(modIo(hostOf($)))
      const sessionId = await $.session.id()
      // An unclaimed session is the binary's: stand aside through the same path as a core error.
      if (!(await claim(io, sessionId))) throw new Error('cassandra: session not claimed')
      call = { tool: e.tool, input: toolInput(e), cwd: await $.session.cwd(), sessionId, agentId: e.agentId }
      warning = await check(io, call)
    } catch {
      return next(e)
    }

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
