import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathsFor, recordPath, type Paths } from '../src/paths'
import { deleteRecord, listRecords, readRecord, upsertRecord } from '../src/record'

let tmp: string
let paths: Paths

const seed = {
  tool: 'Bash',
  display: 'bun test',
  kind: 'failure' as const,
  stateStamp: 'a3f1c8',
  stateKind: 'git' as const,
  sessionId: 's1',
  compactions: 0,
  errorExcerpt: '3 tests failing',
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cass-rec-'))
  process.env.CASSANDRA_HOME = join(tmp, 'home')
  paths = pathsFor(tmp)
})

afterEach(() => {
  delete process.env.CASSANDRA_HOME
  rmSync(tmp, { recursive: true, force: true })
})

test('a missing record reads as null', () => {
  expect(readRecord(paths, 'deadbeefdeadbeef')).toBeNull()
})

test('upsert creates a record with count 1', () => {
  upsertRecord(paths, 'aa11bb22cc33dd44', seed)
  const r = readRecord(paths, 'aa11bb22cc33dd44')
  expect(r?.count).toBe(1)
  expect(r?.display).toBe('bun test')
  expect(r?.firstSeen).toBe(r?.lastSeen)
})

test('upsert on an existing record increments and refreshes state, keeping firstSeen', () => {
  upsertRecord(paths, 'aa11bb22cc33dd44', seed)
  const first = readRecord(paths, 'aa11bb22cc33dd44')!
  upsertRecord(paths, 'aa11bb22cc33dd44', { ...seed, stateStamp: '9c0201', sessionId: 's2' })
  const second = readRecord(paths, 'aa11bb22cc33dd44')!
  expect(second.count).toBe(2)
  expect(second.stateStamp).toBe('9c0201')
  expect(second.sessionId).toBe('s2')
  expect(second.firstSeen).toBe(first.firstSeen)
})

test('a corrupt record is deleted and reads as null', () => {
  const p = recordPath(paths, 'ffeeddccbbaa9988')
  mkdirSync(join(paths.records, 'ff'), { recursive: true })
  writeFileSync(p, 'not json at all')
  expect(readRecord(paths, 'ffeeddccbbaa9988')).toBeNull()
  expect(existsSync(p)).toBe(false)
})

test('a record missing required fields is treated as corrupt', () => {
  const p = recordPath(paths, '1122334455667788')
  mkdirSync(join(paths.records, '11'), { recursive: true })
  writeFileSync(p, JSON.stringify({ tool: 'Bash' }))
  expect(readRecord(paths, '1122334455667788')).toBeNull()
  expect(existsSync(p)).toBe(false)
})

test('delete removes a record', () => {
  upsertRecord(paths, 'aa11bb22cc33dd44', seed)
  deleteRecord(paths, 'aa11bb22cc33dd44')
  expect(readRecord(paths, 'aa11bb22cc33dd44')).toBeNull()
})

test('delete on a missing record does not throw', () => {
  expect(() => deleteRecord(paths, 'nosuchnosuch1234')).not.toThrow()
})

test('listRecords returns every stored record across shards', () => {
  upsertRecord(paths, 'aa11bb22cc33dd44', seed)
  upsertRecord(paths, 'bb11bb22cc33dd44', { ...seed, display: 'bun run build' })
  const all = listRecords(paths)
  expect(all).toHaveLength(2)
  expect(all.map((e) => e.record.display).sort()).toEqual(['bun run build', 'bun test'])
})

test('listRecords on an empty index returns an empty array', () => {
  expect(listRecords(paths)).toEqual([])
})
