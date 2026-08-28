import { createHash } from 'node:crypto'
import type { ToolKind } from './types'

/** Which extractor a tool name routes to. Edit and Write payloads never repeat, so they are ignored. */
export function classify(toolName: string): ToolKind {
  if (toolName === 'Bash') return 'bash'
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
 * Stable 16-character fingerprint, or null when this call is not one Cassandra tracks.
 * sha256 rather than Bun.hash, which is not guaranteed stable across Bun versions and
 * would silently invalidate every stored record on an upgrade.
 */
export function fingerprint(toolName: string, toolInput: unknown): string | null {
  const sig = significant(toolName, toolInput)
  if (sig === null) return null
  return createHash('sha256').update(`${toolName} ${sig}`).digest('hex').slice(0, 16)
}
