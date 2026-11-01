import { expect, test } from 'bun:test'
import { inputLooksSecret, redactSecrets } from '../src/core/redact.ts'

const R = '[redacted]'

test.each([
  ['a GitHub classic token', 'push failed: ghp_abcdefghijklmnopqrstuvwxyz0123456789 rejected', `push failed: ${R} rejected`],
  ['a GitHub OAuth token', 'gho_ABCDEFGHIJKLMNOPQRSTUVWX', R],
  ['a GitHub fine-grained token', 'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz', R],
  ['an OpenAI-style key', 'Incorrect API key provided: sk-proj-AbCdEfGhIjKlMnOpQrStUvWx.', `Incorrect API key provided: ${R}.`],
  ['an Anthropic key', 'x-api-key sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz_0123', `x-api-key ${R}`],
  ['an AWS access key id', 'InvalidAccessKeyId: AKIAIOSFODNN7EXAMPLE does not exist', `InvalidAccessKeyId: ${R} does not exist`],
  ['a Slack token', 'invalid_auth for xoxb-123456789012-1234567890123-AbCdEfGhIjKl', `invalid_auth for ${R}`],
  ['a JWT', 'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U expired', `token ${R} expired`],
  ['a Bearer header', 'curl: (22) 401 for Authorization: Bearer abc.def-123', `curl: (22) 401 for Authorization: Bearer ${R}`],
  ['a bare Bearer token', 'sent bearer QWxhZGRpbjpvcGVu', `sent bearer ${R}`],
  ['a PEM private key', 'bad key:\n-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nIBAAK\n-----END RSA PRIVATE KEY-----\ndone', `bad key:\n${R}\ndone`],
  ['a PEM private key cut off before its end', 'key: -----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk', `key: ${R}`],
  ['password=value', 'mysql: password=hunter2 refused', `mysql: password=${R} refused`],
  ['an env name holding a key word', 'GITHUB_TOKEN=abc123 AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI', `GITHUB_TOKEN=${R} AWS_SECRET_ACCESS_KEY=${R}`],
  ['key: value, any case', 'Client-Secret: s3cr3t', `Client-Secret: ${R}`],
  ['a quoted JSON value', '{"api_key": "abc 123", "user": "tim"}', `{"api_key": ${R}, "user": "tim"}`],
  ['--key value', 'run --password hunter2 --user tim', `run --password ${R} --user tim`],
  ['--key=value', 'run --private-key=/tmp/k --token=t0k', `run --private-key=${R} --token=${R}`],
  ['passwd: value', 'passwd: letmein', `passwd: ${R}`],
])('redacts %s', (_what, input, expected) => {
  expect(redactSecrets(input)).toBe(expected)
})

test.each([
  'Exit code 1\n3 tests failing',
  'bun test --coverage',
  'error: max_tokens=100 exceeded the limit',
  'task-runner failed at sk-12',
  'grep -r "token:" src',
  'Error: the token is invalid',
])('leaves %p unchanged', (text) => {
  expect(redactSecrets(text)).toBe(text)
})

const G = '\x1b[32m'
const OFF = '\x1b[0m'

test.each([
  ['a GitHub token', `${G}ghp_abcdefghijklmnopqrstuvwxyz0123456789${OFF}`],
  ['a GitHub fine-grained token', `${G}github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz`],
  ['an sk- key', `${G}sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz_0123`],
  ['an AWS access key id', `${G}AKIAIOSFODNN7EXAMPLE${OFF}`],
  ['a Slack token', `${G}xoxb-123456789012-1234567890123-AbCdEfGhIjKl`],
  ['a JWT', `${G}eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U`],
  ['a Bearer token', `${G}Bearer QWxhZGRpbjpvcGVu`],
  ['a PEM private key', `${G}-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----`],
  ['key=value', '\x1b[1mTOKEN=hunter2secret'],
  ['--key value', `${G}--password hunter2secret`],
  ['URL credentials', `${G}https://tim:hunter2secret@example.com`],
  ['Basic credentials', `${G}Authorization: Basic dGltOmh1bnRlcjJzZWNyZXQ=`],
])('redacts %s behind a colour code', (_what, text) => {
  const out = redactSecrets(text)
  expect(out).toContain('[redacted]')
  for (const secret of ['ghp_abc', 'github_pat_11', 'sk-ant', 'AKIAIOSF', 'xoxb-1', 'eyJhbGci', 'QWxhZGRp', 'MIIE', 'hunter2secret', 'dGltOmh1']) expect(out).not.toContain(secret)
})

