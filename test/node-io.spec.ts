import { afterEach, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { settle } from '../src/core/engine.ts'
import { isMissingSubtree, nodeIo } from '../src/io/node.ts'

const roots: string[] = []
const tmp = (): string => {
  const r = mkdtempSync(join(tmpdir(), 'cass-node-io-'))
  roots.push(r)
  return r
}
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

test('isMissingSubtree is true only for ENOENT and ENOTDIR', () => {
  expect(isMissingSubtree({ code: 'ENOENT' })).toBe(true)
  expect(isMissingSubtree({ code: 'ENOTDIR' })).toBe(true)
  expect(isMissingSubtree({ code: 'EACCES' })).toBe(false)
  expect(isMissingSubtree(undefined)).toBe(false)
})

test('a symbolic link lists as other, and a dangling one does not break the listing', async () => {
  const root = tmp()
  writeFileSync(join(root, 'f.txt'), 'x')
  symlinkSync(join(root, 'f.txt'), join(root, 'ln'))
  symlinkSync(join(root, 'nowhere'), join(root, 'dangling'))
  const l = await nodeIo.list(root)
  if (!l.ok) throw new Error('expected a listing')
  const kinds = Object.fromEntries(l.entries.map((e) => [e.name, e.kind]))
  expect(kinds).toEqual({ 'f.txt': 'file', ln: 'other', dangling: 'other' })
})

test('listing a file rather than a directory is missing', async () => {
  const root = tmp()
  writeFileSync(join(root, 'f.txt'), 'x')
  expect(await nodeIo.list(join(root, 'f.txt'))).toEqual({ ok: false, missing: true })
})

test('a failed writeText rejects and leaves no staging file behind', async () => {
  const root = tmp()
  await nodeIo.writeText(join(root, 'target', 'keep'), 'x')
  // Renaming a file over a non-empty directory fails after staging succeeded.
  await expect(nodeIo.writeText(join(root, 'target'), 'y')).rejects.toBeDefined()
  expect(readdirSync(root)).toEqual(['target'])
})

test('env, homeDir and now answer from the process', async () => {
  expect(await nodeIo.env('HOME')).toBe(process.env.HOME)
  expect(await nodeIo.homeDir()).not.toBe('')
  const now = nodeIo.now()
  expect(new Date(now).toISOString()).toBe(now)
})

test('modIo removes its staging file when the host write rejects part-way', async () => {
  const { modIo } = await import('../src/io/mod.ts')
  const { nodeHost } = await import('./support/node-host.ts')
  const dir = mkdtempSync(join(tmpdir(), 'cass-modio-'))
  try {
    const host = nodeHost()
    host.fs.write = async (p: string, t: string) => {
      writeFileSync(p, t.slice(0, 1))
      throw new Error('disk full')
    }
    await expect(modIo(host).writeText(join(dir, 'r.json'), '{"a":1}')).rejects.toThrow('disk full')
    expect(readdirSync(dir)).toEqual([])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writes and appends are owner-only: files 0600, the directories they create 0700', async () => {
  const root = tmp()
  const mode = (p: string): number => statSync(p).mode & 0o777
  await nodeIo.writeText(join(root, 'records', 'ab', 'abcd.json'), '{}')
  await nodeIo.appendText(join(root, 'logs', 'stats.jsonl'), 'x\n')
  expect(mode(join(root, 'records', 'ab', 'abcd.json'))).toBe(0o600)
  expect(mode(join(root, 'logs', 'stats.jsonl'))).toBe(0o600)
  for (const dir of ['records', 'records/ab', 'logs']) expect(mode(join(root, dir))).toBe(0o700)
})

test('the store root is made owner-only at its first write under it, old files inside it included', async () => {
  const root = join(tmp(), 'store')
  mkdirSync(join(root, 'old'), { recursive: true, mode: 0o755 })
  chmodSync(root, 0o755)
  writeFileSync(join(root, 'old', 'record.json'), '{}', { mode: 0o644 })
  const mode = (p: string): number => statSync(p).mode & 0o777
  nodeIo.ownStore(root)
  // Registering touches nothing, and a write elsewhere leaves the root as it was.
  expect(mode(root)).toBe(0o755)
  await nodeIo.writeText(join(tmp(), 'elsewhere.txt'), 'x')
  expect(mode(root)).toBe(0o755)
  await nodeIo.appendText(join(root, 'stats.jsonl'), 'x\n')
  expect(mode(root)).toBe(0o700)
})

test('a store root that does not exist yet is created owner-only by the first write into it', async () => {
  const root = join(tmp(), 'fresh', 'store')
  nodeIo.ownStore(root)
  await nodeIo.writeText(join(root, 'p', 'records', 'ab', 'x.json'), '{}')
  expect(statSync(root).mode & 0o777).toBe(0o700)
})

test('recording a failure makes the data root owner-only', async () => {
  const home = join(tmp(), 'home')
  mkdirSync(home, { mode: 0o755 })
  chmodSync(home, 0o755)
  const work = tmp()
  writeFileSync(join(work, 'a.txt'), 'one')
  const saved = process.env.CASSANDRA_HOME
  process.env.CASSANDRA_HOME = home
  try {
    expect(await settle(nodeIo, { tool: 'Bash', input: { command: 'bun test' }, cwd: work, sessionId: 's1' }, { kind: 'failure', reason: 'boom' }, null)).toBe(true)
  } finally {
    if (saved === undefined) delete process.env.CASSANDRA_HOME
    else process.env.CASSANDRA_HOME = saved
  }
  expect(statSync(home).mode & 0o777).toBe(0o700)
})
