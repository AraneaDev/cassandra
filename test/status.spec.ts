import { beforeEach, expect, test } from 'bun:test'
import { settle, type Call } from '../src/core/engine.ts'
import { statusText } from '../src/core/status.ts'
import { memoryIo, type MemoryIo } from './support/memory-io.ts'

let io: MemoryIo
const cwd = '/work/proj'
const call = (command: string): Call => ({ tool: 'Bash', input: { command }, cwd, sessionId: 's1' })

beforeEach(async () => {
  io = memoryIo()
  io.env = async (name) => (name === 'CASSANDRA_HOME' ? '/data' : undefined)
  await io.writeText(`${cwd}/a.txt`, 'one')
})

test('undefined with no records', async () => {
  expect(await statusText(io, cwd)).toBeUndefined()
})

test('counts one live failure', async () => {
  await settle(io, call('bun test'), { kind: 'failure', reason: 'x' }, null)
  expect(await statusText(io, cwd)).toBe('cassandra: 1 live failure')
})

test('counts two live failures', async () => {
  await settle(io, call('bun test'), { kind: 'failure', reason: 'x' }, null)
  await settle(io, call('bun lint'), { kind: 'failure', reason: 'y' }, null)
  expect(await statusText(io, cwd)).toBe('cassandra: 2 live failures')
})

test('undefined again once the tree changes and every record is stale', async () => {
  await settle(io, call('bun test'), { kind: 'failure', reason: 'x' }, null)
  await settle(io, call('bun lint'), { kind: 'failure', reason: 'y' }, null)
  await io.writeText(`${cwd}/b.txt`, 'two')
  expect(await statusText(io, cwd)).toBeUndefined()
})
