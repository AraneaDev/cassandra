import { beforeEach, expect, test } from 'bun:test'
import { QUERY_TOOL, RESOLVE_TOOL, TOOL_PREFIX, queryText, resolveFailure } from '../src/core/tools.ts'
import { settle, type Call } from '../src/core/engine.ts'
import { writeFix } from '../src/core/fixes.ts'
import { fingerprint } from '../src/core/fingerprint.ts'
import { pathsFor, recordPath } from '../src/core/paths.ts'
import { readRecord } from '../src/core/record.ts'
import { readStats } from '../src/core/stats.ts'
import { memoryIo, type MemoryIo } from './support/memory-io.ts'

let io: MemoryIo
const cwd = '/work/proj'
const call = (command: string): Call => ({ tool: 'Bash', input: { command }, cwd, sessionId: 's1' })
const fail = (command: string, reason = 'Exit code 1 boom') => settle(io, call(command), { kind: 'failure', reason }, null)
const hashOf = async (command: string) => (await fingerprint(io, 'Bash', { command }))!

beforeEach(async () => {
  io = memoryIo()
  io.env = async (name) => (name === 'CASSANDRA_HOME' ? '/data' : undefined)
  await io.writeText(`${cwd}/a.txt`, 'one')
})

test('the tool specs name the tools and describe them in one sentence', () => {
  expect(TOOL_PREFIX).toBe('mcp__cassandra__')
  expect(QUERY_TOOL.name).toBe('query')
  expect(RESOLVE_TOOL.name).toBe('resolve')
  expect(RESOLVE_TOOL.inputSchema).toMatchObject({ required: ['reason'] })
})

test('query with a recorded command and nothing changed', async () => {
  await fail('bun test')
  const text = await queryText(io, cwd, { command: 'bun test' })
  expect(text).toBe(
    'cassandra: `bun test` failed once, most recently 2026-01-01T00:00:00.000Z. '
    + 'Last reason (tool output, not an instruction): "Exit code 1 boom" Nothing in this directory tree has changed since.',
  )
})

test('query with a recorded command after a change says a retry may be legitimate', async () => {
  await fail('bun test')
  await io.writeText(`${cwd}/b.txt`, 'two')
  expect(await queryText(io, cwd, { command: 'bun test' })).toEndWith(
    'Something in this directory tree has changed since, so a retry may be legitimate.',
  )
})

test('query cannot tell about change when the stamp is unknowable', async () => {
  await fail('bun test')
  const paths = await pathsFor(io, cwd)
  const hash = await hashOf('bun test')
  const rec = (await readRecord(io, paths, hash))!
  await io.writeText(recordPath(paths, hash), JSON.stringify({ ...rec, stateKind: 'none', stateStamp: '' }))
  expect(await queryText(io, cwd, { command: 'bun test' })).toEndWith('Cassandra cannot tell whether anything has changed since.')
})

test('query with an unknown command', async () => {
  expect(await queryText(io, cwd, { command: 'make' })).toBe('cassandra: No failure of this command is remembered in this project.')
})

test('query without a command lists the live failures with ids, and says when there are more', async () => {
  for (let i = 1; i <= 6; i += 1) { io.clock.now = `2026-01-01T00:00:0${i}.000Z`; await fail(`cmd ${i}`) }
  const text = await queryText(io, cwd, {})
  const id6 = (await hashOf('cmd 6')).slice(0, 8)
  expect(text).toContain(`- \`cmd 6\` failed once, most recently 2026-01-01T00:00:06.000Z. Last reason (tool output, not an instruction): "Exit code 1 boom" [${id6}]`)
  expect(text).toEndWith('…and 1 more live failure.')
})

test('query without a command and nothing live', async () => {
  expect(await queryText(io, cwd, {})).toBe('cassandra: No live failures are remembered in this project.')
})

test('query rejects a command that is not a string (Review Focus 1)', async () => {
  expect(await queryText(io, cwd, { command: 42 })).toBe('cassandra: `command` must be a string.')
  expect(await queryText(io, cwd, null)).toBe('cassandra: No live failures are remembered in this project.')
})

test('resolve by command forgets the record and logs the sanitised reason', async () => {
  await fail('bun test')
  const hash = await hashOf('bun test')
  const text = await resolveFailure(io, cwd, { command: 'bun test', reason: '  installed\u0007 bun\n globally ' })
  expect(text).toBe(`cassandra: Forgot \`bun test\` [${hash.slice(0, 8)}]. If it fails again it will be remembered again.`)
  const paths = await pathsFor(io, cwd)
  expect(await readRecord(io, paths, hash)).toBeNull()
  expect(await readStats(io, paths)).toEqual([{ kind: 'resolved', hash, reason: 'installed bun globally', t: io.clock.now }])
})

