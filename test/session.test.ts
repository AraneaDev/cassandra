import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathsFor, type Paths } from '../src/paths'
import { bumpCompactions, compactionCount } from '../src/session'

let tmp: string
let paths: Paths

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cass-sess-'))
  process.env.CASSANDRA_HOME = join(tmp, 'home')
  paths = pathsFor(tmp)
})

afterEach(() => {
  delete process.env.CASSANDRA_HOME
  rmSync(tmp, { recursive: true, force: true })
})

test('an unseen session has zero compactions', () => {
  expect(compactionCount(paths, 's1')).toBe(0)
})

test('bump increments per session independently', () => {
  bumpCompactions(paths, 's1')
  bumpCompactions(paths, 's1')
  bumpCompactions(paths, 's2')
  expect(compactionCount(paths, 's1')).toBe(2)
  expect(compactionCount(paths, 's2')).toBe(1)
})

test('an empty session id is tolerated', () => {
  expect(() => bumpCompactions(paths, '')).not.toThrow()
  expect(compactionCount(paths, '')).toBe(0)
})

test('path traversal attempts are guarded', () => {
  // sessionId of "." and ".." should be sanitized to the same safe token
  // and must write inside the sessions directory, not escape it
  bumpCompactions(paths, '.')
  expect(compactionCount(paths, '.')).toBe(1)

  bumpCompactions(paths, '..')
  // Both "." and ".." map to the same safe token, so they share a counter
  expect(compactionCount(paths, '.')).toBe(2)
  expect(compactionCount(paths, '..')).toBe(2)

  // Normal session id is independent
  bumpCompactions(paths, 's1')
  expect(compactionCount(paths, 's1')).toBe(1)
  expect(compactionCount(paths, '.')).toBe(2)
})
