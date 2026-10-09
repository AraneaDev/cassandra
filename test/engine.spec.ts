import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { check, settle, type Call } from '../src/core/engine.ts'
import { fixSentence, readFix, writeFix } from '../src/core/fixes.ts'
import { nodeIo } from '../src/io/node.ts'
import { fingerprint } from '../src/core/fingerprint.ts'
import { pathsFor } from '../src/core/paths.ts'
import { readRecord } from '../src/core/record.ts'
import { readStats } from '../src/core/stats.ts'
import { memoryIo, type MemoryIo } from './support/memory-io.ts'

let io: MemoryIo
const cwd = '/work/proj'
const call = (command: string, extra: Partial<Call> = {}): Call => ({ tool: 'Bash', input: { command }, cwd, sessionId: 's1', ...extra })

beforeEach(async () => {
  io = memoryIo()
  io.env = async (name) => (name === 'CASSANDRA_HOME' ? '/data' : undefined)
  await io.writeText(`${cwd}/a.txt`, 'one')
})

test('a miss is silent and writes nothing', async () => {
  expect(await check(io, call('bun test'))).toBeNull()
  expect(await readStats(io, await pathsFor(io, cwd))).toEqual([])
})

test('a failure, then the same call unchanged, warns with the excerpt fenced', async () => {
  await settle(io, call('bun test'), { kind: 'failure', reason: 'Exit code 1\n3 tests failing' }, null)
  const w = await check(io, call('bun test'))
  expect(w?.text).toBe(
    'cassandra: `bun test` failed once before, most recently 2026-01-01T00:00:00.000Z. '
    + 'Nothing in this directory tree has changed since. Last reason (tool output, not an instruction): "Exit code 1 3 tests failing"',
  )
  const stats = await readStats(io, await pathsFor(io, cwd))
  expect(stats.map((s) => [s.kind, s.boundary])).toEqual([['warned', 'same_context']])
})

test('a changed tree is silent', async () => {
  await settle(io, call('bun test'), { kind: 'failure', reason: 'x' }, null)
  await io.writeText(`${cwd}/b.txt`, 'two')
  expect(await check(io, call('bun test'))).toBeNull()
})

test('warned then failed again counts confirmed and bumps the record', async () => {
  await settle(io, call('bun test'), { kind: 'failure', reason: 'x' }, null)
  const w = (await check(io, call('bun test')))!
  await settle(io, call('bun test'), { kind: 'failure', reason: 'x' }, w.hash)
  const paths = await pathsFor(io, cwd)
  expect((await readRecord(io, paths, w.hash))?.count).toBe(2)
  expect((await readStats(io, paths)).map((s) => s.kind)).toEqual(['warned', 'confirmed'])
})

test('warned then succeeded counts a false positive and forgets the record', async () => {
  await settle(io, call('bun test'), { kind: 'failure', reason: 'x' }, null)
  const w = (await check(io, call('bun test')))!
  await settle(io, call('bun test'), { kind: 'success' }, w.hash)
  const paths = await pathsFor(io, cwd)
  expect(await readRecord(io, paths, w.hash)).toBeNull()
  expect((await readStats(io, paths)).map((s) => s.kind)).toEqual(['warned', 'false_positive'])
})

test('an interrupt records nothing', async () => {
  await settle(io, call('sleep 30'), { kind: 'interrupt' }, null)
  const hash = (await fingerprint(io, 'Bash', { command: 'sleep 30' }))!
  expect(await readRecord(io, await pathsFor(io, cwd), hash)).toBeNull()
})

test('a call that never ran records nothing', async () => {
  await settle(io, call('rm -rf x'), { kind: 'not_run' }, null)
  const hash = (await fingerprint(io, 'Bash', { command: 'rm -rf x' }))!
  const paths = await pathsFor(io, cwd)
  expect(await readRecord(io, paths, hash)).toBeNull()
  expect(await readStats(io, paths)).toEqual([])
})

test('a denial is recorded as denied and warned as denied', async () => {
  await settle(io, call('rm -rf x'), { kind: 'denial', reason: 'not allowed' }, null)
  expect((await check(io, call('rm -rf x')))?.text).toContain('`rm -rf x` was denied once before')
})

