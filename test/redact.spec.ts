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
})
