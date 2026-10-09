import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathsFor, type Paths } from '../src/core/paths.ts'
import { nodeIo } from '../src/io/node.ts'
import { bumpCompactions, compactionCount } from '../src/core/session.ts'

let tmp: string
let paths: Paths

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'cass-sess-'))
  process.env.CASSANDRA_HOME = join(tmp, 'home')
  paths = await pathsFor(nodeIo, tmp)
})

afterEach(async () => {
  delete process.env.CASSANDRA_HOME
  rmSync(tmp, { recursive: true, force: true })
})

test('an unseen session has zero compactions', async () => {
  expect(await compactionCount(nodeIo, paths, 's1')).toBe(0)
})

test('bump increments per session independently', async () => {
  await bumpCompactions(nodeIo, paths, 's1')
  await bumpCompactions(nodeIo, paths, 's1')
  await bumpCompactions(nodeIo, paths, 's2')
  expect(await compactionCount(nodeIo, paths, 's1')).toBe(2)
  expect(await compactionCount(nodeIo, paths, 's2')).toBe(1)
})

test('an empty session id is tolerated', async () => {
  await expect(bumpCompactions(nodeIo, paths, '')).resolves.toBeUndefined()
  expect(await compactionCount(nodeIo, paths, '')).toBe(0)
})

test('path traversal attempts are guarded', async () => {
  // sessionId of "." and ".." should be sanitized to the same safe token
  // and must write inside the sessions directory, not escape it
  await bumpCompactions(nodeIo, paths, '.')
  expect(await compactionCount(nodeIo, paths, '.')).toBe(1)

  await bumpCompactions(nodeIo, paths, '..')
  // Both "." and ".." map to the same safe token, so they share a counter
  expect(await compactionCount(nodeIo, paths, '.')).toBe(2)
  expect(await compactionCount(nodeIo, paths, '..')).toBe(2)

  // Normal session id is independent
  await bumpCompactions(nodeIo, paths, 's1')
  expect(await compactionCount(nodeIo, paths, 's1')).toBe(1)
  expect(await compactionCount(nodeIo, paths, '.')).toBe(2)
})

test('markers older than a day are pruned, newer ones kept', async () => {
  const { markModSession, pruneModMarkers, isModSession } = await import('../src/core/session.ts')
  await markModSession(nodeIo, 'old')
  await markModSession(nodeIo, 'new')
  const old = join(process.env.CASSANDRA_HOME!, 'sessions', 'old.mod')
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
  utimesSync(old, twoDaysAgo, twoDaysAgo)
  await pruneModMarkers(nodeIo)
  expect(await isModSession(nodeIo, 'old')).toBe(false)
  expect(await isModSession(nodeIo, 'new')).toBe(true)
})

test('stale staging files in sessions/ are pruned, fresh ones kept', async () => {
  const { markModSession, pruneModMarkers } = await import('../src/core/session.ts')
  await markModSession(nodeIo, 'x')
  const dir = join(process.env.CASSANDRA_HOME!, 'sessions')
  const stale = join(dir, 'x.mod.1.abc.tmp')
  const fresh = join(dir, 'y.mod.2.def.tmp')
  writeFileSync(stale, '')
  writeFileSync(fresh, '')
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
  utimesSync(stale, twoDaysAgo, twoDaysAgo)
  await pruneModMarkers(nodeIo)
  expect(existsSync(stale)).toBe(false)
  expect(existsSync(fresh)).toBe(true)
})
