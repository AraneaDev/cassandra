import { buildBriefing, check, recordBriefing, settle, type Call, type Outcome } from './core/engine.ts'
import type { Io } from './core/io.ts'
import { pathsFor } from './core/paths.ts'
import { markPending, takePending } from './core/pending.ts'
import { bumpCompactions, isModSession } from './core/session.ts'
import type { BriefBoundary } from './core/stats.ts'
import type { HookPayload } from './core/types.ts'
import { nodeIo } from './io/node.ts'

function callOf(p: HookPayload): Call {
  return { tool: p.tool_name ?? '', input: p.tool_input, cwd: p.cwd ?? '', sessionId: p.session_id ?? '', agentId: p.agent_id }
}

async function onPreToolUse(io: Io, p: HookPayload): Promise<string | null> {
  const warning = await check(io, callOf(p))
  if (!warning) return null
  if (p.tool_use_id && p.cwd) await markPending(io, await pathsFor(io, p.cwd), p.tool_use_id, warning.hash)
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: warning.text },
  })
}

/** The hash this call was warned about, consumed so it resolves exactly once. */
async function warnedFor(io: Io, p: HookPayload): Promise<string | null> {
  if (!p.cwd || !p.tool_use_id) return null
  return takePending(io, await pathsFor(io, p.cwd), p.tool_use_id)
}

async function onOutcome(io: Io, p: HookPayload, outcome: Outcome): Promise<null> {
  await settle(io, callOf(p), outcome, await warnedFor(io, p))
  return null
}

/** A note for a boundary where the transcript is gone, as the classic hook's additional context. */
async function onBoundary(io: Io, p: HookPayload, event: 'SubagentStart' | 'SessionStart', boundary: BriefBoundary): Promise<string | null> {
  if (!p.cwd) return null
  const briefing = await buildBriefing(io, p.cwd)
  if (!briefing) return null
  await recordBriefing(io, p.cwd, boundary, briefing)
  return JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: briefing.text } })
}

/**
 * Route one hook payload. Returns the JSON line to print, or null for silence.
 * Separated from stdin handling so every branch is directly testable.
 *
 * Where the in-process mod runs, these classic hooks still fire, so the first thing done
 * is to look for the mod's claim on this session and stand down if it is there.
 */
export async function handle(payload: HookPayload, io: Io = nodeIo): Promise<string | null> {
  if (await isModSession(io, payload.session_id ?? '')) return null
  switch (payload.hook_event_name) {
    case 'PreToolUse': return onPreToolUse(io, payload)
    case 'PostToolUse': return onOutcome(io, payload, { kind: 'success' })
    case 'PostToolUseFailure':
      // An interrupt is not a failure of the command; settle ignores it. The marker
      // stays and is pruned after a day, as before.
      if (payload.is_interrupt) return null
      return onOutcome(io, payload, { kind: 'failure', reason: payload.error ?? payload.error_message })
    case 'PermissionDenied':
      return onOutcome(io, payload, { kind: 'denial', reason: payload.denial_reason ?? payload.reason })
    case 'PostCompact':
      if (payload.cwd) await bumpCompactions(io, await pathsFor(io, payload.cwd), payload.session_id ?? '')
      return null
    case 'SubagentStart':
      // A fork inherits the transcript and already sees the failures.
      if (payload.agent_type === 'fork') return null
      return onBoundary(io, payload, 'SubagentStart', 'subagent')
    case 'SessionStart':
      return payload.source === 'compact' ? onBoundary(io, payload, 'SessionStart', 'compaction') : null
    default: return null
  }
}

/** One raw stdin payload to the line to print. Never throws: a hook that fails is a session that fails. */
export async function run(raw: string, io: Io = nodeIo): Promise<string | null> {
  try {
    return await handle(JSON.parse(raw) as HookPayload, io)
  } catch {
    // Unparseable input, unreadable index, anything at all: leave quietly.
    return null
  }
}

if (import.meta.main) {
  // Nothing below may throw or exit non-zero. A hook that fails is a session that fails.
  const out = await run(await Bun.stdin.text().catch(() => ''))
  if (out) process.stdout.write(`${out}\n`)
  process.exit(0)
}
