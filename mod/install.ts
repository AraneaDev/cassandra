import { runCommand } from '../src/commands/run.ts'
import { buildBriefing, callHash, check, recordBriefing, settle, type Call, type Warning } from '../src/core/engine.ts'
import type { Io } from '../src/core/io.ts'
import { lastWarningOf, paneModel, unreadableModel, type PaneModel } from '../src/core/pane.ts'
import { dataRoot, pathsFor } from '../src/core/paths.ts'
import { statusText } from '../src/core/status.ts'
import { bumpCompactions, clearModSession, markModSession, pruneModMarkers } from '../src/core/session.ts'
import { appendStat, type BriefBoundary } from '../src/core/stats.ts'
import { QUERY_TOOL, RESOLVE_TOOL, TOOL_PREFIX, queryText, resolveFailure } from '../src/core/tools.ts'
import { listRecords } from '../src/core/record.ts'
import { modIo, type ModHost } from '../src/io/mod.ts'
import { TRACKED, outcomeOf, toolInput } from './calls.ts'
import { drawnOf, type DrawnBySurface } from './drawn.ts'
import type { CommandEvent, ModEngine, ModOn, Next, PaneRenderEvent, PaneState, ToolCallEvent, ToolCallOutcome } from './engine.ts'
import { layoutOf, type PaneExtras } from './layout.ts'
import { drawPane, twinTarget } from './pane.tsx'
import { onPaneInput, onPanePress, selectRow, type PaneHost } from './press.ts'
import { retestVerdict, runRetest, type RetestHost, type Retesting } from './retest.ts'
import { readExtras, readView, type PaneStore } from './view.ts'

/** A note owed to a loop: which boundary it crossed, and how many appends were refused. */
export interface Owed {
  boundary: BriefBoundary
  attempts: number
}

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
/** The hash of the record that page was turned on; any other record shows its first page. */
const FULL_PAGE_OF = { plugin: 'cassandra', key: 'fullPageOf' } as const
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

/**
 * The pane's values, each key spelled out with its own reference for the same reason as
 * `hostOf`: the validator follows `$` only into a function declared in this file, and lists
 * state only from literal references.
 */
export function storeOf($: ModEngine): PaneStore {
  const get = async (key: keyof PaneState): Promise<unknown> => {
    switch (key) {
      case 'selected': return (await $.state.get(SELECTED)).value
      case 'confirmAll': return (await $.state.get(CONFIRM_ALL)).value
      case 'rev': return (await $.state.get(REV)).value
      case 'notice': return (await $.state.get(NOTICE)).value
      case 'tab': return (await $.state.get(TAB)).value
      case 'expanded': return (await $.state.get(EXPANDED)).value
      case 'showFull': return (await $.state.get(SHOW_FULL)).value
      case 'fullPage': return (await $.state.get(FULL_PAGE)).value
      case 'fullPageOf': return (await $.state.get(FULL_PAGE_OF)).value
      case 'query': return (await $.state.get(QUERY)).value
      case 'confirmRetest': return (await $.state.get(CONFIRM_RETEST)).value
      case 'lastWarning': return (await $.state.get(LAST_WARNING)).value
      case 'searching': return (await $.state.get(SEARCHING)).value
      case 'showKeys': return (await $.state.get(SHOW_KEYS)).value
    }
  }
  const set = (key: keyof PaneState, value: unknown): Promise<unknown> => {
    switch (key) {
      case 'selected': return $.state.set(SELECTED, value as PaneState['selected'])
      case 'confirmAll': return $.state.set(CONFIRM_ALL, value as PaneState['confirmAll'])
      case 'rev': return $.state.set(REV, value as PaneState['rev'])
      case 'notice': return $.state.set(NOTICE, value as PaneState['notice'])
      case 'tab': return $.state.set(TAB, value as PaneState['tab'])
      case 'expanded': return $.state.set(EXPANDED, value as PaneState['expanded'])
      case 'showFull': return $.state.set(SHOW_FULL, value as PaneState['showFull'])
      case 'fullPage': return $.state.set(FULL_PAGE, value as PaneState['fullPage'])
      case 'fullPageOf': return $.state.set(FULL_PAGE_OF, value as PaneState['fullPageOf'])
      case 'query': return $.state.set(QUERY, value as PaneState['query'])
      case 'confirmRetest': return $.state.set(CONFIRM_RETEST, value as PaneState['confirmRetest'])
      case 'lastWarning': return $.state.set(LAST_WARNING, value as PaneState['lastWarning'])
      case 'searching': return $.state.set(SEARCHING, value as PaneState['searching'])
      case 'showKeys': return $.state.set(SHOW_KEYS, value as PaneState['showKeys'])
    }
  }
  return { get, set } as PaneStore
}

