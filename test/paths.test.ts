import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { dataRoot, findRepoRoot, pathsFor, pendingPath, projectSlug, recordPath } from '../src/paths'

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
