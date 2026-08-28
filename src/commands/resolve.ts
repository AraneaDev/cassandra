import { listRecords } from '../record'
import { isFingerprint, type Paths } from '../paths'

/** What a prefix lookup produced: exactly one match, nothing, or several. */
export type Resolution =
  | { ok: true; hash: string }
  | { ok: false; why: 'malformed' | 'unknown' | 'ambiguous'; matches: string[] }

/** The shortest prefix worth accepting. Below this a typo matches half the index. */
const MIN_PREFIX = 4

/**
 * Turn what the user typed into a full fingerprint.
 *
 * `cassandra list` prints the first eight characters of each hash, so that is what
 * people copy. Requiring all sixteen made the tool refuse its own output and point at
 * a column it never showed. A prefix is resolved against the index here, and only a
 * full sixteen-character hash ever reaches a path builder, so the traversal guard on
 * `recordPath` keeps its meaning: argv never becomes a path segment.
 */
export function resolveHash(paths: Paths, input: string): Resolution {
  const v = (input ?? '').trim().toLowerCase()
  if (isFingerprint(v)) return { ok: true, hash: v }
  if (!/^[0-9a-f]+$/.test(v) || v.length < MIN_PREFIX || v.length > 16) {
    return { ok: false, why: 'malformed', matches: [] }
  }
  const matches = listRecords(paths).map((e) => e.hash).filter((h) => h.startsWith(v))
  if (matches.length === 1) return { ok: true, hash: matches[0]! }
  return { ok: false, why: matches.length === 0 ? 'unknown' : 'ambiguous', matches }
}

/** One line explaining a failed resolution, in the same voice as the rest of the CLI. */
export function explainResolution(input: string, r: Extract<Resolution, { ok: false }>): string {
  if (r.why === 'malformed') {
    return `Not a hash: ${input || '(empty)'}. Pass at least ${MIN_PREFIX} hex characters, as shown by \`cassandra list\`.`
  }
  if (r.why === 'unknown') return `No record matching ${input}.`
  return `${input} matches ${r.matches.length} records. Use more characters: ${r.matches.map((h) => h.slice(0, 10)).join(', ')}`
}