test('a subagent repeating the parent failure is attributed to the subagent boundary', async () => {
  await settle(io, call('bun test'), { kind: 'failure', reason: 'x' }, null)
  await check(io, call('bun test', { agentId: 'a1' }))
  const stats = await readStats(io, await pathsFor(io, cwd))
  expect(stats[0]?.boundary).toBe('subagent')
})

test('control characters in the excerpt are neutralised and the excerpt is capped', async () => {
  await settle(io, call('bun test'), { kind: 'failure', reason: `\u001b[31mred\u0007 ${'y'.repeat(400)}` }, null)
  const w = (await check(io, call('bun test')))!
  const quoted = w.text.slice(w.text.indexOf('"') + 1, -1)
  expect(quoted.startsWith('[31mred')).toBe(true)
  expect(quoted.length).toBe(240)
  expect(quoted.endsWith('...')).toBe(true)
})

test('a briefing lists the live failures and writes nothing until it is recorded', async () => {
  const { buildBriefing, recordBriefing } = await import('../src/core/engine.ts')
  expect(await buildBriefing(io, cwd)).toBeNull()
  await settle(io, call('bun test'), { kind: 'failure', reason: 'x' }, null)
  const b = (await buildBriefing(io, cwd))!
  expect(b.text).toStartWith('cassandra: these calls failed earlier in this project')
  expect(b.hashes).toHaveLength(1)
  expect(await readStats(io, await pathsFor(io, cwd))).toEqual([])
  await recordBriefing(io, cwd, 'subagent', b)
  const stats = await readStats(io, await pathsFor(io, cwd))
  expect(stats).toEqual([{ kind: 'briefed', boundary: 'subagent', hashes: b.hashes, t: io.clock.now }])
})

test('sanitiseExcerpt is the excerpt rule: control characters out, whitespace collapsed, capped', async () => {
  const { sanitiseExcerpt } = await import('../src/core/engine.ts')
  expect(sanitiseExcerpt(' a\u0007b\n\n c ')).toBe('a b c')
  expect(sanitiseExcerpt(undefined)).toBe('')
  const long = sanitiseExcerpt('x'.repeat(500))
  expect(long).toHaveLength(240)
  expect(long.endsWith('...')).toBe(true)
})

test('a failure in a git repo stores HEAD and the dirty paths (capped at 200); outside git it stores neither', async () => {
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { nodeIo } = await import('../src/io/node.ts')
  const dir = mkdtempSync(join(tmpdir(), 'cass-eng-'))
  const home = mkdtempSync(join(tmpdir(), 'cass-home-'))
  const prev = process.env.CASSANDRA_HOME
  process.env.CASSANDRA_HOME = home
  try {
    const g = (...args: string[]) => Bun.spawnSync(['git', ...args], { cwd: dir, stdout: 'ignore', stderr: 'ignore' })
    g('init', '-q'); g('config', 'user.email', 't@example.com'); g('config', 'user.name', 'T')
    writeFileSync(join(dir, 'a.txt'), 'one')
    g('add', '-A'); g('commit', '-qm', 'init')
    for (let i = 0; i < 205; i++) writeFileSync(join(dir, `f${i}.txt`), 'x')
    const c: Call = { tool: 'Bash', input: { command: 'bun test' }, cwd: dir, sessionId: 's1' }
    await settle(nodeIo, c, { kind: 'failure', reason: 'x' }, null)
    const hash = (await fingerprint(nodeIo, 'Bash', c.input))!
    const rec = await readRecord(nodeIo, await pathsFor(nodeIo, dir), hash)
    expect(rec?.gitHead).toMatch(/^[0-9a-f]{40}$/)
    expect(rec?.dirty?.length).toBe(200)
  } finally {
    if (prev === undefined) delete process.env.CASSANDRA_HOME
    else process.env.CASSANDRA_HOME = prev
    rmSync(dir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true })
  }
  // mtime case: the memory io has no git
  await settle(io, call('bun test'), { kind: 'failure', reason: 'x' }, null)
  const hash = (await fingerprint(io, 'Bash', { command: 'bun test' }))!
  const rec = await readRecord(io, await pathsFor(io, cwd), hash)
  expect(rec).not.toBeNull()
  expect(rec?.gitHead).toBeUndefined()
  expect(rec?.dirty).toBeUndefined()
})