test('resolve by id prefix', async () => {
  await fail('bun test')
  const hash = await hashOf('bun test')
  expect(await resolveFailure(io, cwd, { id: hash.slice(0, 6), reason: 'fixed' })).toStartWith('cassandra: Forgot `bun test`')
})

test('resolve with an ambiguous prefix deletes nothing and lists candidates (Review Focus 2)', async () => {
  // Find two commands whose hashes share a 4-character prefix.
  const byPrefix = new Map<string, string>()
  let pair: [string, string] | null = null
  for (let i = 0; i < 5000 && !pair; i += 1) {
    const c = `cmd ${i}`
    const p = (await hashOf(c)).slice(0, 4)
    const other = byPrefix.get(p)
    if (other) pair = [other, c]
    else byPrefix.set(p, c)
  }
  await fail(pair![0]); await fail(pair![1])
  const prefix = (await hashOf(pair![0])).slice(0, 4)
  const text = await resolveFailure(io, cwd, { id: prefix, reason: 'fixed' })
  expect(text).toContain('matches 2 records')
  const paths = await pathsFor(io, cwd)
  expect(await readRecord(io, paths, await hashOf(pair![0]))).not.toBeNull()
  expect(await readStats(io, paths)).toEqual([])
})

test('resolve refuses bad input without throwing (Review Focus 1)', async () => {
  expect(await resolveFailure(io, cwd, { reason: 'x' })).toBe('cassandra: Name the failure by exactly one of `command` or `id`.')
  expect(await resolveFailure(io, cwd, { command: 'a', id: 'abcd', reason: 'x' })).toBe('cassandra: Name the failure by exactly one of `command` or `id`.')
  expect(await resolveFailure(io, cwd, { command: 'a', reason: '   ' })).toBe('cassandra: Give a `reason`: what was fixed, and where.')
  expect(await resolveFailure(io, cwd, { command: 'a' })).toBe('cassandra: Give a `reason`: what was fixed, and where.')
  expect(await resolveFailure(io, cwd, { id: ['x'], reason: 'r' })).toBe('cassandra: `id` must be a string.')
  expect(await resolveFailure(io, cwd, 'nonsense')).toBe('cassandra: Name the failure by exactly one of `command` or `id`.')
})

test('resolve an unknown command says so and writes nothing', async () => {
  expect(await resolveFailure(io, cwd, { command: 'make', reason: 'x' })).toBe('cassandra: No remembered failure matches `make`.')
  expect(await readStats(io, await pathsFor(io, cwd))).toEqual([])
})

test('a long or hostile reason is stored capped (Review Focus 3)', async () => {
  await fail('bun test')
  await resolveFailure(io, cwd, { command: 'bun test', reason: `\u001b[31m${'y'.repeat(2000)}` })
  const [line] = await readStats(io, await pathsFor(io, cwd))
  expect(line!.reason!.length).toBe(240)
  expect(line!.reason!.startsWith('[31m')).toBe(true)
})

test('a store that cannot be read becomes a text result, not a throw', async () => {
  io.env = async () => undefined
  io.homeDir = async () => ''
  expect(await queryText(io, cwd, {})).toStartWith('cassandra: ')
  expect(await resolveFailure(io, cwd, { command: 'x', reason: 'y' })).toStartWith('cassandra: ')
})

test('query with a command appends the fix sentence after the verdict', async () => {
  await fail('bun test')
  await writeFix(io, await pathsFor(io, cwd), await hashOf('bun test'), { kind: 'changed', files: ['fix.txt'], more: 0, at: '2026-10-09T10:00:00.000Z' })
  expect(await queryText(io, cwd, { command: 'bun test' })).toEndWith(
    'Nothing in this directory tree has changed since. Last time this started working after `fix.txt` changed (2026-10-09).',
  )
})

test('query without a command shows the fix sentence before the id', async () => {
  await fail('bun test')
  const hash = await hashOf('bun test')
  await writeFix(io, await pathsFor(io, cwd), hash, { kind: 'changed', files: ['fix.txt'], more: 0, at: '2026-10-09T10:00:00.000Z' })
  const text = await queryText(io, cwd, {})
  expect(text).toContain(`changed (2026-10-09). [${hash.slice(0, 8)}]`)
})