/** What the pane's presses, inputs and focus moves act through, each call spelled out as in `hostOf`. */
function paneHostOf($: ModEngine, wrapIo: (io: Io) => Io, retesting: Retesting, claim: (io: Io, id: string) => Promise<boolean>): PaneHost {
  const claimed = async (): Promise<boolean> => claim(wrapIo(modIo(hostOf($))), await $.session.id())
  return {
    store: storeOf($),
    io: () => wrapIo(modIo(hostOf($))),
    cwd: () => $.session.cwd(),
    sessionId: () => $.session.id(),
    redraw: () => bumpRev($),
    refresh: (io) => refreshStatus($, io),
    retest: (io, hash, shown) => retestConfirmed($, io, hash, shown, retesting, claimed),
  }
}

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
  await $.state.set(FULL_PAGE_OF, null)
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
    const store = storeOf($)
    const elements = $.ui.resolve(e)
    try {
      // Read so that a bump of the revision draws the pane again.
      await store.get('rev')
      model = await paneModel(io, await $.session.cwd(), await readView(store), await $.session.id())
      // The key list counts its rows as this surface draws them: no search without a text field.
      extras = await readExtras(store, model, elements.Input !== undefined)
    } catch {
      model = unreadableModel()
    }
    const layout = layoutOf(model, columns, bodyRows, extras)
    // Not state: a render may not write it, and a press only needs this session's own drawing.
    drawn.set(e.surface ?? '', await drawnOf(io, model, layout))
    return drawPane(elements, model, columns, layout)
  } catch {
    return next(e)
  }
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
 * Remember the warning this call raised, with its record as it stood then (before this call
 * settles it), so the pane's Just warned card shows what was warned, and redraw an open
 * pane. Never throws: a lost card must not cost the warning itself.
 */
async function noteWarning($: ModEngine, io: Io, call: Call, hash: string): Promise<void> {
  try {
    await $.state.set(LAST_WARNING, await lastWarningOf(io, call.cwd, hash, call.sessionId))
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
    // A bare /cassandra you typed opens the pane where one can be shown; anywhere else it lists.
    if (parts.length === 0 && BULK_ORIGINS.has(origin?.kind ?? '')
      && (await $.session.surfaces().catch(() => [])).length > 0) return await openPane($)
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
 * Run the pane's retest of a call and settle it as any call is settled, with no warning
 * before it: a pass forgets the record (with its fix note) and logs `retest_cleared`, a
 * failure updates the record and logs `retest_failed` (only when it was recorded: one that
 * was not stays `running`, which the retest reports as an outcome it could not record);
 * neither is a warning's outcome, so no `false_positive` or `confirmed`. A call that never
 * ran (a denial, a refused permission, an interrupt) changes nothing. What it came to is
 * left in `retesting` for the retest that is waiting on it. The result comes back as the
 * engine gave it.
 */
async function settleRetest($: ModEngine, io: Io, call: Call, hash: string, e: ToolCallEvent, next: Next<ToolCallEvent, ToolCallOutcome>, retesting: Retesting): Promise<ToolCallOutcome> {
  const result = await next(e)
  const entry = retesting.get(hash) ?? { state: 'running', cwd: call.cwd }
  try {
    const outcome = outcomeOf(result, next.signal?.aborted === true, call.tool)
    const verdict = retestVerdict(outcome)
    if (verdict === null) {
      retesting.set(hash, { ...entry, state: 'not_run' })
      return result
    }
    const changed = await settle(io, call, outcome, null)
    // A failure that was not recorded stays `running`, so the retest says its outcome was lost.
    if (verdict.state === 'failed' && !changed) return result
    await appendStat(io, await pathsFor(io, call.cwd), { kind: verdict.stat, hash })
    retesting.set(hash, { ...entry, state: verdict.state })
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
    const done = pressing.then(() => onPanePress(paneHostOf($, wrapIo, retesting, claim), e, drawn))
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
    const done = pressing.then(() => onPaneInput(storeOf($), e))
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
    const done = pressing.then(() => selectRow(paneHostOf($, wrapIo, retesting, claim), element)).catch(() => undefined)
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
