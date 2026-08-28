import { afterEach, beforeEach, expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathsFor, type Paths } from '../src/paths'
import { appendStat, attributeBoundary, readStats } from '../src/stats'

let tmp: string
let paths: Paths

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cass-stats-'))
  process.env.CASSANDRA_HOME = join(tmp, 'home')
  paths = pathsFor(tmp)
})

afterEach(() => {
  delete process.env.CASSANDRA_HOME
  rmSync(tmp, { recursive: true, force: true })
})

test('reading an absent log yields an empty array', () => {
  expect(readStats(paths)).toEqual([])
})

test('appended events round-trip in order', () => {
  appendStat(paths, { kind: 'warned', hash: 'aaaa', boundary: 'compaction' })
  appendStat(paths, { kind: 'confirmed', hash: 'aaaa' })
  const events = readStats(paths)
  expect(events).toHaveLength(2)
  expect(events[0]!.kind).toBe('warned')
  expect(events[0]!.boundary).toBe('compaction')
  expect(events[1]!.kind).toBe('confirmed')
  expect(events[0]!.t).toBeString()
})

test('a corrupt line is skipped rather than failing the read', () => {
  appendStat(paths, { kind: 'warned', hash: 'aaaa' })
  appendFileSync(paths.stats, 'not json at all\n')
  appendStat(paths, { kind: 'confirmed', hash: 'aaaa' })
  expect(readStats(paths)).toHaveLength(2)
})

test('a subagent warning is attributed to the subagent boundary', () => {
  expect(attributeBoundary(
    { sessionId: 's1', compactions: 0 },
    { sessionId: 's1', compactions: 0, agentId: 'a1' },
  )).toBe('subagent')
})

test('a warning in a later session is attributed to the session boundary', () => {
  expect(attributeBoundary(
    { sessionId: 's1', compactions: 0 },
    { sessionId: 's2', compactions: 0 },
  )).toBe('session')
})

test('a warning after a compaction is attributed to compaction', () => {
  expect(attributeBoundary(
    { sessionId: 's1', compactions: 0 },
    { sessionId: 's1', compactions: 1 },
  )).toBe('compaction')
})

test('a warning inside one intact context is attributed to same_context', () => {
  expect(attributeBoundary(
    { sessionId: 's1', compactions: 2 },
    { sessionId: 's1', compactions: 2 },
  )).toBe('same_context')
})

test('the same agent retrying inside the same context is same_context, not subagent', () => {
  expect(attributeBoundary(
    { sessionId: 's1', compactions: 0, agentId: 'a1' },
    { sessionId: 's1', compactions: 0, agentId: 'a1' },
  )).toBe('same_context')
})

test('a different agent is a subagent boundary', () => {
  expect(attributeBoundary(
    { sessionId: 's1', compactions: 0, agentId: 'a1' },
    { sessionId: 's1', compactions: 0, agentId: 'a2' },
  )).toBe('subagent')
})

test('an agentId on current only is a subagent boundary', () => {
  expect(attributeBoundary(
    { sessionId: 's1', compactions: 0 },
    { sessionId: 's1', compactions: 0, agentId: 'a1' },
  )).toBe('subagent')
})

test('an agentId on recorded only is a subagent boundary', () => {
  expect(attributeBoundary(
    { sessionId: 's1', compactions: 0, agentId: 'a1' },
    { sessionId: 's1', compactions: 0 },
  )).toBe('subagent')
})

test('a subagent in a later session is subagent (most specific boundary wins)', () => {
  expect(attributeBoundary(
    { sessionId: 's1', compactions: 0, agentId: 'a1' },
    { sessionId: 's2', compactions: 0, agentId: 'a2' },
  )).toBe('subagent')
})

test('appended timestamp cannot be overridden by event payload', () => {
  const beforeTime = Date.now()
  appendStat(paths, { kind: 'warned', hash: 'xxxx', t: 'old-time' } as any)
  const afterTime = Date.now()
  const events = readStats(paths)
  expect(events).toHaveLength(1)
  const eventTime = new Date(events[0]!.t).getTime()
  expect(eventTime).toBeGreaterThanOrEqual(beforeTime - 100)
  expect(eventTime).toBeLessThanOrEqual(afterTime + 100)
  expect(events[0]!.t).not.toBe('old-time')
})

test('invalid json shapes are skipped without breaking the read', () => {
  appendStat(paths, { kind: 'warned', hash: 'aaaa' })
  appendFileSync(paths.stats, '42\n')
  appendFileSync(paths.stats, '"string"\n')
  appendFileSync(paths.stats, '[1,2,3]\n')
  appendFileSync(paths.stats, '{}\n')
  appendFileSync(paths.stats, 'null\n')
  appendStat(paths, { kind: 'confirmed', hash: 'bbbb' })
  const events = readStats(paths)
  expect(events).toHaveLength(2)
  expect(events[0]!.hash).toBe('aaaa')
  expect(events[1]!.hash).toBe('bbbb')
})
