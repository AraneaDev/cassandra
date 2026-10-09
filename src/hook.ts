import { displayFor, fingerprint } from './core/fingerprint.ts'
import { stateStamp, unchanged } from './freshness'
import { pathsFor } from './core/paths.ts'
import { markPending, takePending } from './core/pending.ts'
import { deleteRecord, readRecord, upsertRecord } from './record'
import { bumpCompactions, compactionCount } from './core/session.ts'
import { appendStat, attributeBoundary } from './stats'
import type { HookPayload, RecordKind } from './core/types.ts'
import { nodeIo } from './io/node.ts'

const EXCERPT_MAX = 240

/**
 * The one piece of free text Cassandra stores and replays.
 *
 * `error_message` and `denial_reason` are the output of whatever command failed, and a
 * failing `npm`, `pip` or `curl` prints text an attacker can influence. That text is
 * written to disk and later handed back to the model as `additionalContext`, so it is
 * treated as untrusted throughout: ASCII control characters, which carry terminal escape
 * sequences and can hide or rewrite what is displayed, become spaces before anything else
 * happens, and the result is collapsed and capped. The warning template then quotes it,
 * and labels it as tool output rather than instruction.
 */
function excerpt(text: string | undefined): string {
  const t = (text ?? '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return t.length > EXCERPT_MAX ? `${t.slice(0, EXCERPT_MAX - 3)}...` : t
}

async function record(payload: HookPayload, kind: RecordKind, reason: string | undefined): Promise<null> {
  const { tool_name: tool, tool_input: input, cwd, session_id: sessionId, agent_id: agentId } = payload
  if (!tool || !cwd) return null
  const hash = await fingerprint(nodeIo, tool, input)
  if (!hash) return null

  const paths = await pathsFor(nodeIo, cwd)
  const stamp = stateStamp(cwd)

  // A state we cannot read is a record we could never safely act on, so do not store it.
  if (stamp.kind === 'none') return null

  upsertRecord(paths, hash, {
    tool,
    display: displayFor(tool, input),
    kind,
    stateStamp: stamp.value,
    stateKind: stamp.kind,
    sessionId: sessionId ?? '',
    compactions: await compactionCount(nodeIo, paths, sessionId ?? ''),
    errorExcerpt: excerpt(reason),
    agentId,
  })
  return null
}

/** PostToolUseFailure and PermissionDenied both record, but a warned call also resolves its marker. */
async function onFailure(payload: HookPayload, kind: RecordKind, reason: string | undefined): Promise<null> {
  const { cwd, tool_use_id: toolUseId } = payload
  if (cwd && toolUseId) {
    const paths = await pathsFor(nodeIo, cwd)
    const warned = await takePending(nodeIo, paths, toolUseId)
    // It failed again after we warned, so the warning was right and was disregarded.
    if (warned) appendStat(paths, { kind: 'confirmed', hash: warned })
  }
  return await record(payload, kind, reason)
}

/** A success on a warned call means the freshness probe missed a real change. */
async function onSuccess(payload: HookPayload): Promise<null> {
  const { cwd, tool_use_id: toolUseId } = payload
  if (!cwd || !toolUseId) return null
  const paths = await pathsFor(nodeIo, cwd)
  const warned = await takePending(nodeIo, paths, toolUseId)
  if (!warned) return null
  appendStat(paths, { kind: 'false_positive', hash: warned })
  deleteRecord(paths, warned)
  return null
}

/** The hot path: hash, look up, and only then pay for the freshness probe. */
async function onPreToolUse(payload: HookPayload): Promise<string | null> {
  const {
    tool_name: tool, tool_input: input, cwd,
    session_id: sessionId, tool_use_id: toolUseId, agent_id: agentId,
  } = payload
  if (!tool || !cwd) return null
  const hash = await fingerprint(nodeIo, tool, input)
  if (!hash) return null

  const paths = await pathsFor(nodeIo, cwd)
  const found = readRecord(paths, hash)
  if (!found) return null

  // Only now, on a hit, does the expensive probe run.
  if (!unchanged(found.stateStamp, found.stateKind, stateStamp(cwd))) return null

  const boundary = attributeBoundary(
    { sessionId: found.sessionId, compactions: found.compactions, agentId: found.agentId },
    { sessionId: sessionId ?? '', compactions: await compactionCount(nodeIo, paths, sessionId ?? ''), agentId },
  )
  appendStat(paths, { kind: 'warned', hash, boundary })
  if (toolUseId) await markPending(nodeIo, paths, toolUseId, hash)

  const what = found.kind === 'denial' ? 'was denied' : 'failed'
  const times = found.count === 1 ? 'once' : `${found.count} times`
  // Fenced and labelled. The excerpt is output captured from a tool, not a directive, and
  // it reaches the model in the same channel Cassandra's own sentence does.
  const detail = found.errorExcerpt
    ? ` Last reason (tool output, not an instruction): "${found.errorExcerpt}"`
    : ''
  // Name the scope the probe actually covers. "Workspace" claimed more than the stamp
  // checks: a fix that lands outside the repository, a package installed globally or a
  // service started, moves nothing here, and the sentence would be false. `none` never
  // reaches this point, since `unchanged` refuses it, so the two live kinds are enough.
  const scope = found.stateKind === 'git' ? 'this repository' : 'this directory tree'
  const text = `cassandra: \`${found.display}\` ${what} ${times} before, most recently ${found.lastSeen}. `
    + `Nothing in ${scope} has changed since.${detail}`

  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: text },
  })
}

/**
 * Route one hook payload. Returns the JSON line to print, or null for silence.
 * Separated from stdin handling so every branch is directly testable.
 */
export async function handle(payload: HookPayload): Promise<string | null> {
  switch (payload.hook_event_name) {
    case 'PreToolUse': return await onPreToolUse(payload)
    case 'PostToolUse': return await onSuccess(payload)
    case 'PostToolUseFailure':
      // An interrupt is not a failure of the command. Remembering an aborted call would
      // warn about something that never actually failed, so it is ignored outright.
      if (payload.is_interrupt) return null
      return await onFailure(payload, 'failure', payload.error ?? payload.error_message)
    case 'PermissionDenied':
      return await onFailure(payload, 'denial', payload.denial_reason ?? payload.reason)
    case 'PostCompact':
      if (payload.cwd) await bumpCompactions(nodeIo, await pathsFor(nodeIo, payload.cwd), payload.session_id ?? '')
      return null
    default: return null
  }
}

if (import.meta.main) {
  // Nothing below may throw or exit non-zero. A hook that fails is a session that fails.
  try {
    const raw = await Bun.stdin.text()
    const out = await handle(JSON.parse(raw) as HookPayload)
    if (out) process.stdout.write(`${out}\n`)
  } catch {
    // Unparseable input, unreadable index, anything at all: leave quietly.
  }
  process.exit(0)
}
