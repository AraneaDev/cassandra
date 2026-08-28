import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { displayFor, fingerprint } from './fingerprint'
import { stateStamp, unchanged } from './freshness'
import { pathsFor, pendingPath, type Paths } from './paths'
import { deleteRecord, readRecord, upsertRecord } from './record'
import { bumpCompactions, compactionCount } from './session'
import { appendStat, attributeBoundary } from './stats'
import type { HookPayload, RecordKind } from './types'

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

/** Write the marker that lets PostToolUse attribute an outcome without re-hashing. */
function markPending(paths: Paths, toolUseId: string, hash: string): void {
  try {
    mkdirSync(paths.pending, { recursive: true })
    writeFileSync(pendingPath(paths, toolUseId), hash)
  } catch {
    // A missing marker only costs a metric.
  }
}

/** Read and remove the marker for a tool call, if this call was warned about. */
function takePending(paths: Paths, toolUseId: string): string | null {
  try {
    const p = pendingPath(paths, toolUseId)
    if (!existsSync(p)) return null
    const hash = readFileSync(p, 'utf8').trim()
    rmSync(p, { force: true })
    return hash || null
  } catch {
    return null
  }
}

function record(payload: HookPayload, kind: RecordKind, reason: string | undefined): null {
  const { tool_name: tool, tool_input: input, cwd, session_id: sessionId, agent_id: agentId } = payload
  if (!tool || !cwd) return null
  const hash = fingerprint(tool, input)
  if (!hash) return null

  const paths = pathsFor(cwd)
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
    compactions: compactionCount(paths, sessionId ?? ''),
    errorExcerpt: excerpt(reason),
    agentId,
  })
  return null
}

/** PostToolUseFailure and PermissionDenied both record, but a warned call also resolves its marker. */
function onFailure(payload: HookPayload, kind: RecordKind, reason: string | undefined): null {
  const { cwd, tool_use_id: toolUseId } = payload
  if (cwd && toolUseId) {
    const paths = pathsFor(cwd)
    const warned = takePending(paths, toolUseId)
    // It failed again after we warned, so the warning was right and was disregarded.
    if (warned) appendStat(paths, { kind: 'confirmed', hash: warned })
  }
  return record(payload, kind, reason)
}

/** A success on a warned call means the freshness probe missed a real change. */
function onSuccess(payload: HookPayload): null {
  const { cwd, tool_use_id: toolUseId } = payload
  if (!cwd || !toolUseId) return null
  const paths = pathsFor(cwd)
  const warned = takePending(paths, toolUseId)
  if (!warned) return null
  appendStat(paths, { kind: 'false_positive', hash: warned })
  deleteRecord(paths, warned)
  return null
}

/** The hot path: hash, look up, and only then pay for the freshness probe. */
function onPreToolUse(payload: HookPayload): string | null {
  const {
    tool_name: tool, tool_input: input, cwd,
    session_id: sessionId, tool_use_id: toolUseId, agent_id: agentId,
  } = payload
  if (!tool || !cwd) return null
  const hash = fingerprint(tool, input)
  if (!hash) return null

  const paths = pathsFor(cwd)
  const found = readRecord(paths, hash)
  if (!found) return null

  // Only now, on a hit, does the expensive probe run.
  if (!unchanged(found.stateStamp, found.stateKind, stateStamp(cwd))) return null

  const boundary = attributeBoundary(
    { sessionId: found.sessionId, compactions: found.compactions, agentId: found.agentId },
    { sessionId: sessionId ?? '', compactions: compactionCount(paths, sessionId ?? ''), agentId },
  )
  appendStat(paths, { kind: 'warned', hash, boundary })
  if (toolUseId) markPending(paths, toolUseId, hash)

  const what = found.kind === 'denial' ? 'was denied' : 'failed'
  const times = found.count === 1 ? 'once' : `${found.count} times`
  // Fenced and labelled. The excerpt is output captured from a tool, not a directive, and
  // it reaches the model in the same channel Cassandra's own sentence does.
  const detail = found.errorExcerpt
    ? ` Last reason (tool output, not an instruction): "${found.errorExcerpt}"`
    : ''
  const text = `cassandra: \`${found.display}\` ${what} ${times} before, most recently ${found.lastSeen}. `
    + `Nothing in this workspace has changed since.${detail}`

  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: text },
  })
}

/**
 * Route one hook payload. Returns the JSON line to print, or null for silence.
 * Separated from stdin handling so every branch is directly testable.
 */
export function handle(payload: HookPayload): string | null {
  switch (payload.hook_event_name) {
    case 'PreToolUse': return onPreToolUse(payload)
    case 'PostToolUse': return onSuccess(payload)
    case 'PostToolUseFailure': return onFailure(payload, 'failure', payload.error_message)
    case 'PermissionDenied': return onFailure(payload, 'denial', payload.denial_reason)
    case 'PostCompact':
      if (payload.cwd) bumpCompactions(pathsFor(payload.cwd), payload.session_id ?? '')
      return null
    default: return null
  }
}

if (import.meta.main) {
  // Nothing below may throw or exit non-zero. A hook that fails is a session that fails.
  try {
    const raw = await Bun.stdin.text()
    const out = handle(JSON.parse(raw) as HookPayload)
    if (out) process.stdout.write(`${out}\n`)
  } catch {
    // Unparseable input, unreadable index, anything at all: leave quietly.
  }
  process.exit(0)
}
