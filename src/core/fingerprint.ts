import type { Io } from './io.ts'
import { OWN_TOOLS } from './own-tools.ts'
import type { ToolKind } from './types.ts'

/**
 * Which extractor a tool name routes to. Edit and Write payloads never repeat, so they are ignored.
 * Non-string tool names are treated as ignored.
 */
export function classify(toolName: string): ToolKind {
  if (typeof toolName !== 'string') return 'ignored'
  if (toolName === 'Bash') return 'bash'
  // Cassandra's own tools answer questions about failures; tracking them would make
  // Cassandra remember its own answers.
  if (OWN_TOOLS.has(toolName)) return 'ignored'
  if (toolName.startsWith('mcp__')) return 'mcp'
  return 'ignored'
}

/**
 * JSON with every object's keys sorted, recursively. Two calls carrying the same
 * arguments in a different order therefore hash identically, which removes any
 * dependence on the harness serializing key order consistently.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.keys(value as Record<string, unknown>).sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
  return `{${entries.join(',')}}`
}

/**
 * The significant part of a tool input, normalized.
 *
 * Normalization is deliberately stingy. A miss costs silence, which is the status
 * quo; a false match costs a confidently wrong warning, which is what teaches you
 * to ignore the tool. So only whitespace is touched. Newlines are preserved because
 * collapsing them would merge genuinely different multi-line scripts (e.g., two
 * heredocs with different content but identical single-line representation).
 */
function significant(toolName: string, toolInput: unknown): string | null {
  const kind = classify(toolName)
  if (kind === 'ignored') return null
  if (toolInput === null || typeof toolInput !== 'object') return null

  if (kind === 'bash') {
    const command = (toolInput as { command?: unknown }).command
    if (typeof command !== 'string') return null
    const normalized = command.trim().replace(/[^\S\n]+/g, ' ').replace(/ +\n/g, '\n')
    return normalized.length > 0 ? normalized : null
  }

  return stableStringify(toolInput)
}

/** A short human label for CLI output and the warning text. */
export function displayFor(toolName: string, toolInput: unknown): string {
  const sig = significant(toolName, toolInput) ?? ''
  const text = classify(toolName) === 'bash' ? sig : `${toolName} ${sig}`
  return text.length > 120 ? `${text.slice(0, 117)}...` : text
}

/**
 * The record id: the tool and its significant input, and for a Bash call made inside a
 * monorepo package, that package (see `packageScope`). An empty scope hashes exactly as
 * ids always have, so single-package repos keep every existing record. A normalized
 * command holds no NUL, so a scoped id can never equal a root id. sha256 rather than
 * Bun.hash, which is not guaranteed stable across Bun versions.
 */
export async function fingerprint(io: Io, toolName: string, toolInput: unknown, scope = ''): Promise<string | null> {
  const sig = significant(toolName, toolInput)
  if (sig === null) return null
  const text = scope === '' ? `${toolName} ${sig}` : `${toolName}\u0000${scope}\u0000${sig}`
  return (await io.sha256(text)).slice(0, 16)
}
