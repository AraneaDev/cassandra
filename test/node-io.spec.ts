import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
