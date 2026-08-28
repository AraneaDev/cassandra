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
