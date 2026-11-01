/**
 * Likely secrets in text Cassandra stores, found by shape alone: no entropy guessing, so a
 * secret of no known shape is kept as is. Used on a failure's output before either form of
 * it is stored, and to decide whether a call's input may be kept at all.
 */

const REDACTED = '[redacted]'

/**
 * A key name that says its value is a secret, with any `PREFIX_` segments before it
 * (`AWS_SECRET_ACCESS_KEY`). It is only tried from the start of a name (see `NAME_START`):
 * tried from every `_` or `-` inside a long name, the prefix would be walked again from
 * each, which is quadratic in output an attacker can shape.
 */
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

/**
 * An ANSI CSI sequence (`\x1b[32m` and the like). Dropped before matching: an SGR code ends
 * in a letter, which would otherwise read as part of the name before a secret and hide it.
 */
const CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g
/** `scheme://user:pass@`, the `user:pass` only; a scheme is only tried from the start of a name. */
const URL_CREDENTIALS = /(?<![A-Za-z0-9+.-])([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/g
/** `Authorization: Basic <base64>`, the credentials only. */
const BASIC = /(?<![A-Za-z0-9_-])(authorization\s*:\s*basic\s+)[A-Za-z0-9+/]+=*/gi
/** `Bearer <token>`, the token only. */
const BEARER = /(?<![A-Za-z0-9])(bearer\s+)[A-Za-z0-9._~+/=-]+/gi
/** Where a name starts: not inside another name. */
const NAME_START = String.raw`(?<![A-Za-z0-9_-])`

/** `key=value`, `key: value` and `"key": "value"`, the value only. */
const KEY_VALUE = new RegExp(String.raw`(${NAME_START}${KEY_NAME}["']?\s*[:=]\s*)${VALUE}`, 'gi')
/** `--key value` and `--key=value`, the value only; a following flag is not a value. */
const FLAG_VALUE = new RegExp(String.raw`(${NAME_START}--${KEY_NAME}(?:=|\s+))(?!-)${VALUE}`, 'gi')

/** The text without its ANSI CSI sequences. */
const withoutColour = (text: string): string => text.replace(CSI, '')

/** The text with its ANSI CSI sequences dropped and every likely secret replaced by `[redacted]`. Idempotent. */
export function redactSecrets(text: string): string {
  let out = withoutColour(text)
  for (const re of WHOLE) out = out.replace(re, REDACTED)
  return out
    .replace(URL_CREDENTIALS, `$1${REDACTED}@`)
    .replace(BASIC, `$1${REDACTED}`)
    .replace(BEARER, `$1${REDACTED}`)
    .replace(KEY_VALUE, `$1${REDACTED}`)
    .replace(FLAG_VALUE, `$1${REDACTED}`)
}

/**
 * Whether redaction would change any of a call's input beyond dropping colour codes. For
 * Bash only the command is judged, since the rest (a model-written `description`, flags)
 * is never run as such and must not cost the call its retest; any other tool's input is
 * judged whole: its JSON (which catches a secret under a key, `{"password": "…"}`) and
 * every string in it (which catches one the JSON escaping hides, behind an escaped newline).
 */
export function inputLooksSecret(input: unknown, tool = ''): boolean {
  if (tool === 'Bash') {
    const command = input !== null && typeof input === 'object' ? (input as { command?: unknown }).command : undefined
    return typeof command === 'string' && changes(command)
  }
  const json = JSON.stringify(input)
  if (json === undefined) return false
  if (changes(json)) return true
  const strings = (v: unknown): string[] =>
    typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(strings) : v !== null && typeof v === 'object' ? Object.values(v).flatMap(strings) : []
  return strings(input).some(changes)
}

/** Whether redaction replaces anything in the text, colour codes aside. */
const changes = (text: string): boolean => redactSecrets(text) !== withoutColour(text)
