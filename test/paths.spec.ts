import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { bumpCompactions, compactionCount } from '../src/core/session.ts'
import { nodeIo } from '../src/io/node.ts'
import { dataRoot, findRepoRoot, isFingerprint, pathsFor, pendingDir, pendingPath, projectSlug, recordPath, safeSegment } from '../src/core/paths.ts'

let tmp: string
let originalHome: string | undefined

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'cass-paths-'))
  originalHome = process.env.HOME
  process.env.CASSANDRA_HOME = join(tmp, 'home')
})

afterEach(async () => {
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  delete process.env.CLAUDE_PLUGIN_DATA
  delete process.env.CASSANDRA_HOME
  rmSync(tmp, { recursive: true, force: true })
})

test('dataRoot honours CASSANDRA_HOME first', async () => {
  expect(await dataRoot(nodeIo)).toBe(join(tmp, 'home'))
})

test('findRepoRoot walks up to the directory containing .git', async () => {
  const repo = join(tmp, 'repo')
  const deep = join(repo, 'a', 'b')
  mkdirSync(join(repo, '.git'), { recursive: true })
  writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  mkdirSync(deep, { recursive: true })
  expect(await findRepoRoot(nodeIo, deep)).toBe(repo)
})

test('findRepoRoot ignores an empty .git directory in an ancestor', async () => {
  const outer = join(tmp, 'outer')
  const deep = join(outer, 'a')
  mkdirSync(join(outer, '.git'), { recursive: true })
  mkdirSync(deep, { recursive: true })
  expect(await findRepoRoot(nodeIo, deep)).toBe(deep)
})

