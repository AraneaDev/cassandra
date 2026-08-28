import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { run } from '../src/cli'
import { pathsFor } from '../src/paths'
import { upsertRecord } from '../src/record'
import { appendStat } from '../src/stats'

let tmp: string
let cwd: string
let out: string[]
let originalLog: typeof console.log

const seed = {
  tool: 'Bash', display: 'bun test', kind: 'failure' as const,
  stateStamp: 'a3f1c8', stateKind: 'git' as const,
  sessionId: 's1', compactions: 0, errorExcerpt: '3 tests failing',
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cass-cli-'))
  process.env.CASSANDRA_HOME = join(tmp, 'home')
  cwd = join(tmp, 'proj')
  mkdirSync(cwd, { recursive: true })
  out = []
  originalLog = console.log
  console.log = (...args: unknown[]) => { out.push(args.join(' ')) }
})

afterEach(() => {
  console.log = originalLog
  delete process.env.CASSANDRA_HOME
  rmSync(tmp, { recursive: true, force: true })
})

test('list on an empty index says so and exits 0', () => {
  expect(run(['list', '--cwd', cwd])).toBe(0)
  expect(out.join('\n')).toContain('No remembered failures')
})

test('list shows a stored record', () => {
  upsertRecord(pathsFor(cwd), 'aa11bb22cc33dd44', seed)
  expect(run(['list', '--cwd', cwd])).toBe(0)
  expect(out.join('\n')).toContain('bun test')
  expect(out.join('\n')).toContain('aa11bb22')
})

test('list with multiple records sorts and shows every one', () => {
  const p = pathsFor(cwd)
  upsertRecord(p, 'aa11bb22cc33dd44', seed)
  upsertRecord(p, 'bb11bb22cc33dd44', { ...seed, display: 'bun typecheck' })
  expect(run(['list', '--cwd', cwd])).toBe(0)
  const text = out.join('\n')
  expect(text).toContain('2 remembered failures')
  expect(text).toContain('bun test')
  expect(text).toContain('bun typecheck')
})

test('why prints the full record', () => {
  upsertRecord(pathsFor(cwd), 'aa11bb22cc33dd44', seed)
  expect(run(['why', 'aa11bb22cc33dd44', '--cwd', cwd])).toBe(0)
  expect(out.join('\n')).toContain('3 tests failing')
})

test('why on an unknown hash exits 1', () => {
  expect(run(['why', 'deadbeefdeadbeef', '--cwd', cwd])).toBe(1)
  expect(out.join('\n')).toContain('No record for')
})

// argv reaches the record path, and a record path lookup can end in a delete. Both
// commands refuse anything that is not a real fingerprint rather than passing it on.

test('why refuses a hash that is not a fingerprint and exits 1', () => {
  for (const bad of ['nope', '../../victim', '', 'ABCDEF0123456789', 'abcdef012345678']) {
    out.length = 0
    expect(run(['why', bad, '--cwd', cwd])).toBe(1)
    expect(out.join('\n')).toContain('Not a fingerprint')
  }
})

test('forget refuses a hash that is not a fingerprint and exits 1', () => {
  upsertRecord(pathsFor(cwd), 'aa11bb22cc33dd44', seed)
  for (const bad of ['nope', '../../victim', 'ABCDEF0123456789']) {
    out.length = 0
    expect(run(['forget', bad, '--cwd', cwd])).toBe(1)
    expect(out.join('\n')).toContain('Not a fingerprint')
  }
  out.length = 0
  expect(run(['list', '--cwd', cwd])).toBe(0)
  expect(out.join('\n')).toContain('bun test')
})

test('forget removes one record', () => {
  upsertRecord(pathsFor(cwd), 'aa11bb22cc33dd44', seed)
  expect(run(['forget', 'aa11bb22cc33dd44', '--cwd', cwd])).toBe(0)
  out.length = 0
  expect(run(['list', '--cwd', cwd])).toBe(0)
  expect(out.join('\n')).toContain('No remembered failures')
})

test('forget with no hash and no --all exits 1', () => {
  expect(run(['forget', '--cwd', cwd])).toBe(1)
  expect(out.join('\n')).toContain('Pass a hash, or --all')
})

test('forget --all empties the index', () => {
  upsertRecord(pathsFor(cwd), 'aa11bb22cc33dd44', seed)
  upsertRecord(pathsFor(cwd), 'bb11bb22cc33dd44', seed)
  expect(run(['forget', '--all', '--cwd', cwd])).toBe(0)
  expect(out.join('\n')).toContain('Forgot 2')
})

test('stats reports the false-positive rate and boundary shares', () => {
  const p = pathsFor(cwd)
  appendStat(p, { kind: 'warned', hash: 'a', boundary: 'compaction' })
  appendStat(p, { kind: 'warned', hash: 'b', boundary: 'same_context' })
  appendStat(p, { kind: 'confirmed', hash: 'a' })
  appendStat(p, { kind: 'false_positive', hash: 'b' })
  expect(run(['stats', '--cwd', cwd])).toBe(0)
  const text = out.join('\n')
  expect(text).toContain('2 warnings')
  expect(text).toContain('50.0%')
  expect(text).toContain('compaction')
})

test('stats on an empty log exits 0 and says nothing has been measured', () => {
  expect(run(['stats', '--cwd', cwd])).toBe(0)
  expect(out.join('\n')).toContain('No warnings recorded')
})

test('export emits parseable JSON', () => {
  upsertRecord(pathsFor(cwd), 'aa11bb22cc33dd44', seed)
  expect(run(['export', '--cwd', cwd])).toBe(0)
  const parsed = JSON.parse(out.join('\n'))
  expect(parsed.records).toHaveLength(1)
  expect(parsed.records[0].hash).toBe('aa11bb22cc33dd44')
})

test('no arguments prints usage and exits 1', () => {
  expect(run([])).toBe(1)
  expect(out.join('\n')).toContain('Usage')
})

test('an unknown subcommand prints usage and exits 1', () => {
  expect(run(['nonsense'])).toBe(1)
})

// The brief's argv handling computed `cwdFlag + 1` even when `--cwd` was absent
// (cwdFlag === -1, so cwdFlag + 1 === 0), which filtered out argv[0] -- the
// subcommand itself -- whenever --cwd was not passed. These tests exercise that
// path directly, without --cwd, against the real process.cwd() (this repo). The
// index there will simply be empty, so assertions are on exit code and on the
// absence of "Usage" rather than on specific record contents.

test('list without --cwd runs the list command, not usage', () => {
  expect(run(['list'])).toBe(0)
  expect(out.join('\n')).not.toContain('Usage')
})

test('stats without --cwd runs the stats command, not usage', () => {
  expect(run(['stats'])).toBe(0)
  expect(out.join('\n')).not.toContain('Usage')
})

test('export without --cwd emits parseable JSON, not usage', () => {
  expect(run(['export'])).toBe(0)
  const text = out.join('\n')
  expect(text).not.toContain('Usage')
  expect(() => JSON.parse(text)).not.toThrow()
})
