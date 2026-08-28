import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { bumpCompactions, compactionCount } from '../src/session'
import { dataRoot, findRepoRoot, isFingerprint, pathsFor, pendingPath, projectSlug, recordPath, safeSegment } from '../src/paths'

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cass-paths-'))
  process.env.CASSANDRA_HOME = join(tmp, 'home')
})

afterEach(() => {
  delete process.env.CASSANDRA_HOME
  rmSync(tmp, { recursive: true, force: true })
})

test('dataRoot honours CASSANDRA_HOME first', () => {
  expect(dataRoot()).toBe(join(tmp, 'home'))
})

test('findRepoRoot walks up to the directory containing .git', () => {
  const repo = join(tmp, 'repo')
  const deep = join(repo, 'a', 'b')
  mkdirSync(join(repo, '.git'), { recursive: true })
  mkdirSync(deep, { recursive: true })
  expect(findRepoRoot(deep)).toBe(repo)
})

test('findRepoRoot returns cwd when there is no .git above it', () => {
  const plain = join(tmp, 'plain')
  mkdirSync(plain, { recursive: true })
  expect(findRepoRoot(plain)).toBe(plain)
})

test('a subdirectory of a repo yields the same slug as its root', () => {
  const repo = join(tmp, 'repo')
  const deep = join(repo, 'a', 'b')
  mkdirSync(join(repo, '.git'), { recursive: true })
  mkdirSync(deep, { recursive: true })
  expect(projectSlug(deep)).toBe(projectSlug(repo))
})

test('two checkouts with the same basename get different slugs', () => {
  const one = join(tmp, 'x', 'proj')
  const two = join(tmp, 'y', 'proj')
  mkdirSync(join(one, '.git'), { recursive: true })
  mkdirSync(join(two, '.git'), { recursive: true })
  expect(projectSlug(one)).not.toBe(projectSlug(two))
  expect(projectSlug(one).startsWith('proj-')).toBe(true)
})

test('recordPath shards on the first two hash characters', () => {
  const p = pathsFor(tmp)
  expect(recordPath(p, 'abcdef0123456789')).toBe(join(p.records, 'ab', 'abcdef0123456789.json'))
})

test('pendingPath never escapes the pending directory', () => {
  const p = pathsFor(tmp)
  for (const id of ['..', '.', '', '../../etc/passwd', 'toolu_01ABC']) {
    expect(pendingPath(p, id).startsWith(p.pending + '/')).toBe(true)
  }
})

// Every path segment Cassandra derives comes from outside this process: hook payloads,
// CLI argv, or a filename already on disk. `recordPath` in particular feeds `readRecord`,
// which DELETES what it cannot parse, so a segment that escaped its directory would be an
// arbitrary-file delete. These assert containment for each of the three derived segments.

const HOSTILE_SEGMENTS = ['..', '../../x', '../../../../etc/passwd', '.', '', 'x'.repeat(500), '/abs/path', 'a/b']

test('recordPath keeps every hostile hash inside the records directory', () => {
  const p = pathsFor(tmp)
  for (const hash of HOSTILE_SEGMENTS) {
    const resolved = resolve(recordPath(p, hash))
    expect(resolved.startsWith(resolve(p.records) + '/')).toBe(true)
    // One shard level and no more: the segment cannot have grown a separator.
    expect(dirname(dirname(resolved))).toBe(resolve(p.records))
  }
})

test('recordPath accepts only a real fingerprint and files everything else under one fixed name', () => {
  const p = pathsFor(tmp)
  expect(recordPath(p, 'abcdef0123456789')).toBe(join(p.records, 'ab', 'abcdef0123456789.json'))
  for (const hash of ['ABCDEF0123456789', 'abcdef012345678', 'abcdef01234567890', 'zzzzzzzzzzzzzzzz', '../../victim']) {
    expect(recordPath(p, hash)).toBe(join(p.records, 'in', 'invalid.json'))
  }
})

test('pendingPath keeps every hostile tool_use_id inside the pending directory', () => {
  const p = pathsFor(tmp)
  for (const id of HOSTILE_SEGMENTS) {
    const resolved = resolve(pendingPath(p, id))
    expect(resolved.startsWith(resolve(p.pending) + '/')).toBe(true)
    // A direct child, so `resolve` had no `..` or separator left to act on.
    expect(dirname(resolved)).toBe(resolve(p.pending))
  }
})

test('counterPath keeps every hostile session id inside the sessions directory', () => {
  // counterPath is private to src/session.ts, so it is exercised through the two
  // functions that use it: a hostile id must write and read inside sessions/ and nowhere else.
  const p = pathsFor(tmp)
  const sessions = join(p.root, 'sessions')
  for (const id of HOSTILE_SEGMENTS.filter((s) => s !== '')) {
    bumpCompactions(p, id)
    expect(compactionCount(p, id)).toBeGreaterThan(0)
  }
  // Everything written landed as a direct child of sessions/, so nothing escaped.
  const written = readdirSync(sessions)
  expect(written.length).toBeGreaterThan(0)
  for (const name of written) {
    expect(name.includes('/')).toBe(false)
    expect(name).not.toBe('..')
    expect(name).not.toBe('.')
    expect(existsSync(join(sessions, name))).toBe(true)
  }
  expect(existsSync(join(p.root, 'passwd'))).toBe(false)
  expect(existsSync(join(dataRoot(), 'passwd'))).toBe(false)
})

test('safeSegment strips separators, caps length and refuses the three escaping names', () => {
  // Dots survive, since a dot is legal in a filename. Separators do not, which is what
  // makes the result a single segment that `resolve` cannot walk out of.
  expect(safeSegment('../../etc/passwd')).toBe('..-..-etc-passwd')
  expect(safeSegment('../../etc/passwd').includes('/')).toBe(false)
  expect(safeSegment('..')).toBe('unknown')
  expect(safeSegment('.')).toBe('unknown')
  expect(safeSegment('')).toBe('unknown')
  expect(safeSegment('..', 'invalid')).toBe('invalid')
  expect(safeSegment('x'.repeat(500)).length).toBe(120)
  expect(safeSegment('toolu_01ABC')).toBe('toolu_01ABC')
})

test('isFingerprint accepts exactly 16 lowercase hex characters', () => {
  expect(isFingerprint('abcdef0123456789')).toBe(true)
  expect(isFingerprint('ABCDEF0123456789')).toBe(false)
  expect(isFingerprint('abcdef012345678')).toBe(false)
  expect(isFingerprint('abcdef01234567890')).toBe(false)
  expect(isFingerprint('')).toBe(false)
  expect(isFingerprint('../../victim')).toBe(false)
})
