import { runCommand } from '../src/commands/run.ts'
import { buildBriefing, check, recordBriefing, settle, type Call, type Outcome, type Warning } from '../src/core/engine.ts'
import type { Io } from '../src/core/io.ts'
import { dataRoot, pathsFor } from '../src/core/paths.ts'
import { statusText } from '../src/core/status.ts'
import { bumpCompactions, clearModSession, markModSession, pruneModMarkers } from '../src/core/session.ts'
import type { BriefBoundary } from '../src/core/stats.ts'
import { QUERY_TOOL, RESOLVE_TOOL, TOOL_PREFIX, queryText, resolveFailure } from '../src/core/tools.ts'
import { modIo, type ModHost } from '../src/io/mod.ts'

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

/** The slice of `$` the hooks use: the core's, the session's identity and its append, and tool registration. */
export type ModEngine = ModHost & {
  session: { id(): Promise<string>; cwd(): Promise<string>; append(args: AppendArgs): Promise<AppendResult> }
  tool: { register(spec: { name: string; description: string; inputSchema?: Record<string, unknown> }): Promise<unknown> }
  command: { register(spec: { name: string; description?: string; argumentHint?: string }): Promise<unknown> }
  ui: { status(text: string | undefined): void }
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
  (event: 'command.run', matcher: { command: string }, hook: ($: ModEngine, e: { command: string; args: string }, next: Next<{ command: string; args: string }, unknown>) => Promise<{ text?: string; exitCode?: number }>): unknown
  (event: 'tool.call', matcher: { tool: RegExp }, hook: ($: ModEngine, e: ToolCallEvent, next: Next<ToolCallEvent, ToolCallOutcome>) => Promise<ToolCallOutcome>): unknown
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

/** Re-read the live count and pin it under the prompt. Never throws; a failure keeps the old line. */
async function refreshStatus($: ModEngine, io: Io): Promise<void> {
  try {
    $.ui.status(await statusText(io, await $.session.cwd()))
  } catch {
    // The previous line stays until the next change.
  }
}

/** Serve /cassandra with the CLI's own text. Never throws. */
async function answerCommand($: ModEngine, io: Io, args: string): Promise<{ text: string; exitCode: number }> {
  try {
    const parts = args.split(/\s+/).filter(Boolean)
    const r = await runCommand(io, await $.session.cwd(), parts)
    if (parts[0] === 'forget') await refreshStatus($, io)
    return { text: r.text, exitCode: r.code }
  } catch {
    return { text: 'cassandra: could not read what this project remembers.', exitCode: 1 }
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
 * What a call came to, from what the engine answered.
 *
 * An explicit `{ deny }` (from another plugin) is a denial. An errored result is the
 * user's interrupt when the dispatch was aborted, a call that never ran when the text
 * says a permission was refused, and otherwise a failure.
 */
export function outcomeOf(r: ToolCallOutcome, aborted: boolean): Outcome {
  if (r.deny !== undefined) return { kind: 'denial', reason: r.deny }
  if (r.isError === true) {
    if (aborted) return { kind: 'interrupt' }
    if (r.text !== undefined && NOT_RUN_TEXT.test(r.text)) return { kind: 'not_run' }
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
      await $.command.register({ name: 'cassandra', description: 'Show what Cassandra remembers failing in this project', argumentHint: '[list | why <id> | forget <id> | forget --all | stats]' })
    } catch {
      // The session goes on without Cassandra's tools.
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
      return { text: 'cassandra: could not read what this project remembers.', exitCode: 1 }
    }
    return answerCommand($, io, e.args)
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
      const changed = await settle(io, call, outcomeOf(result, next.signal?.aborted === true), warning?.hash ?? null)
      if (changed) await refreshStatus($, io)
    } catch {
      // The call happened; only the bookkeeping is lost.
    }
    if (!warning || result?.deny !== undefined) return result
    return { ...result, context: [...(result.context ?? []), warning.text] }
  })
}
