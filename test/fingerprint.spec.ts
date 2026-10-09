import { expect, test } from 'bun:test'
import { classify, displayFor, fingerprint, stableStringify } from '../src/core/fingerprint.ts'
import { nodeIo } from '../src/io/node.ts'

test('classify routes Bash, MCP tools and everything else', async () => {
  expect(classify('Bash')).toBe('bash')
  expect(classify('mcp__knossos__scan_project')).toBe('mcp')
  expect(classify('Edit')).toBe('ignored')
  expect(classify('Write')).toBe('ignored')
})

test('whitespace variants of one command share a fingerprint', async () => {
  const a = await fingerprint(nodeIo, 'Bash', { command: 'bun test' })
  const b = await fingerprint(nodeIo, 'Bash', { command: '  bun   test  ' })
  const c = await fingerprint(nodeIo, 'Bash', { command: 'bun\ttest' })
  expect(a).toBe(b)
  expect(a).toBe(c)
})

test('different commands never collide', async () => {
  expect(await fingerprint(nodeIo, 'Bash', { command: 'rm foo' }))
    .not.toBe(await fingerprint(nodeIo, 'Bash', { command: 'rm bar' }))
})

test('normalization does not merge commands that differ only by redirect or flag order', async () => {
  const base = await fingerprint(nodeIo, 'Bash', { command: 'bun test' })
  expect(await fingerprint(nodeIo, 'Bash', { command: 'bun test > out.txt' })).not.toBe(base)
  expect(await fingerprint(nodeIo, 'Bash', { command: 'bun test --bail --coverage' }))
    .not.toBe(await fingerprint(nodeIo, 'Bash', { command: 'bun test --coverage --bail' }))
})

test('commands containing quotes, backslashes and newlines survive intact', async () => {
  // Escaped quotes create a different fingerprint from unescaped
  const withEscapedQuotes = 'git commit -m "fix \\"quoted\\" thing"'
  const withoutEscapedQuotes = 'git commit -m "fix quoted thing"'
  expect(await fingerprint(nodeIo, 'Bash', { command: withEscapedQuotes }))
    .not.toBe(await fingerprint(nodeIo, 'Bash', { command: withoutEscapedQuotes }))

  // Different multi-line scripts have different fingerprints
  const heredoc1 = "cat <<EOF > f\nline one\nline two\nEOF"
  const heredoc2 = "cat <<EOF > f\nline one line two\nEOF"
  expect(await fingerprint(nodeIo, 'Bash', { command: heredoc1 }))
    .not.toBe(await fingerprint(nodeIo, 'Bash', { command: heredoc2 }))

  // Trailing spaces on lines collapse but newlines are preserved
  const withoutTrailingSpaces = "cat <<EOF > f\nline one\nline two\nEOF"
  const withTrailingSpaces = "cat <<EOF > f\nline one   \nline two  \nEOF"
  expect(await fingerprint(nodeIo, 'Bash', { command: withoutTrailingSpaces }))
    .toBe(await fingerprint(nodeIo, 'Bash', { command: withTrailingSpaces }))
})

test('MCP fingerprints ignore key order', async () => {
  const a = await fingerprint(nodeIo, 'mcp__k__scan', { project_id: 'pp', depth: 3 })
  const b = await fingerprint(nodeIo, 'mcp__k__scan', { depth: 3, project_id: 'pp' })
  expect(a).toBe(b)
})

test('MCP fingerprints separate different argument values', async () => {
  expect(await fingerprint(nodeIo, 'mcp__k__scan', { depth: 3 }))
    .not.toBe(await fingerprint(nodeIo, 'mcp__k__scan', { depth: 4 }))
})

test('the same input to different MCP tools does not collide', async () => {
  expect(await fingerprint(nodeIo, 'mcp__a__run', { x: 1 })).not.toBe(await fingerprint(nodeIo, 'mcp__b__run', { x: 1 }))
})

test('malformed or ignored input yields null rather than throwing', async () => {
  expect(await fingerprint(nodeIo, 'Edit', { old_string: 'a' })).toBeNull()
  expect(await fingerprint(nodeIo, 'Bash', {})).toBeNull()
  expect(await fingerprint(nodeIo, 'Bash', null)).toBeNull()
  expect(await fingerprint(nodeIo, 'Bash', { command: '   ' })).toBeNull()
})

test('stableStringify sorts nested keys', async () => {
  expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}')
})

test('displayFor truncates long commands for human output', async () => {
  const long = 'x'.repeat(300)
  expect(displayFor('Bash', { command: long }).length).toBeLessThanOrEqual(120)
})

test("Cassandra's own tools are never tracked", () => {
  expect(classify('mcp__cassandra__query')).toBe('ignored')
  expect(classify('mcp__cassandra__resolve')).toBe('ignored')
  expect(classify('mcp__cassandra_other__x')).toBe('mcp')
  expect(classify('mcp__srv__cassandra__query')).toBe('mcp')
  expect(classify('mcp__cassandra__select')).toBe('mcp')
  expect(classify('mcp__cassandra__queryx')).toBe('mcp')
})