test.each([
  ['ESC ( B before a token', '\x1b(Bghp_abcdefghijklmnopqrstuvwxyz0123456789'],
  ['ESC ( B before a key', '\x1b(BTOKEN=hunter2secret'],
  ['tput sgr0 before a token', '\x1b(B\x1b[mghp_abcdefghijklmnopqrstuvwxyz0123456789'],
  ['a C1 CSI before a token', '\x9b32mghp_abcdefghijklmnopqrstuvwxyz0123456789'],
  ['a two-byte ESC sequence before a token', '\x1bMghp_abcdefghijklmnopqrstuvwxyz0123456789'],
  ['ESC 7 before a key', '\x1b7TOKEN=hunter2secret'],
])('redacts behind %s', (_what, text) => {
  const out = redactSecrets(text)
  expect(out).toBe(text.includes('TOKEN') ? 'TOKEN=[redacted]' : '[redacted]')
})

test.each([
  ['Proxy-Authorization', 'Proxy-Authorization: Basic dGltOnNlY3JldA==', 'Proxy-Authorization: Basic [redacted]'],
  ['a JSON header', '{"Authorization":"Basic dGltOnNlY3JldA=="}', '{"Authorization":"Basic [redacted]"}'],
  ['a JSON header with spaces', "{'authorization': 'Basic dGltOnNlY3JldA'}", "{'authorization': 'Basic [redacted]'}"],
])('redacts Basic credentials in %s', (_what, input, expected) => {
  expect(redactSecrets(input)).toBe(expected)
})

test('a colour code is dropped, and the text around it kept', () => {
  expect(redactSecrets('\x1b[31mFAIL\x1b[0m src/a.test.ts')).toBe('FAIL src/a.test.ts')
})

test.each([
  ['URL credentials', 'fatal: could not read from https://tim:s3cr3t@github.com/a/b.git', 'fatal: could not read from https://[redacted]@github.com/a/b.git'],
  ['a database URL', 'connect postgres://app:p%40ss@db:5432/x failed', 'connect postgres://[redacted]@db:5432/x failed'],
  ['Basic credentials', 'sent Authorization: Basic dGltOnNlY3JldA== and got 401', 'sent Authorization: Basic [redacted] and got 401'],
])('redacts %s', (_what, input, expected) => {
  expect(redactSecrets(input)).toBe(expected)
})

test.each([
  'see https://example.com/docs@v2 for details',
  'git@github.com:a/b.git',
  'the basic idea: run it twice',
])('leaves %p unchanged too', (text) => {
  expect(redactSecrets(text)).toBe(text)
})

test('redaction is idempotent', () => {
  const once = redactSecrets('GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789')
  expect(redactSecrets(once)).toBe(once)
})

test('an input looks secret when any of it would be redacted', () => {
  expect(inputLooksSecret({ command: 'curl -H "Authorization: Bearer abc123" https://x' })).toBe(true)
  expect(inputLooksSecret({ command: 'echo hi\nsk-AbCdEfGhIjKlMnOpQrStUvWx' })).toBe(true)
  expect(inputLooksSecret({ api_key: 'abc123' })).toBe(true)
  expect(inputLooksSecret({ nested: [{ password: 'x' }] })).toBe(true)
  expect(inputLooksSecret({ command: 'bun test' })).toBe(false)
  expect(inputLooksSecret({ command: 'grep -r "token:" src' })).toBe(false)
  expect(inputLooksSecret(undefined)).toBe(false)
  // A colour code alone is not a secret.
  expect(inputLooksSecret({ command: 'printf "\x1b[32mok\x1b[0m"' })).toBe(false)
  expect(inputLooksSecret({ command: 'echo \u001b[32mok' })).toBe(false)
})

test('for Bash only the command is judged; an MCP input is judged whole', () => {
  expect(inputLooksSecret({ command: 'bun test', description: 'check the token: value path' }, 'Bash')).toBe(false)
  expect(inputLooksSecret({ command: 'TOKEN=abc123 bun test', description: 'run tests' }, 'Bash')).toBe(true)
  expect(inputLooksSecret({ query: 'x', description: 'token: abc123' }, 'mcp__srv__do')).toBe(true)
})

test('a long run of identifier-like text is scanned in linear time', () => {
  for (const unit of ['a_', 'a-', '-a', 'x_token', 'a', 'a://', 'x://u:p', 'Authorization: Basic ', '\x1b[', 'u:p@', '\x1b(', '\x1b( ', '\x9b1', '"authorization":"basic ']) {
    const text = unit.repeat(65536 / unit.length)
    const t0 = performance.now()
    redactSecrets(text)
    inputLooksSecret({ command: text })
    expect(performance.now() - t0).toBeLessThan(1000)
  }
})
