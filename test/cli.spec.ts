import { afterEach, beforeEach, expect, test } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { run } from '../src/cli'
import { pathsFor, recordPath, type Paths } from '../src/core/paths.ts'
import { nodeIo } from '../src/io/node.ts'
import { listRecords, upsertRecord } from '../src/core/record.ts'
import { appendStat } from '../src/core/stats.ts'

let tmp: string
let cwd: string
let out: string[]
let originalLog: typeof console.log

const seed = {
  tool: 'Bash', display: 'bun test', kind: 'failure' as const,
  stateStamp: 'a3f1c8', stateKind: 'git' as const,
  sessionId: 's1', compactions: 0, errorExcerpt: '3 tests failing',
}

function line(paths: Paths, e: object): void {
  mkdirSync(dirname(paths.stats), { recursive: true })
  appendFileSync(paths.stats, `${JSON.stringify(e)}\n`)
}

function writeRecordAt(paths: Paths, hash: string, firstSeen: string): void {
  const file = recordPath(paths, hash)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ ...seed, count: 1, firstSeen, lastSeen: firstSeen }))
}

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'cass-cli-'))
  process.env.CASSANDRA_HOME = join(tmp, 'home')
  cwd = join(tmp, 'proj')
  mkdirSync(cwd, { recursive: true })
  out = []
  originalLog = console.log
  console.log = (...args: unknown[]) => { out.push(args.join(' ')) }
})

afterEach(async () => {
  console.log = originalLog
  delete process.env.CASSANDRA_HOME
  rmSync(tmp, { recursive: true, force: true })
})

test('list on an empty index says so and exits 0', async () => {
  expect(await run(['list', '--cwd', cwd])).toBe(0)
  expect(out.join('\n')).toContain('No remembered failures')
})

test('list shows a stored record', async () => {
  await upsertRecord(nodeIo, await pathsFor(nodeIo, cwd), 'aa11bb22cc33dd44', seed)
  expect(await run(['list', '--cwd', cwd])).toBe(0)
  expect(out.join('\n')).toContain('bun test')
  expect(out.join('\n')).toContain('aa11bb22')
})

test('list with multiple records sorts and shows every one', async () => {
  const p = await pathsFor(nodeIo, cwd)
  await upsertRecord(nodeIo, p, 'aa11bb22cc33dd44', seed)
  await upsertRecord(nodeIo, p, 'bb11bb22cc33dd44', { ...seed, display: 'bun typecheck' })
  expect(await run(['list', '--cwd', cwd])).toBe(0)
  const text = out.join('\n')
  expect(text).toContain('2 remembered failures')
  expect(text).toContain('bun test')
  expect(text).toContain('bun typecheck')
})

test('why prints the full record', async () => {
  await upsertRecord(nodeIo, await pathsFor(nodeIo, cwd), 'aa11bb22cc33dd44', seed)
  expect(await run(['why', 'aa11bb22cc33dd44', '--cwd', cwd])).toBe(0)
  expect(out.join('\n')).toContain('3 tests failing')
})

test('why on an unknown hash exits 1', async () => {
  expect(await run(['why', 'deadbeefdeadbeef', '--cwd', cwd])).toBe(1)
  expect(out.join('\n')).toContain('No record for')
})

// argv reaches the record path, and a record path lookup can end in a delete. Both
// commands refuse anything that is not a real fingerprint rather than passing it on.

test('why refuses anything that could reach a path builder, and exits 1', async () => {
  // The security property: argv that is not pure hex never becomes a path segment.
  for (const bad of ['nope', '../../victim', '', '..', '/etc/passwd', 'a/b']) {
    out.length = 0
    expect(await run(['why', bad, '--cwd', cwd])).toBe(1)
    expect(out.join('\n')).toContain('Not a hash')
  }
  // Hex that matches no record is refused too, with a different reason.
  out.length = 0
  expect(await run(['why', 'deadbeef', '--cwd', cwd])).toBe(1)
  expect(out.join('\n')).toContain('No record matching')
})

test('why accepts the 8-character prefix that `list` actually prints', async () => {
  await upsertRecord(nodeIo, await pathsFor(nodeIo, cwd), 'aa11bb22cc33dd44', seed)
  out.length = 0
  expect(await run(['why', 'aa11bb22', '--cwd', cwd])).toBe(0)
  expect(out.join('\n')).toContain('bun test')
})

