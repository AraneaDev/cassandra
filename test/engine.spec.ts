import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { check, settle, type Call } from '../src/core/engine.ts'
import { readFix } from '../src/core/fixes.ts'
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
