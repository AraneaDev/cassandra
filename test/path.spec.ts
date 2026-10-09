import { expect, test } from 'bun:test'
import * as posix from 'node:path/posix'
import { basename, dirname, isAbsolute, join, normalize } from '../src/core/path.ts'

const SAMPLES = ['/', '/a', '/a/b', '/a/b/', '/a//b', '/a/./b', '/a/../b', '/../a', 'a', 'a/b', 'a/../..', '.', '']

test('normalize matches node for every sample', () => {
  for (const p of SAMPLES.filter((s) => s !== '')) expect(normalize(p)).toBe(posix.normalize(p).replace(/(.)\/$/, '$1'))
})

test('join matches node, trailing slash aside', () => {
  const cases: string[][] = [['/a', 'b'], ['/a', '/b'], ['/a', '', 'b'], ['a', '..', '..', 'c'], ['/a/b', '../c'], ['/a', 'b.json']]
  for (const parts of cases) expect(join(...parts)).toBe(posix.join(...parts).replace(/(.)\/$/, '$1'))
})

test('dirname and basename match node', () => {
  for (const p of ['/', '/a', '/a/b', '/a/b/', 'a', 'a/b']) {
    expect(dirname(p)).toBe(posix.dirname(p))
    expect(basename(p)).toBe(posix.basename(p))
  }
})

test('isAbsolute is a leading slash', () => {
  expect(isAbsolute('/x')).toBe(true)
  expect(isAbsolute('x')).toBe(false)
  expect(isAbsolute('')).toBe(false)
})