test('an ambiguous prefix is refused and names the candidates', async () => {
  await upsertRecord(nodeIo, await pathsFor(nodeIo, cwd), 'aa11bb22cc33dd44', seed)
  await upsertRecord(nodeIo, await pathsFor(nodeIo, cwd), 'aa11ffffcc33dd44', seed)
  out.length = 0
  expect(await run(['why', 'aa11', '--cwd', cwd])).toBe(1)
  expect(out.join('\n')).toContain('matches 2 records')
})

test('forget refuses anything that could reach a path builder, and deletes nothing', async () => {
  await upsertRecord(nodeIo, await pathsFor(nodeIo, cwd), 'aa11bb22cc33dd44', seed)
  for (const bad of ['nope', '../../victim', '..', 'a/b']) {
    out.length = 0
    expect(await run(['forget', bad, '--cwd', cwd])).toBe(1)
    expect(out.join('\n')).toContain('Not a hash')
  }
  // The record it was given alongside those must still be there.
  expect(await listRecords(nodeIo, await pathsFor(nodeIo, cwd))).toHaveLength(1)
  out.length = 0
  expect(await run(['list', '--cwd', cwd])).toBe(0)
  expect(out.join('\n')).toContain('bun test')
})

test('forget removes one record', async () => {
  await upsertRecord(nodeIo, await pathsFor(nodeIo, cwd), 'aa11bb22cc33dd44', seed)
  expect(await run(['forget', 'aa11bb22cc33dd44', '--cwd', cwd])).toBe(0)
  out.length = 0
  expect(await run(['list', '--cwd', cwd])).toBe(0)
  expect(out.join('\n')).toContain('No remembered failures')
})

test('forget with no hash and no --all exits 1', async () => {
  expect(await run(['forget', '--cwd', cwd])).toBe(1)
  expect(out.join('\n')).toContain('Pass a hash, or --all')
})

test('forget --all empties the index', async () => {
  await upsertRecord(nodeIo, await pathsFor(nodeIo, cwd), 'aa11bb22cc33dd44', seed)
  await upsertRecord(nodeIo, await pathsFor(nodeIo, cwd), 'bb11bb22cc33dd44', seed)
  expect(await run(['forget', '--all', '--cwd', cwd])).toBe(0)
  expect(out.join('\n')).toContain('Forgot 2')
})

test('stats reports the false-positive rate and boundary shares', async () => {
  const p = await pathsFor(nodeIo, cwd)
  await appendStat(nodeIo, p, { kind: 'warned', hash: 'a', boundary: 'compaction' })
  await appendStat(nodeIo, p, { kind: 'warned', hash: 'b', boundary: 'same_context' })
  await appendStat(nodeIo, p, { kind: 'confirmed', hash: 'a' })
  await appendStat(nodeIo, p, { kind: 'false_positive', hash: 'b' })
  expect(await run(['stats', '--cwd', cwd])).toBe(0)
  const text = out.join('\n')
  expect(text).toContain('2 warnings')
  expect(text).toContain('50.0%')
  expect(text).toContain('compaction')
  // The README makes uninstalling the conclusion for a high same_context share, and the
  // CLI is where you actually read the number, so it has to say so too.
  expect(text).toContain('same_context')
  expect(text).toContain('uninstalling')
})

test('stats on an empty log exits 0 and says nothing has been measured', async () => {
  expect(await run(['stats', '--cwd', cwd])).toBe(0)
  expect(out.join('\n')).toContain('No warnings recorded')
})

test('export emits parseable JSON', async () => {
  await upsertRecord(nodeIo, await pathsFor(nodeIo, cwd), 'aa11bb22cc33dd44', seed)
  expect(await run(['export', '--cwd', cwd])).toBe(0)
  const parsed = JSON.parse(out.join('\n'))
  expect(parsed.records).toHaveLength(1)
  expect(parsed.records[0].hash).toBe('aa11bb22cc33dd44')
})

test('no arguments prints usage and exits 1', async () => {
  expect(await run([])).toBe(1)
  expect(out.join('\n')).toContain('Usage')
})

test('an unknown subcommand prints usage and exits 1', async () => {
  expect(await run(['nonsense'])).toBe(1)
})

// The brief's argv handling computed `cwdFlag + 1` even when `--cwd` was absent
// (cwdFlag === -1, so cwdFlag + 1 === 0), which filtered out argv[0] -- the
// subcommand itself -- whenever --cwd was not passed. These tests exercise that
// path directly, without --cwd, against the real process.cwd() (this repo). The
// index there will simply be empty, so assertions are on exit code and on the
// absence of "Usage" rather than on specific record contents.

