/**
 * POSIX path handling with no Node underneath.
 *
 * The core runs inside Claude Code's mod runtime, which has no `node:path`, so the five
 * operations it needs are written out here. They match `node:path/posix` on every input
 * the core produces, which `test/path.test.ts` checks against Node directly. Trailing
 * slashes are dropped, which Node's `join` keeps; the core never produces one.
 */

/** Collapse `.`, `..` and repeated separators. An empty result is `.` (relative) or `/` (absolute). */
export function normalize(p: string): string {
  const absolute = p.startsWith('/')
  const out: string[] = []
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop()
      else if (!absolute) out.push('..')
      continue
    }
    out.push(part)
  }
  const body = out.join('/')
  if (absolute) return `/${body}`
  return body === '' ? '.' : body
}

/** Join segments with `/` and normalize. Empty segments are ignored, as Node ignores them. */
export function join(...parts: string[]): string {
  return normalize(parts.filter((part) => part !== '').join('/'))
}

/** Everything before the last segment. */
export function dirname(p: string): string {
  const n = normalize(p)
  if (n === '/') return '/'
  const i = n.lastIndexOf('/')
  if (i === -1) return '.'
  if (i === 0) return '/'
  return n.slice(0, i)
}

/** The last segment; '' for the root. */
export function basename(p: string): string {
  const n = normalize(p)
  if (n === '/') return ''
  return n.slice(n.lastIndexOf('/') + 1)
}

/** Whether the path starts at the root. */
export function isAbsolute(p: string): boolean {
  return p.startsWith('/')
}
