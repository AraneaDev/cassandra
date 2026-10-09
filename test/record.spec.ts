import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathsFor, recordPath, type Paths } from '../src/core/paths.ts'
import { nodeIo } from '../src/io/node.ts'
import { deleteRecord, listRecords, readRecord, upsertRecord } from '../src/core/record.ts'

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

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'cass-rec-'))
  process.env.CASSANDRA_HOME = join(tmp, 'home')
  paths = await pathsFor(nodeIo, tmp)
})

afterEach(async () => {
  delete process.env.CASSANDRA_HOME
  rmSync(tmp, { recursive: true, force: true })
})

test('a missing record reads as null', async () => {
  expect(await readRecord(nodeIo, paths, 'deadbeefdeadbeef')).toBeNull()
})

test('upsert creates a record with count 1', async () => {
  await upsertRecord(nodeIo, paths, 'aa11bb22cc33dd44', seed)
  const r = await readRecord(nodeIo, paths, 'aa11bb22cc33dd44')
  expect(r?.count).toBe(1)
  expect(r?.display).toBe('bun test')
  expect(r?.firstSeen).toBe(r?.lastSeen)
})

test('upsert on an existing record increments and refreshes state, keeping firstSeen', async () => {
  await upsertRecord(nodeIo, paths, 'aa11bb22cc33dd44', seed)
  const first = (await readRecord(nodeIo, paths, 'aa11bb22cc33dd44'))!
  await upsertRecord(nodeIo, paths, 'aa11bb22cc33dd44', { ...seed, stateStamp: '9c0201', sessionId: 's2' })
  const second = (await readRecord(nodeIo, paths, 'aa11bb22cc33dd44'))!
  expect(second.count).toBe(2)
  expect(second.stateStamp).toBe('9c0201')
  expect(second.sessionId).toBe('s2')
  expect(second.firstSeen).toBe(first.firstSeen)
})

test('a record carrying dirtyHashes is valid and survives every reader', async () => {
  const hashes = { 'a.txt': '0123456789abcdef' }
  await upsertRecord(nodeIo, paths, 'aa11bb22cc33dd44', { ...seed, gitHead: 'no-head', dirty: ['a.txt'], dirtyHashes: hashes })
  expect((await readRecord(nodeIo, paths, 'aa11bb22cc33dd44'))?.dirtyHashes).toEqual(hashes)
  expect((await listRecords(nodeIo, paths)).map((r) => r.record.dirtyHashes)).toEqual([hashes])
})

test('a corrupt record is deleted and reads as null', async () => {
  const p = recordPath(paths, 'ffeeddccbbaa9988')
  mkdirSync(join(paths.records, 'ff'), { recursive: true })
  writeFileSync(p, 'not json at all')
  expect(await readRecord(nodeIo, paths, 'ffeeddccbbaa9988')).toBeNull()
  expect(existsSync(p)).toBe(false)
})

test('a record missing required fields is treated as corrupt', async () => {
  const p = recordPath(paths, '1122334455667788')
  mkdirSync(join(paths.records, '11'), { recursive: true })
  writeFileSync(p, JSON.stringify({ tool: 'Bash' }))
  expect(await readRecord(nodeIo, paths, '1122334455667788')).toBeNull()
  expect(existsSync(p)).toBe(false)
})

test('delete removes a record', async () => {
  await upsertRecord(nodeIo, paths, 'aa11bb22cc33dd44', seed)
  await deleteRecord(nodeIo, paths, 'aa11bb22cc33dd44')
  expect(await readRecord(nodeIo, paths, 'aa11bb22cc33dd44')).toBeNull()
})

test('delete on a missing record does not throw', async () => {
  await expect(deleteRecord(nodeIo, paths, 'nosuchnosuch1234')).resolves.toBeUndefined()
})

test('listRecords returns every stored record across shards', async () => {
  await upsertRecord(nodeIo, paths, 'aa11bb22cc33dd44', seed)
  await upsertRecord(nodeIo, paths, 'bb11bb22cc33dd44', { ...seed, display: 'bun run build' })
  const all = await listRecords(nodeIo, paths)
  expect(all).toHaveLength(2)
  expect(all.map((e) => e.record.display).sort()).toEqual(['bun run build', 'bun test'])
})

test('listRecords on an empty index returns an empty array', async () => {
  expect(await listRecords(nodeIo, paths)).toEqual([])
})

test('a record missing newly-required fields (sessionId, compactions, errorExcerpt) is treated as corrupt', async () => {
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
  expect(await readRecord(nodeIo, paths, '3344556677889900')).toBeNull()
  expect(existsSync(p)).toBe(false)
})

