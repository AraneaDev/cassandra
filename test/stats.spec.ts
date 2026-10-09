import { afterEach, beforeEach, expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathsFor, type Paths } from '../src/core/paths.ts'
import { nodeIo } from '../src/io/node.ts'
import { appendStat, attributeBoundary, readStats } from '../src/core/stats.ts'

let tmp: string
let paths: Paths

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'cass-stats-'))
  process.env.CASSANDRA_HOME = join(tmp, 'home')
  paths = await pathsFor(nodeIo, tmp)
})

afterEach(async () => {
  delete process.env.CASSANDRA_HOME
  rmSync(tmp, { recursive: true, force: true })
})

test('reading an absent log yields an empty array', async () => {
  expect(await readStats(nodeIo, paths)).toEqual([])
})

test('appended events round-trip in order', async () => {
  await appendStat(nodeIo, paths, { kind: 'warned', hash: 'aaaa', boundary: 'compaction' })
  await appendStat(nodeIo, paths, { kind: 'confirmed', hash: 'aaaa' })
  const events = await readStats(nodeIo, paths)
  expect(events).toHaveLength(2)
  expect(events[0]!.kind).toBe('warned')
  expect(events[0]!.boundary).toBe('compaction')
  expect(events[1]!.kind).toBe('confirmed')
  expect(events[0]!.t).toBeString()
})

test('a corrupt line is skipped rather than failing the read', async () => {
  await appendStat(nodeIo, paths, { kind: 'warned', hash: 'aaaa' })
  appendFileSync(paths.stats, 'not json at all\n')
  await appendStat(nodeIo, paths, { kind: 'confirmed', hash: 'aaaa' })
  expect(await readStats(nodeIo, paths)).toHaveLength(2)
})

test('a subagent warning is attributed to the subagent boundary', async () => {
  expect(attributeBoundary(
    { sessionId: 's1', compactions: 0 },
    { sessionId: 's1', compactions: 0, agentId: 'a1' },
  )).toBe('subagent')
})

test('a warning in a later session is attributed to the session boundary', async () => {
  expect(attributeBoundary(
    { sessionId: 's1', compactions: 0 },
    { sessionId: 's2', compactions: 0 },
  )).toBe('session')
})

test('a warning after a compaction is attributed to compaction', async () => {
  expect(attributeBoundary(
    { sessionId: 's1', compactions: 0 },
    { sessionId: 's1', compactions: 1 },
  )).toBe('compaction')
})

test('a warning inside one intact context is attributed to same_context', async () => {
  expect(attributeBoundary(
    { sessionId: 's1', compactions: 2 },
    { sessionId: 's1', compactions: 2 },
  )).toBe('same_context')
})

test('the same agent retrying inside the same context is same_context, not subagent', async () => {
  expect(attributeBoundary(
    { sessionId: 's1', compactions: 0, agentId: 'a1' },
    { sessionId: 's1', compactions: 0, agentId: 'a1' },
  )).toBe('same_context')
})

test('a different agent is a subagent boundary', async () => {
  expect(attributeBoundary(
    { sessionId: 's1', compactions: 0, agentId: 'a1' },
    { sessionId: 's1', compactions: 0, agentId: 'a2' },
  )).toBe('subagent')
})

test('an agentId on current only is a subagent boundary', async () => {
  expect(attributeBoundary(
    { sessionId: 's1', compactions: 0 },
    { sessionId: 's1', compactions: 0, agentId: 'a1' },
  )).toBe('subagent')
})

test('an agentId on recorded only is a subagent boundary', async () => {
  expect(attributeBoundary(
    { sessionId: 's1', compactions: 0, agentId: 'a1' },
    { sessionId: 's1', compactions: 0 },
  )).toBe('subagent')
})

test('a subagent in a later session is subagent (most specific boundary wins)', async () => {
  expect(attributeBoundary(
    { sessionId: 's1', compactions: 0, agentId: 'a1' },
    { sessionId: 's2', compactions: 0, agentId: 'a2' },
  )).toBe('subagent')
})

test('appended timestamp cannot be overridden by event payload', async () => {
  const beforeTime = Date.now()
  await appendStat(nodeIo, paths, { kind: 'warned', hash: 'xxxx', t: 'old-time' } as any)
  const afterTime = Date.now()
  const events = await readStats(nodeIo, paths)
  expect(events).toHaveLength(1)
  const eventTime = new Date(events[0]!.t).getTime()
  expect(eventTime).toBeGreaterThanOrEqual(beforeTime - 100)
  expect(eventTime).toBeLessThanOrEqual(afterTime + 100)
  expect(events[0]!.t).not.toBe('old-time')
})

test('invalid json shapes are skipped without breaking the read', async () => {
  await appendStat(nodeIo, paths, { kind: 'warned', hash: 'aaaa' })
  appendFileSync(paths.stats, '42\n')
  appendFileSync(paths.stats, '"string"\n')
  appendFileSync(paths.stats, '[1,2,3]\n')
  appendFileSync(paths.stats, '{}\n')
  appendFileSync(paths.stats, 'null\n')
  await appendStat(nodeIo, paths, { kind: 'confirmed', hash: 'bbbb' })
  const events = await readStats(nodeIo, paths)
  expect(events).toHaveLength(2)
  expect(events[0]!.hash).toBe('aaaa')
  expect(events[1]!.hash).toBe('bbbb')
})

test('briefed lines round-trip, and a malformed one is skipped', async () => {
  await appendStat(nodeIo, paths, { kind: 'briefed', boundary: 'compaction', hashes: ['aa11bb22cc33dd44'] })
  appendFileSync(paths.stats, '{"kind":"briefed","boundary":"subagent","hashes":"not-an-array","t":"x"}\n')
  const events = await readStats(nodeIo, paths)
  expect(events).toHaveLength(1)
  expect(events[0]).toMatchObject({ kind: 'briefed', boundary: 'compaction', hashes: ['aa11bb22cc33dd44'] })
})