test('findRepoRoot accepts a .git directory with HEAD and a .git file', async () => {
  const real = join(tmp, 'real')
  mkdirSync(join(real, '.git'), { recursive: true })
  writeFileSync(join(real, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  mkdirSync(join(real, 'x'), { recursive: true })
  expect(await findRepoRoot(nodeIo, join(real, 'x'))).toBe(real)
  const wt = join(tmp, 'wt')
  mkdirSync(join(wt, 'y'), { recursive: true })
  writeFileSync(join(wt, '.git'), 'gitdir: /somewhere/.git/worktrees/wt\n')
  expect(await findRepoRoot(nodeIo, join(wt, 'y'))).toBe(wt)
})

test('findRepoRoot returns cwd when there is no .git above it', async () => {
  const plain = join(tmp, 'plain')
  mkdirSync(plain, { recursive: true })
  expect(await findRepoRoot(nodeIo, plain)).toBe(plain)
})

test('a subdirectory of a repo yields the same slug as its root', async () => {
  const repo = join(tmp, 'repo')
  const deep = join(repo, 'a', 'b')
  mkdirSync(join(repo, '.git'), { recursive: true })
  writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  mkdirSync(deep, { recursive: true })
  expect(await projectSlug(nodeIo, deep)).toBe(await projectSlug(nodeIo, repo))
})

test('two checkouts with the same basename get different slugs', async () => {
  const one = join(tmp, 'x', 'proj')
  const two = join(tmp, 'y', 'proj')
  mkdirSync(join(one, '.git'), { recursive: true })
  writeFileSync(join(one, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  mkdirSync(join(two, '.git'), { recursive: true })
  writeFileSync(join(two, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  expect(await projectSlug(nodeIo, one)).not.toBe(await projectSlug(nodeIo, two))
  expect((await projectSlug(nodeIo, one)).startsWith('proj-')).toBe(true)
})

test('recordPath shards on the first two hash characters', async () => {
  const p = await pathsFor(nodeIo, tmp)
  expect(recordPath(p, 'abcdef0123456789')).toBe(join(p.records, 'ab', 'abcdef0123456789.json'))
})

test('pendingPath never escapes the pending directory', async () => {
  const dir = await pendingDir(nodeIo)
  for (const id of ['..', '.', '', '../../etc/passwd', 'toolu_01ABC']) {
    expect(pendingPath(dir, id).startsWith(dir + '/')).toBe(true)
  }
})

// Every path segment Cassandra derives comes from outside this process: hook payloads,
// CLI argv, or a filename already on disk. `recordPath` in particular feeds `readRecord`,
// which DELETES what it cannot parse, so a segment that escaped its directory would be an
// arbitrary-file delete. These assert containment for each of the three derived segments.

const HOSTILE_SEGMENTS = ['..', '../../x', '../../../../etc/passwd', '.', '', 'x'.repeat(500), '/abs/path', 'a/b']

test('recordPath keeps every hostile hash inside the records directory', async () => {
  const p = await pathsFor(nodeIo, tmp)
  for (const hash of HOSTILE_SEGMENTS) {
    const resolved = resolve(recordPath(p, hash))
    expect(resolved.startsWith(resolve(p.records) + '/')).toBe(true)
    // One shard level and no more: the segment cannot have grown a separator.
    expect(dirname(dirname(resolved))).toBe(resolve(p.records))
  }
})

test('recordPath accepts only a real fingerprint and files everything else under one fixed name', async () => {
  const p = await pathsFor(nodeIo, tmp)
  expect(recordPath(p, 'abcdef0123456789')).toBe(join(p.records, 'ab', 'abcdef0123456789.json'))
  for (const hash of ['ABCDEF0123456789', 'abcdef012345678', 'abcdef01234567890', 'zzzzzzzzzzzzzzzz', '../../victim']) {
    expect(recordPath(p, hash)).toBe(join(p.records, 'in', 'invalid.json'))
  }
})

test('pendingPath keeps every hostile tool_use_id inside the pending directory', async () => {
  const dir = await pendingDir(nodeIo)
  for (const id of HOSTILE_SEGMENTS) {
    const resolved = resolve(pendingPath(dir, id))
    expect(resolved.startsWith(resolve(dir) + '/')).toBe(true)
    // A direct child, so `resolve` had no `..` or separator left to act on.
    expect(dirname(resolved)).toBe(resolve(dir))
  }
})

test('counterPath keeps every hostile session id inside the sessions directory', async () => {
  // counterPath is private to src/core/session.ts, so it is exercised through the two
  // functions that use it: a hostile id must write and read inside sessions/ and nowhere else.
  const p = await pathsFor(nodeIo, tmp)
  const sessions = join(p.root, 'sessions')
  for (const id of HOSTILE_SEGMENTS.filter((s) => s !== '')) {
    await bumpCompactions(nodeIo, p, id)
    expect(await compactionCount(nodeIo, p, id)).toBeGreaterThan(0)
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
  expect(existsSync(join(await dataRoot(nodeIo), 'passwd'))).toBe(false)
})

test('safeSegment strips separators, caps length and refuses the three escaping names', async () => {
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

test('isFingerprint accepts exactly 16 lowercase hex characters', async () => {
  expect(isFingerprint('abcdef0123456789')).toBe(true)
  expect(isFingerprint('ABCDEF0123456789')).toBe(false)
  expect(isFingerprint('abcdef012345678')).toBe(false)
  expect(isFingerprint('abcdef01234567890')).toBe(false)
  expect(isFingerprint('')).toBe(false)
  expect(isFingerprint('../../victim')).toBe(false)
})

test('a hook writing under CLAUDE_PLUGIN_DATA leaves a pointer the CLI can follow', async () => {
  const pluginData = join(tmp, 'plugin-data')
  mkdirSync(pluginData, { recursive: true })
  const home = join(tmp, 'fakehome')
  mkdirSync(join(home, '.cassandra'), { recursive: true })

  // The hook's environment: CLAUDE_PLUGIN_DATA set, CASSANDRA_HOME absent.
  delete process.env.CASSANDRA_HOME
  process.env.CLAUDE_PLUGIN_DATA = pluginData
  process.env.HOME = home
  expect(await dataRoot(nodeIo)).toBe(pluginData)

  // A plain shell: no plugin environment at all. It must still find the same directory.
  delete process.env.CLAUDE_PLUGIN_DATA
  expect(await dataRoot(nodeIo)).toBe(pluginData)
})

test('a stale or non-absolute pointer is ignored rather than followed', async () => {
  const home = join(tmp, 'fakehome2')
  mkdirSync(join(home, '.cassandra'), { recursive: true })
  process.env.HOME = home
  delete process.env.CASSANDRA_HOME
  delete process.env.CLAUDE_PLUGIN_DATA

  writeFileSync(join(home, '.cassandra', 'data-root'), '/nonexistent/gone')
  expect(await dataRoot(nodeIo)).toBe(join(home, '.cassandra'))

  writeFileSync(join(home, '.cassandra', 'data-root'), 'not-absolute')
  expect(await dataRoot(nodeIo)).toBe(join(home, '.cassandra'))
})

test('the mod session marker is written, seen, and cleared', async () => {
  const { markModSession, isModSession, clearModSession } = await import('../src/core/session.ts')
  expect(await isModSession(nodeIo, 's-1')).toBe(false)
  expect(await markModSession(nodeIo, 's-1')).toBe(true)
  expect(await isModSession(nodeIo, 's-1')).toBe(true)
  expect(existsSync(join(tmp, 'home', 'sessions', 's-1.mod'))).toBe(true)
  await clearModSession(nodeIo, 's-1')
  expect(await isModSession(nodeIo, 's-1')).toBe(false)
})

test('a hostile session id cannot place a marker outside the sessions directory', async () => {
  const { markModSession } = await import('../src/core/session.ts')
  await markModSession(nodeIo, '../../escape')
  expect(readdirSync(join(tmp, 'home', 'sessions'))).toEqual(['..-..-escape.mod'])
})

test('an empty session id is never a mod session', async () => {
  const { markModSession, isModSession } = await import('../src/core/session.ts')
  expect(await markModSession(nodeIo, '')).toBe(false)
  expect(await isModSession(nodeIo, '')).toBe(false)
})

test('a mod that cannot see CLAUDE_PLUGIN_DATA follows the pointer the binary left', async () => {
  const { modIo } = await import('../src/io/mod.ts')
  const { nodeHost } = await import('./support/node-host.ts')
  const home = join(tmp, 'h')
  const pluginData = join(tmp, 'plugin-data')
  mkdirSync(pluginData, { recursive: true })
  delete process.env.CASSANDRA_HOME
  process.env.HOME = home
  process.env.CLAUDE_PLUGIN_DATA = pluginData
  expect(await dataRoot(nodeIo)).toBe(pluginData)
  const mod = modIo(nodeHost({ env: { HOME: home } }))
  expect(await dataRoot(mod)).toBe(pluginData)
})

test('a mod with neither an explicit root nor HOME cannot resolve a data root and says so by rejecting', async () => {
  const { modIo } = await import('../src/io/mod.ts')
  const { nodeHost } = await import('./support/node-host.ts')
  await expect(dataRoot(modIo(nodeHost({ env: {} })))).rejects.toThrow('no home directory')
})
