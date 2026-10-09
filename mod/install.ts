import { check, settle, type Call, type Outcome, type Warning } from '../src/core/engine.ts'
import type { Io } from '../src/core/io.ts'
import { dataRoot, pathsFor } from '../src/core/paths.ts'
import { bumpCompactions, clearModSession, markModSession, pruneModMarkers } from '../src/core/session.ts'
import { modIo, type ModHost } from '../src/io/mod.ts'

/** The slice of `$` the hooks use: the core's, plus the session's identity. */
export type ModEngine = ModHost & { session: { id(): Promise<string>; cwd(): Promise<string> } }

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
  (event: 'session.compact', hook: ($: ModEngine, e: { agentId?: string }, next: Next<{ agentId?: string }, { skip?: string }>) => Promise<unknown>): unknown
  (event: 'tool.call', matcher: { tool: RegExp }, hook: ($: ModEngine, e: ToolCallEvent, next: Next<ToolCallEvent, ToolCallOutcome>) => Promise<ToolCallOutcome>): unknown
}

/** The same calls the binary's hooks match: Bash and every MCP tool. */
const TRACKED = /^(Bash|mcp__.*)$/

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

/** The tool's own arguments, as the classic hook's `tool_input` carries them. */
export function toolInput(e: ToolCallEvent): Record<string, unknown> {
  return Object.fromEntries(Object.entries(e).filter(([k]) => !RESERVED.has(k)))
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
 * directly. Everything is wrapped: the call runs exactly once whatever the core does,
 * and its result is never lost or changed beyond the one added line of context.
 */
export function install(on: ModOn, wrapIo: (io: Io) => Io = (io) => io): void {
  let claimed: { id: string; root: string; at: number } | null = null

  // Claim the session before the call, because the classic PreToolUse hook runs beneath
  // this one and must already see the claim. Lazily, on every call, because a /clear
  // changes the session id without a session.start.
  const claim = async (io: Io, id: string): Promise<void> => {
    // The data root can move after the first claim (the classic hooks may write the
    // pointer), so the claim is only reusable while the root it was made under holds.
    const root = await dataRoot(io).catch(() => null)
    if (root === null) return
    if (claimed && claimed.id === id && claimed.root === root && Date.now() - claimed.at < MARKER_REFRESH_MS) return
    if (await markModSession(io, id)) claimed = { id, root, at: Date.now() }
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
    return started
  })

  on('session.end', async ($, e, next) => {
    try {
      await clearModSession(wrapIo(modIo(hostOf($))), e.sessionId)
    } catch {
      // Pruned after a day.
    }
    if (claimed?.id === e.sessionId) claimed = null
    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    const compacted = await next(e)
    if (e.agentId !== undefined || compacted?.skip !== undefined) return compacted
    try {
      const io = wrapIo(modIo(hostOf($)))
      await bumpCompactions(io, await pathsFor(io, await $.session.cwd()), await $.session.id())
    } catch {
      // A missed count only blurs one boundary attribution.
    }
    return compacted
  })

  on('tool.call', { tool: TRACKED }, async ($, e, next) => {
    let io: Io
    let call: Call
    let warning: Warning | null
    try {
      io = wrapIo(modIo(hostOf($)))
      const sessionId = await $.session.id()
      await claim(io, sessionId)
      call = { tool: e.tool, input: toolInput(e), cwd: await $.session.cwd(), sessionId, agentId: e.agentId }
      warning = await check(io, call)
    } catch {
      return next(e)
    }

    const result = await next(e)

    try {
      await settle(io, call, outcomeOf(result, next.signal?.aborted === true), warning?.hash ?? null)
    } catch {
      // The call happened; only the bookkeeping is lost.
    }
    if (!warning || result?.deny !== undefined) return result
    return { ...result, context: [...(result.context ?? []), warning.text] }
  })
}