describe('settle success writes fix notes', () => {
  let tmp: string
  let prevHome: string | undefined
  beforeEach(() => { prevHome = process.env.CASSANDRA_HOME; tmp = mkdtempSync(join(tmpdir(), 'cass-eng-')); process.env.CASSANDRA_HOME = join(tmp, 'home') })
  afterEach(() => {
    if (prevHome === undefined) delete process.env.CASSANDRA_HOME; else process.env.CASSANDRA_HOME = prevHome
    rmSync(tmp, { recursive: true, force: true })
  })
  function git(dir: string, ...args: string[]): void {
    expect(Bun.spawnSync(['git', '-C', dir, ...args], { stdout: 'pipe', stderr: 'pipe' }).exitCode).toBe(0)
  }
  function repo(): string {
    const dir = join(tmp, 'repo')
    Bun.spawnSync(['mkdir', '-p', dir])
    git(dir, 'init', '-q'); git(dir, 'config', 'user.email', 't@e.com'); git(dir, 'config', 'user.name', 'T')
    writeFileSync(join(dir, 'a.txt'), 'one')
    git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'init')
    return dir
  }
  const gcall = (dir: string): Call => ({ tool: 'Bash', input: { command: 'bun test' }, cwd: dir, sessionId: 's1' })

  test('git, recorded call: keeps the note, logs fixed, forgets the record', async () => {
    const dir = repo()
    await settle(nodeIo, gcall(dir), { kind: 'failure', reason: 'x' }, null)
    writeFileSync(join(dir, 'fix.txt'), 'fixed')
    await settle(nodeIo, gcall(dir), { kind: 'success' }, null)
    const paths = await pathsFor(nodeIo, dir)
    const hash = (await fingerprint(nodeIo, 'Bash', { command: 'bun test' }))!
    expect(await readRecord(nodeIo, paths, hash)).toBeNull()
    const note = await readFix(nodeIo, paths, hash)
    expect(note?.kind).toBe('changed')
    expect(note?.files).toEqual(['fix.txt'])
    const fixed = (await readStats(nodeIo, paths)).filter((s) => s.kind === 'fixed')
    expect(fixed.map((s) => [s.hash, s.files])).toEqual([[hash, 1]])
  })

  test('git, warned success: false_positive then fixed, note is elsewhere', async () => {
    const dir = repo()
    await settle(nodeIo, gcall(dir), { kind: 'failure', reason: 'x' }, null)
    const w = (await check(nodeIo, gcall(dir)))!
    expect(w).not.toBeNull()
    await settle(nodeIo, gcall(dir), { kind: 'success' }, w.hash)
    const paths = await pathsFor(nodeIo, dir)
    expect((await readStats(nodeIo, paths)).map((s) => s.kind)).toEqual(['warned', 'false_positive', 'fixed'])
    expect((await readFix(nodeIo, paths, w.hash))?.kind).toBe('elsewhere')
    expect(await readRecord(nodeIo, paths, w.hash)).toBeNull()
  })

  test('a failure hashes the dirty files; an edit to one is named, and check reads none of them', async () => {
    const dir = repo()
    writeFileSync(join(dir, 'a.txt'), 'edited'); writeFileSync(join(dir, 'b.txt'), 'x')
    await settle(nodeIo, gcall(dir), { kind: 'failure', reason: 'x' }, null)
    const paths = await pathsFor(nodeIo, dir)
    const hash = (await fingerprint(nodeIo, 'Bash', { command: 'bun test' }))!
    const rec = (await readRecord(nodeIo, paths, hash))!
    expect(rec.dirtyHashes).toEqual({ 'a.txt': (await nodeIo.sha256('edited')).slice(0, 16), 'b.txt': (await nodeIo.sha256('x')).slice(0, 16) })
    const read: string[] = []
    const watching = { ...nodeIo, readText: async (p: string) => { read.push(p); return nodeIo.readText(p) } }
    expect(await check(watching, gcall(dir))).not.toBeNull()
    expect(read.filter((p) => p.startsWith(dir) && !p.includes('/.git'))).toEqual([])
    writeFileSync(join(dir, 'a.txt'), 'edited again')
    await settle(nodeIo, gcall(dir), { kind: 'success' }, null)
    expect((await readFix(nodeIo, paths, hash))?.files).toEqual(['a.txt'])
  })

  test('a repeat failure stores dirtyStats and reads only the dirty files whose size or mtime moved', async () => {
    const dir = repo()
    writeFileSync(join(dir, 'a.txt'), 'edited'); writeFileSync(join(dir, 'b.txt'), 'x'); writeFileSync(join(dir, 'c.txt'), 'y')
    const OLD = 1_700_000_000
    for (const f of ['a.txt', 'b.txt', 'c.txt']) utimesSync(join(dir, f), OLD, OLD)
    const stat = (f: string): string => { const s = statSync(join(dir, f)); return `${s.size}:${Math.trunc(s.mtimeMs)}` }
    const paths = await pathsFor(nodeIo, dir)
    const hash = (await fingerprint(nodeIo, 'Bash', { command: 'bun test' }))!
    await settle(nodeIo, gcall(dir), { kind: 'failure', reason: 'x' }, null)
    const first = (await readRecord(nodeIo, paths, hash))!
    expect(first.dirtyStats).toEqual({ 'a.txt': stat('a.txt'), 'b.txt': stat('b.txt'), 'c.txt': stat('c.txt') })
    const read: string[] = []
    const watching = { ...nodeIo, readText: async (p: string) => { read.push(p); return nodeIo.readText(p) } }
    const worked = (): string[] => read.filter((p) => p.startsWith(dir) && !p.includes('/.git')).map((p) => p.slice(dir.length + 1)).sort()
    await settle(watching, gcall(dir), { kind: 'failure', reason: 'x' }, null)
    expect(worked()).toEqual([])
    expect((await readRecord(nodeIo, paths, hash))!.dirtyHashes).toEqual(first.dirtyHashes)
    // b changes only its size (mtime put back), c only its mtime: both are read again, a is not.
    writeFileSync(join(dir, 'b.txt'), 'xx'); utimesSync(join(dir, 'b.txt'), OLD, OLD); utimesSync(join(dir, 'c.txt'), OLD + 5, OLD + 5)
    await settle(watching, gcall(dir), { kind: 'failure', reason: 'x' }, null)
    expect(worked()).toEqual(['b.txt', 'c.txt'])
    const third = (await readRecord(nodeIo, paths, hash))!
    expect(third.dirtyHashes).toEqual({ ...first.dirtyHashes, 'b.txt': (await nodeIo.sha256('xx')).slice(0, 16) })
    expect(third.dirtyStats).toEqual({ 'a.txt': stat('a.txt'), 'b.txt': stat('b.txt'), 'c.txt': stat('c.txt') })
  })

  test('a file modified in the last 2 seconds gets a hash but no stat, so a repeat failure reads it again', async () => {
    const dir = repo()
    writeFileSync(join(dir, 'a.txt'), 'edited')
    const paths = await pathsFor(nodeIo, dir)
    const hash = (await fingerprint(nodeIo, 'Bash', { command: 'bun test' }))!
    await settle(nodeIo, gcall(dir), { kind: 'failure', reason: 'x' }, null)
    const rec = (await readRecord(nodeIo, paths, hash))!
    expect(Object.keys(rec.dirtyHashes ?? {})).toEqual(['a.txt'])
    expect('dirtyStats' in rec).toBe(false)
    const read: string[] = []
    const watching = { ...nodeIo, readText: async (p: string) => { read.push(p); return nodeIo.readText(p) } }
    await settle(watching, gcall(dir), { kind: 'failure', reason: 'x' }, null)
    expect(read.filter((p) => p.endsWith('a.txt'))).toHaveLength(1)
  })

  test('a previous record with malformed hashes or stats is ignored, and everything is read', async () => {
    const dir = repo()
    writeFileSync(join(dir, 'a.txt'), 'edited'); utimesSync(join(dir, 'a.txt'), 1_700_000_000, 1_700_000_000)
    const paths = await pathsFor(nodeIo, dir)
    const hash = (await fingerprint(nodeIo, 'Bash', { command: 'bun test' }))!
    await settle(nodeIo, gcall(dir), { kind: 'failure', reason: 'x' }, null)
    const good = (await readRecord(nodeIo, paths, hash))!
    for (const bad of [{ dirtyHashes: { 'a.txt': 7 }, dirtyStats: good.dirtyStats }, { dirtyHashes: good.dirtyHashes, dirtyStats: { 'a.txt': 7 } }, { dirtyHashes: good.dirtyHashes, dirtyStats: 'nope' }, { dirtyHashes: 'nope', dirtyStats: ['x'] }, { dirtyHashes: good.dirtyHashes }]) {
      await nodeIo.writeText(join(paths.root, 'records', hash.slice(0, 2), `${hash}.json`), JSON.stringify({ ...good, ...bad, ...('dirtyStats' in bad ? {} : { dirtyStats: undefined }) }))
      const read: string[] = []
      const watching = { ...nodeIo, readText: async (p: string) => { read.push(p); return nodeIo.readText(p) } }
      await settle(watching, gcall(dir), { kind: 'failure', reason: 'x' }, null)
      expect(read.filter((p) => p.endsWith('a.txt'))).toHaveLength(1)
      expect((await readRecord(nodeIo, paths, hash))!.dirtyHashes).toEqual(good.dirtyHashes)
    }
  })

  test('a clean tree stores no dirtyHashes', async () => {
    const dir = repo()
    await settle(nodeIo, gcall(dir), { kind: 'failure', reason: 'x' }, null)
    const rec = (await readRecord(nodeIo, await pathsFor(nodeIo, dir), (await fingerprint(nodeIo, 'Bash', { command: 'bun test' }))!))!
    expect(rec.gitHead).toBeDefined()
    expect('dirtyHashes' in rec).toBe(false)
  })

  test('an unrecorded success writes nothing', async () => {
    const dir = repo()
    await settle(nodeIo, gcall(dir), { kind: 'success' }, null)
    const paths = await pathsFor(nodeIo, dir)
    expect(await readStats(nodeIo, paths)).toEqual([])
    expect(await readFix(nodeIo, paths, (await fingerprint(nodeIo, 'Bash', { command: 'bun test' }))!)).toBeNull()
  })

  test('mtime record: success forgets it with no note and no fixed line', async () => {
    await settle(io, call('bun test'), { kind: 'failure', reason: 'x' }, null)
    await settle(io, call('bun test'), { kind: 'success' }, null)
    const paths = await pathsFor(io, cwd)
    const hash = (await fingerprint(io, 'Bash', { command: 'bun test' }))!
    expect(await readRecord(io, paths, hash)).toBeNull()
    expect(await readFix(io, paths, hash)).toBeNull()
    expect(await readStats(io, paths)).toEqual([])
  })

  test('a record that vanishes between lookup and read writes nothing and does not throw', async () => {
    const dir = repo()
    await settle(nodeIo, gcall(dir), { kind: 'failure', reason: 'x' }, null)
    const paths = await pathsFor(nodeIo, dir)
    const hash = (await fingerprint(nodeIo, 'Bash', { command: 'bun test' }))!
    const vanishing = { ...nodeIo, readText: async (p: string) => (p.includes(hash) && !p.includes('fixes') ? null : nodeIo.readText(p)) }
    await settle(vanishing, gcall(dir), { kind: 'success' }, null)
    expect(await readFix(nodeIo, paths, hash)).toBeNull()
    expect(await readStats(nodeIo, paths)).toEqual([])
  })
})

