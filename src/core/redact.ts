/**
 * Likely secrets in text Cassandra stores, found by shape alone: no entropy guessing, so a
 * secret of no known shape is kept as is. Used on a failure's output before either form of
 * it is stored, and to decide whether a call's input may be kept at all.
 */

const REDACTED = '[redacted]'

/** A key name that says its value is a secret, with any `PREFIX_` segments before it (`AWS_SECRET_ACCESS_KEY`). */
const KEY_NAME = String.raw`(?:[A-Za-z0-9]+[_-])*(?:password|passwd|secret[_-]?key|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret)`

/** A value: quoted whole, or unquoted up to a space, quote, backslash or separator. */
const VALUE = String.raw`(?:"[^"\n]*"|'[^'\n]*'|[^\s'"\\&;,]+)`

/** Secrets whose own shape gives them away, replaced whole. */
const WHOLE: readonly RegExp[] = [
  // A PEM private key, to its end line or, when the output was cut, to the end.
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
  /(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{20,}/g,
  /(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{20,}/g,
  // OpenAI and Anthropic keys (`sk-proj-…`, `sk-ant-…`).
  /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}/g,
  /(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}(?![0-9A-Z])/g,
  /(?<![A-Za-z0-9])xox[abprs]-[A-Za-z0-9-]{10,}/g,
  // A JWT: three base64url segments, the first a JSON header.
  /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
]

/** `Bearer <token>`, the token only. */
const BEARER = /(?<![A-Za-z0-9])(bearer\s+)[A-Za-z0-9._~+/=-]+/gi
/** `key=value`, `key: value` and `"key": "value"`, the value only. */
const KEY_VALUE = new RegExp(String.raw`((?<![A-Za-z0-9])${KEY_NAME}["']?\s*[:=]\s*)${VALUE}`, 'gi')
/** `--key value`, the value only; a following flag is not a value. */
const FLAG_VALUE = new RegExp(String.raw`(--${KEY_NAME}\s+)(?!-)${VALUE}`, 'gi')

/** The text with every likely secret replaced by `[redacted]`. Idempotent. */
export function redactSecrets(text: string): string {
  let out = text
  for (const re of WHOLE) out = out.replace(re, REDACTED)
  return out
    .replace(BEARER, `$1${REDACTED}`)
    .replace(KEY_VALUE, `$1${REDACTED}`)
    .replace(FLAG_VALUE, `$1${REDACTED}`)
}

/**
 * Whether any of a call's input would be redacted: its JSON (which catches a secret under a
 * key, `{"password": "…"}`), or any one string in it (which catches one the JSON escaping
 * hides, behind an escaped newline).
 */
export function inputLooksSecret(input: unknown): boolean {
  const json = JSON.stringify(input)
  if (json === undefined) return false
  if (redactSecrets(json) !== json) return true
  const strings = (v: unknown): string[] =>
    typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(strings) : v !== null && typeof v === 'object' ? Object.values(v).flatMap(strings) : []
  return strings(input).some((s) => redactSecrets(s) !== s)
}
