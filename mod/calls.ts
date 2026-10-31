import type { Outcome } from '../src/core/engine.ts'
import type { ToolCallEvent, ToolCallOutcome } from './engine.ts'

/**
 * The same calls the binary's hooks match: Bash and every MCP tool, except Cassandra's own two.
 * `classify()` ignores those already; the matcher keeps the hook from being dispatched for them.
 */
export const TRACKED = /^(?:Bash|mcp__(?!cassandra__(?:query|resolve)$).+)$/

/** Keys the engine puts on a `tool.call` input that are not the tool's arguments. */
const RESERVED = new Set(['tool', 'tool_use_id', 'consent', 'agentId'])

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