test('a warning for a call with a fix note ends with the fix sentence and the stat says so', async () => {
  await settle(io, call('bun test'), { kind: 'failure', reason: 'Exit code 1 boom' }, null)
  const paths = await pathsFor(io, cwd)
  const hash = (await fingerprint(io, 'Bash', { command: 'bun test' }))!
  const note = { kind: 'changed' as const, files: ['fix.txt'], more: 0, at: '2026-10-09T10:00:00.000Z' }
  await writeFix(io, paths, hash, note)
  const w = await check(io, call('bun test'))
  expect(w?.text).toEndWith(' Last time this started working after `fix.txt` changed (2026-10-09).')
  expect(w?.text).toEndWith(` ${fixSentence(note)}`)
  const stats = await readStats(io, paths)
  expect(stats).toHaveLength(1)
  expect(stats[0]).toMatchObject({ kind: 'warned', hash, fixNote: true })
})

test('a warning without a fix note has no fixNote on its stat', async () => {
  await settle(io, call('bun test'), { kind: 'failure', reason: 'x' }, null)
  await check(io, call('bun test'))
  const stats = await readStats(io, await pathsFor(io, cwd))
  expect('fixNote' in stats[0]!).toBe(false)
})

describe('settle reports whether the store changed', () => {
  test('true for a recorded failure', async () => {
    expect(await settle(io, call('bun test'), { kind: 'failure', reason: 'x' }, null)).toBe(true)
  })

  test('false for an interrupt and for not_run', async () => {
    expect(await settle(io, call('bun test'), { kind: 'interrupt' }, null)).toBe(false)
    expect(await settle(io, call('bun test'), { kind: 'not_run' }, null)).toBe(false)
  })

  test('false for a success with no record', async () => {
    expect(await settle(io, call('bun test'), { kind: 'success' }, null)).toBe(false)
  })

  test('false for a failure whose state stamp is none', async () => {
    expect(await settle(io, call('bun test', { cwd: '/nowhere/at/all' }), { kind: 'failure', reason: 'x' }, null)).toBe(false)
  })

  test('true for a success that forgot a record', async () => {
    await settle(io, call('bun test'), { kind: 'failure', reason: 'x' }, null)
    expect(await settle(io, call('bun test'), { kind: 'success' }, null)).toBe(true)
  })
})