test('listRecords returns all records even with stray non-directory files present', async () => {
  // Create a stray file early in directory order so it's encountered first
  mkdirSync(join(paths.records, '00'), { recursive: true })
  writeFileSync(join(paths.records, '.DS_Store'), 'stray file')

  // Create records in different shards
  await upsertRecord(nodeIo, paths, 'aa11bb22cc33dd44', seed)
  await upsertRecord(nodeIo, paths, 'bb22cc33dd44ee55', { ...seed, display: 'bun run build' })

  const all = await listRecords(nodeIo, paths)
  expect(all).toHaveLength(2)
  expect(all.map((e) => e.record.display).sort()).toEqual(['bun run build', 'bun test'])
})

// `readRecord` deletes anything it cannot parse. Before the hash was validated, a
// traversal hash resolved outside the index and that delete hit an arbitrary file:
// `recordPath(paths, '../../victim')` landed on `<home>/victim.json`. This is the
// regression test for that, with a real file created outside the index.

test('readRecord with a traversal hash deletes nothing outside the index', async () => {
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
    expect(await readRecord(nodeIo, paths, hostile)).toBeNull()
  }

  expect(existsSync(victim)).toBe(true)
  expect(readFileSync(victim, 'utf8')).toBe('not json at all')
  expect(existsSync(victimDir)).toBe(true)
})

test('deleteRecord with a traversal hash deletes nothing outside the index', async () => {
  const victimDir = join(tmp, 'outside2')
  mkdirSync(victimDir, { recursive: true })
  const victim = join(victimDir, 'victim.json')
  writeFileSync(victim, 'keep me')

  await deleteRecord(nodeIo, paths, '../../outside2/victim')
  await deleteRecord(nodeIo, paths, `${victimDir}/victim`)
  await deleteRecord(nodeIo, paths, '..')

  expect(existsSync(victim)).toBe(true)
})

test('a record stored under a non-fingerprint hash still round-trips inside the index', async () => {
  // Everything that is not a fingerprint collapses to one fixed name, so writing and
  // reading stay consistent rather than the write landing somewhere the read cannot see.
  await upsertRecord(nodeIo, paths, 'not-a-hash', seed)
  expect(existsSync(join(paths.records, 'in', 'invalid.json'))).toBe(true)
  expect((await readRecord(nodeIo, paths, 'also-not-a-hash'))?.display).toBe('bun test')
})

// writeFileSync is not atomic, and Claude Code runs Bash calls in parallel. A reader
// that saw a half-written file would judge it corrupt and delete it while the writer
// finished into an unlinked inode: a failure silently forgotten. The write now stages
// and renames.

test('upsert leaves no staging file behind and listRecords ignores stray ones', async () => {
  await upsertRecord(nodeIo, paths, 'aa11bb22cc33dd44', seed)
  const shard = join(paths.records, 'aa')
  expect(readdirSync(shard)).toEqual(['aa11bb22cc33dd44.json'])

  writeFileSync(join(shard, 'aa11bb22cc33dd44.json.999.abc.tmp'), '{"half":')
  expect(await listRecords(nodeIo, paths)).toHaveLength(1)
  expect((await readRecord(nodeIo, paths, 'aa11bb22cc33dd44'))?.count).toBe(1)
})

test('concurrent writers never lose the record', async () => {
  const script = join(tmp, 'writer.ts')
  writeFileSync(script, `
    import { upsertRecord, readRecord } from ${JSON.stringify(join(import.meta.dir, '..', 'src', 'core', 'record.ts'))}
    import { pathsFor } from ${JSON.stringify(join(import.meta.dir, '..', 'src', 'core', 'paths.ts'))}
    import { nodeIo } from ${JSON.stringify(join(import.meta.dir, '..', 'src', 'io', 'node.ts'))}
    const paths = await pathsFor(nodeIo, process.argv[2])
    const seed = ${JSON.stringify(seed)}
    for (let i = 0; i < 40; i += 1) {
      await upsertRecord(nodeIo, paths, 'aa11bb22cc33dd44', seed)
      await readRecord(nodeIo, paths, 'aa11bb22cc33dd44')
    }
  `)

  const procs = Array.from({ length: 6 }, () => Bun.spawn(
    ['bun', 'run', script, tmp],
    { env: { ...process.env, CASSANDRA_HOME: join(tmp, 'home') }, stdout: 'ignore', stderr: 'ignore' },
  ))
  for (const proc of procs) expect(await proc.exited).toBe(0)

  // The count may drift under a lost update, which is acceptable. The record itself
  // being gone is not: that is a remembered failure silently forgotten.
  const final = await readRecord(nodeIo, paths, 'aa11bb22cc33dd44')
  expect(final).not.toBeNull()
  expect(final!.count).toBeGreaterThan(0)
  expect(final!.display).toBe('bun test')
  expect(readdirSync(join(paths.records, 'aa')).filter((f) => f.endsWith('.tmp'))).toEqual([])
})

