import { afterEach, beforeEach, expect, test } from 'bun:test'
import type { Io } from '../src/core/io.ts'
import { dataRoot, pathsFor } from '../src/core/paths.ts'
import { markPending, takePending } from '../src/core/pending.ts'
import { bumpCompactions, clearModSession, compactionCount, isModSession, pruneModMarkers } from '../src/core/session.ts'
import { memoryIo } from './support/memory-io.ts'

// These pin the promise each of these functions makes: a store that throws costs a metric
// or a marker, never the tool call. They drive the catch paths through an Io that throws,
// so the result does not depend on the machine's file system or permissions.

const failing = (base: Io, broken: Partial<Record<keyof Io, () => never>>): Io =>
  new Proxy(base, { get: (target, key) => (broken as Record<PropertyKey, unknown>)[key] ?? Reflect.get(target, key) })
const boom = (): never => { throw new Error('EIO') }

beforeEach(() => { process.env.CASSANDRA_HOME = '/data' })
afterEach(() => { delete process.env.CASSANDRA_HOME })

test('a pending marker that cannot be listed, pruned, written or read costs nothing', async () => {
  const io = memoryIo()
  await io.writeText('/p/old', 'stale')
  await expect(markPending(failing(io, { remove: boom }), '/p', 'call-1', { hash: 'h', cwd: '/w' })).resolves.toBeUndefined()
  await expect(markPending(failing(io, { list: boom }), '/p', 'call-2', { hash: 'h', cwd: '/w' })).resolves.toBeUndefined()
  await expect(markPending(failing(io, { writeText: boom }), '/p', 'call-3', { hash: 'h', cwd: '/w' })).resolves.toBeUndefined()
  expect(await takePending(failing(io, { readText: boom }), '/p', 'call-1')).toEqual({ hash: null, cwd: null })
})

test('the compaction counter reads zero and bumps nothing when the store throws', async () => {
  const io = memoryIo()
  const paths = await pathsFor(io, '/w')
  expect(await compactionCount(failing(io, { readText: boom }), paths, 's1')).toBe(0)
  await expect(bumpCompactions(failing(io, { writeText: boom }), paths, 's1')).resolves.toBeUndefined()
})

test('the mod session marker answers false, clears and prunes quietly when the store throws', async () => {
  const io = memoryIo()
  const sessions = `${await dataRoot(io)}/sessions`
  await io.writeText(`${sessions}/old.mod`, '')
  expect(await isModSession(failing(io, { exists: boom }), 's1')).toBe(false)
  await expect(clearModSession(failing(io, { remove: boom }), 's1')).resolves.toBeUndefined()
  await expect(pruneModMarkers(failing(io, { remove: boom }))).resolves.toBeUndefined()
  await expect(pruneModMarkers(failing(io, { list: boom }))).resolves.toBeUndefined()
})
