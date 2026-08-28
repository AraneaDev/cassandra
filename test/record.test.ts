import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

test('a record missing newly-required fields (sessionId, compactions, errorExcerpt) is treated as corrupt', () => {
  const p = recordPath(paths, '3344556677889900')
  mkdirSync(join(paths.records, '33'), { recursive: true })
  writeFileSync(p, JSON.stringify({
    tool: 'Bash',
    display: 'bun test',
    kind: 'failure',
    count: 1,
    stateStamp: 'a3f1c8',
    stateKind: 'git',
    firstSeen: new Date().toISOString(),
    lastSeen: new Date().toISOString(),
  }))
  expect(readRecord(paths, '3344556677889900')).toBeNull()
  expect(existsSync(p)).toBe(false)
})

test('listRecords returns all records even with stray non-directory files present', () => {
  // Create a stray file early in directory order so it's encountered first
  mkdirSync(join(paths.records, '00'), { recursive: true })
  writeFileSync(join(paths.records, '.DS_Store'), 'stray file')

  // Create records in different shards
  upsertRecord(paths, 'aa11bb22cc33dd44', seed)
  upsertRecord(paths, 'bb22cc33dd44ee55', { ...seed, display: 'bun run build' })

  const all = listRecords(paths)
  expect(all).toHaveLength(2)
  expect(all.map((e) => e.record.display).sort()).toEqual(['bun run build', 'bun test'])
})

// `readRecord` deletes anything it cannot parse. Before the hash was validated, a
// traversal hash resolved outside the index and that delete hit an arbitrary file:
// `recordPath(paths, '../../victim')` landed on `<home>/victim.json`. This is the
// regression test for that, with a real file created outside the index.

test('readRecord with a traversal hash deletes nothing outside the index', () => {
  const victimDir = join(tmp, 'outside')
  mkdirSync(victimDir, { recursive: true })
  const victim = join(victimDir, 'victim.json')
  writeFileSync(victim, 'not json at all')

  // The exact shape that used to escape, plus the sibling forms of it.
  for (const hostile of [
    '../../outside/victim',
    join('..', '..', 'outside', 'victim'),
    `${victimDir}/victim`,
    '..',
    '.',
  ]) {
    expect(readRecord(paths, hostile)).toBeNull()
  }

  expect(existsSync(victim)).toBe(true)
  expect(readFileSync(victim, 'utf8')).toBe('not json at all')
  expect(existsSync(victimDir)).toBe(true)
})

test('deleteRecord with a traversal hash deletes nothing outside the index', () => {
  const victimDir = join(tmp, 'outside2')
  mkdirSync(victimDir, { recursive: true })
  const victim = join(victimDir, 'victim.json')
  writeFileSync(victim, 'keep me')

  deleteRecord(paths, '../../outside2/victim')
  deleteRecord(paths, `${victimDir}/victim`)
  deleteRecord(paths, '..')

  expect(existsSync(victim)).toBe(true)
})

test('a record stored under a non-fingerprint hash still round-trips inside the index', () => {
  // Everything that is not a fingerprint collapses to one fixed name, so writing and
  // reading stay consistent rather than the write landing somewhere the read cannot see.
  upsertRecord(paths, 'not-a-hash', seed)
  expect(existsSync(join(paths.records, 'in', 'invalid.json'))).toBe(true)
  expect(readRecord(paths, 'also-not-a-hash')?.display).toBe('bun test')
})