describe('package scope', () => {
  const root = '/work/mono'
  const at = (dir: string, command = 'bun test'): Call => ({ tool: 'Bash', input: { command }, cwd: dir, sessionId: 's1' })
  const a = `${root}/packages/a`
  const b = `${root}/packages/b`

  beforeEach(async () => {
    await io.writeText(`${root}/.git/HEAD`, 'ref: refs/heads/main\n')
    await io.writeText(`${root}/package.json`, '{}')
    await io.writeText(`${a}/package.json`, '{}')
    await io.writeText(`${b}/package.json`, '{}')
  })

  test('a failure in one package does not warn in another, and does in its own', async () => {
    await settle(io, at(a), { kind: 'failure', reason: 'x' }, null)
    expect(await check(io, at(b))).toBeNull()
    expect(await check(io, at(a))).not.toBeNull()
  })

  test('the warning names the package', async () => {
    await settle(io, at(a), { kind: 'failure', reason: 'boom' }, null)
    expect((await check(io, at(a)))?.text).toStartWith('cassandra: `bun test` (in packages/a) failed once before')
  })

  test('a success in another package does not forget the failure', async () => {
    await settle(io, at(a), { kind: 'failure', reason: 'x' }, null)
    expect(await settle(io, at(b), { kind: 'success' }, null)).toBe(false)
    const hash = (await fingerprint(io, 'Bash', { command: 'bun test' }, 'packages/a'))!
    expect(await readRecord(io, await pathsFor(io, a), hash)).not.toBeNull()
  })

  test('a success in the same package forgets it', async () => {
    await io.writeText(`${a}/src/index.ts`, '')
    await settle(io, at(`${a}/src`), { kind: 'failure', reason: 'x' }, null)
    expect(await settle(io, at(a), { kind: 'success' }, null)).toBe(true)
    expect(await check(io, at(a))).toBeNull()
  })

  test('the record keeps its scope, and a root record has none', async () => {
    await settle(io, at(a), { kind: 'failure', reason: 'x' }, null)
    await settle(io, at(root), { kind: 'failure', reason: 'x' }, null)
    const paths = await pathsFor(io, root)
    const scoped = await readRecord(io, paths, (await fingerprint(io, 'Bash', { command: 'bun test' }, 'packages/a'))!)
    const plain = await readRecord(io, paths, 'ab6e15a9a6af15b5')
    expect(scoped?.scope).toBe('packages/a')
    expect(plain).not.toBeNull()
    expect(plain && 'scope' in plain).toBe(false)
  })

  test('a record with no scope, as old records are, matches only at the root', async () => {
    await settle(io, at(root), { kind: 'failure', reason: 'x' }, null)
    expect(await check(io, at(root))).not.toBeNull()
    expect(await check(io, at(a))).toBeNull()
  })

  test('other tools ignore the package', async () => {
    const mcp: Call = { tool: 'mcp__srv__do', input: { a: 1 }, cwd: a, sessionId: 's1' }
    await settle(io, mcp, { kind: 'failure', reason: 'x' }, null)
    expect(await readRecord(io, await pathsFor(io, a), '7de9474754ac3aa7')).not.toBeNull()
    expect(await check(io, { ...mcp, cwd: b })).not.toBeNull()
  })
})