test('list without --cwd runs the list command, not usage', async () => {
  expect(await run(['list'])).toBe(0)
  expect(out.join('\n')).not.toContain('Usage')
})

test('stats without --cwd runs the stats command, not usage', async () => {
  expect(await run(['stats'])).toBe(0)
  expect(out.join('\n')).not.toContain('Usage')
})

test('export without --cwd emits parseable JSON, not usage', async () => {
  expect(await run(['export'])).toBe(0)
  const text = out.join('\n')
  expect(text).not.toContain('Usage')
  expect(() => JSON.parse(text)).not.toThrow()
})

test('stats reports briefings and how many briefed calls were repeated anyway', async () => {
  const paths = await pathsFor(nodeIo, cwd)
  mkdirSync(dirname(paths.stats), { recursive: true })
  const line = (t: string, e: object) => appendFileSync(paths.stats, `${JSON.stringify({ ...e, t })}\n`)
  line('2026-01-01T00:00:01Z', { kind: 'warned', hash: 'aa11bb22cc33dd44', boundary: 'same_context' })
  line('2026-01-01T00:00:02Z', { kind: 'briefed', boundary: 'subagent', hashes: ['aa11bb22cc33dd44', 'bb11bb22cc33dd44'] })
  line('2026-01-01T00:00:03Z', { kind: 'warned', hash: 'aa11bb22cc33dd44', boundary: 'subagent' })
  line('2026-01-01T00:00:04Z', { kind: 'briefed', boundary: 'compaction', hashes: ['cc11bb22cc33dd44'] })
  expect(await run(['stats', '--cwd', cwd])).toBe(0)
  const text = out.join('\n')
  expect(text).toContain('2 briefings sent')
  expect(text).toMatch(/subagent\s+1/)
  expect(text).toMatch(/compaction\s+1/)
  expect(text).toContain('repeated after briefing  1 of 3')
})

test('stats with only briefings still reports them', async () => {
  const paths = await pathsFor(nodeIo, cwd)
  await appendStat(nodeIo, paths, { kind: 'briefed', boundary: 'subagent', hashes: ['aa11bb22cc33dd44'] })
  expect(await run(['stats', '--cwd', cwd])).toBe(0)
  expect(out.join('\n')).toContain('1 briefing sent')
  expect(out.join('\n')).toStartWith('1 briefing sent')
})

test('a call warned before its briefing and never after is not counted as repeated', async () => {
  const paths = await pathsFor(nodeIo, cwd)
  mkdirSync(dirname(paths.stats), { recursive: true })
  const line = (t: string, e: object) => appendFileSync(paths.stats, `${JSON.stringify({ ...e, t })}\n`)
  line('2026-01-01T00:00:01Z', { kind: 'warned', hash: 'aa11bb22cc33dd44', boundary: 'subagent' })
  line('2026-01-01T00:00:02Z', { kind: 'briefed', boundary: 'subagent', hashes: ['aa11bb22cc33dd44'] })
  expect(await run(['stats', '--cwd', cwd])).toBe(0)
  expect(out.join('\n')).toContain('repeated after briefing  0 of 1')
})

test('stats reports agent resolves and how many failed again afterwards (Review Focus 5)', async () => {
  const paths = await pathsFor(nodeIo, cwd)
  // aa: resolved at t2, failed again (record re-created, firstSeen t3) -> counts
  // bb: resolved at t2, its record still has firstSeen t1 (never deleted) -> does not count
  // cc: resolved at t2, no record now -> does not count
  line(paths, { kind: 'resolved', hash: 'aa11bb22cc33dd44', reason: 'r', t: '2026-01-01T00:00:02.000Z' })
  line(paths, { kind: 'resolved', hash: 'bb11bb22cc33dd44', reason: 'r', t: '2026-01-01T00:00:02.000Z' })
  line(paths, { kind: 'resolved', hash: 'cc11bb22cc33dd44', reason: 'r', t: '2026-01-01T00:00:02.000Z' })
  writeRecordAt(paths, 'aa11bb22cc33dd44', '2026-01-01T00:00:03.000Z')
  writeRecordAt(paths, 'bb11bb22cc33dd44', '2026-01-01T00:00:01.000Z')
  expect(await run(['stats', '--cwd', cwd])).toBe(0)
  expect(out.join('\n')).toContain('resolved by an agent  3, failed again 1')
  expect(out.join('\n')).toStartWith('  resolved by an agent')
})
