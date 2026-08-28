import { expect, test } from 'bun:test'
import { classify, displayFor, fingerprint, stableStringify } from '../src/fingerprint'

test('classify routes Bash, MCP tools and everything else', () => {
  expect(classify('Bash')).toBe('bash')
  expect(classify('mcp__knossos__scan_project')).toBe('mcp')
  expect(classify('Edit')).toBe('ignored')
  expect(classify('Write')).toBe('ignored')
})

test('whitespace variants of one command share a fingerprint', () => {
  const a = fingerprint('Bash', { command: 'bun test' })
  const b = fingerprint('Bash', { command: '  bun   test  ' })
  const c = fingerprint('Bash', { command: 'bun\ttest' })
  expect(a).toBe(b)
  expect(a).toBe(c)
})

test('different commands never collide', () => {
  expect(fingerprint('Bash', { command: 'rm foo' }))
    .not.toBe(fingerprint('Bash', { command: 'rm bar' }))
})

test('normalization does not merge commands that differ only by redirect or flag order', () => {
  const base = fingerprint('Bash', { command: 'bun test' })
  expect(fingerprint('Bash', { command: 'bun test > out.txt' })).not.toBe(base)
  expect(fingerprint('Bash', { command: 'bun test --bail --coverage' }))
    .not.toBe(fingerprint('Bash', { command: 'bun test --coverage --bail' }))
})

test('commands containing quotes, backslashes and newlines survive intact', () => {
  const gnarly = 'git commit -m "fix \\"quoted\\" thing"'
  expect(fingerprint('Bash', { command: gnarly }))
    .toBe(fingerprint('Bash', { command: gnarly }))
  const heredoc = "cat <<'EOF' > f\nline one\nline two\nEOF"
  expect(fingerprint('Bash', { command: heredoc })).toBeString()
})

test('MCP fingerprints ignore key order', () => {
  const a = fingerprint('mcp__k__scan', { project_id: 'pp', depth: 3 })
  const b = fingerprint('mcp__k__scan', { depth: 3, project_id: 'pp' })
  expect(a).toBe(b)
})

test('MCP fingerprints separate different argument values', () => {
  expect(fingerprint('mcp__k__scan', { depth: 3 }))
    .not.toBe(fingerprint('mcp__k__scan', { depth: 4 }))
})

test('the same input to different MCP tools does not collide', () => {
  expect(fingerprint('mcp__a__run', { x: 1 })).not.toBe(fingerprint('mcp__b__run', { x: 1 }))
})

test('malformed or ignored input yields null rather than throwing', () => {
  expect(fingerprint('Edit', { old_string: 'a' })).toBeNull()
  expect(fingerprint('Bash', {})).toBeNull()
  expect(fingerprint('Bash', null)).toBeNull()
  expect(fingerprint('Bash', { command: '   ' })).toBeNull()
})

test('stableStringify sorts nested keys', () => {
  expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}')
})

test('displayFor truncates long commands for human output', () => {
  const long = 'x'.repeat(300)
  expect(displayFor('Bash', { command: long }).length).toBeLessThanOrEqual(120)
})
