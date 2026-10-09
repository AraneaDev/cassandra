// test/scope.spec.ts
import { beforeEach, expect, test } from 'bun:test'
import { MANIFESTS, packageScope } from '../src/core/scope.ts'
import type { Io } from '../src/core/io.ts'
import { memoryIo, type MemoryIo } from './support/memory-io.ts'

let io: MemoryIo
const root = '/work/mono'

beforeEach(async () => {
  io = memoryIo()
  await io.writeText(`${root}/.git/HEAD`, 'ref: refs/heads/main\n')
  await io.writeText(`${root}/package.json`, '{}')
  await io.writeText(`${root}/packages/a/package.json`, '{}')
  await io.writeText(`${root}/packages/a/src/index.ts`, '')
  await io.writeText(`${root}/packages/b/Cargo.toml`, '')
  await io.writeText(`${root}/docs/readme.md`, '')
})

test('the repo root has an empty scope', async () => {
  expect(await packageScope(io, root)).toBe('')
})

test('a package directory is its own scope', async () => {
  expect(await packageScope(io, `${root}/packages/a`)).toBe('packages/a')
  expect(await packageScope(io, `${root}/packages/b`)).toBe('packages/b')
})

test('a directory below a package belongs to that package', async () => {
  expect(await packageScope(io, `${root}/packages/a/src`)).toBe('packages/a')
})

test('a directory with no manifest up to the root belongs to the root', async () => {
  expect(await packageScope(io, `${root}/docs`)).toBe('')
})

test('every listed manifest marks a package', async () => {
  for (const name of MANIFESTS) {
    const dir = `${root}/m/${name.replace(/\./g, '_')}`
    await io.writeText(`${dir}/${name}`, '')
    expect(await packageScope(io, dir)).toBe(`m/${name.replace(/\./g, '_')}`)
  }
  expect(MANIFESTS.size).toBe(12)
})

test('a directory named like a manifest does not count', async () => {
  await io.writeText(`${root}/odd/package.json/inner.txt`, '')
  expect(await packageScope(io, `${root}/odd`)).toBe('')
})

test('a manifest above the repo root is ignored', async () => {
  await io.writeText('/work/package.json', '{}')
  expect(await packageScope(io, `${root}/docs`)).toBe('')
})

test('outside git the scope is always empty', async () => {
  await io.writeText('/plain/sub/package.json', '{}')
  expect(await packageScope(io, '/plain/sub')).toBe('')
})

// Review Focus 1: the root call lists nothing.
test('a call at the repo root lists no directory', async () => {
  let lists = 0
  const counted: Io = { ...io, list: async (dir) => { lists += 1; return io.list(dir) } }
  expect(await packageScope(counted, root)).toBe('')
  expect(lists).toBe(0)
})

// Review Focus 2.
test('a trailing slash or a dot segment gives the same scope', async () => {
  expect(await packageScope(io, `${root}/packages/a/`)).toBe('packages/a')
  expect(await packageScope(io, `${root}/packages/a/./src`)).toBe('packages/a')
})

// Review Focus 3.
test('a nested repository is its own root', async () => {
  await io.writeText(`${root}/vendor/lib/.git`, 'gitdir: ../../.git/modules/lib\n')
  await io.writeText(`${root}/vendor/lib/pkg/package.json`, '{}')
  expect(await packageScope(io, `${root}/vendor/lib/pkg`)).toBe('pkg')
  expect(await packageScope(io, `${root}/vendor/lib`)).toBe('')
})

// Review Focus 5.
test('a deleted or unreadable directory gives an empty scope and never throws', async () => {
  expect(await packageScope(io, `${root}/packages/gone`)).toBe('')
  io.unreadable.add(`${root}/packages/a`)
  expect(await packageScope(io, `${root}/packages/a`)).toBe('')
  const broken: Io = { ...io, list: async () => { throw new Error('boom') } }
  expect(await packageScope(broken, `${root}/packages/a`)).toBe('')
})

test('the walk stops after 32 steps', async () => {
  // A manifest 39 levels up would be found by an uncapped walk; the cap gives up first.
  await io.writeText(`${root}/d0/package.json`, '{}')
  const deep = `${root}/${Array.from({ length: 40 }, (_, i) => `d${i}`).join('/')}`
  await io.writeText(`${deep}/x.txt`, '')
  expect(await packageScope(io, deep)).toBe('')
  expect(await packageScope(io, `${root}/d0/d1`)).toBe('d0')
})
