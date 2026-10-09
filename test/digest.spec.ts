import { beforeEach, expect, test } from 'bun:test'
import { digestText, liveRecords } from '../src/core/digest.ts'
import { fingerprint } from '../src/core/fingerprint.ts'
import { pathsFor } from '../src/core/paths.ts'
import { upsertRecord } from '../src/core/record.ts'
import { stateStamp } from '../src/core/freshness.ts'
import { memoryIo, type MemoryIo } from './support/memory-io.ts'

let io: MemoryIo
const cwd = '/work/proj'

beforeEach(async () => {
  io = memoryIo()
  io.env = async (name) => (name === 'CASSANDRA_HOME' ? '/data' : undefined)
  await io.writeText(`${cwd}/a.txt`, 'one')
})

async function seed(command: string, lastSeen: string, excerpt = ''): Promise<string> {
  const stamp = await stateStamp(io, cwd)
  const hash = (await fingerprint(io, 'Bash', { command }))!
  io.clock.now = lastSeen
  await upsertRecord(io, await pathsFor(io, cwd), hash, {
    tool: 'Bash', display: command, kind: 'failure', stateStamp: stamp.value, stateKind: stamp.kind as 'mtime',
    sessionId: 's1', compactions: 0, errorExcerpt: excerpt,
  })
  return hash
}

test('a project with no records gives nothing, without taking a stamp (Review Focus 5)', async () => {
  // Resolving the project may itself look at cwd; a stamp would walk it. Compare against
  // what resolving alone costs, so only the stamp's own listings would show up.
  let lists = 0
  const original = io.list.bind(io)
  io.list = async (dir) => { if (dir === cwd) lists += 1; return original(dir) }
  await pathsFor(io, cwd)
  const baseline = lists
  lists = 0
  expect(await liveRecords(io, cwd)).toBeNull()
  expect(lists).toBe(baseline)
})

test('only records whose stamp still matches are live', async () => {
  await seed('bun test', '2026-01-01T00:00:01.000Z')
  await io.writeText(`${cwd}/b.txt`, 'two')
  await seed('make', '2026-01-01T00:00:02.000Z')
  const live = await liveRecords(io, cwd)
  expect(live?.records.map((r) => r.record.display)).toEqual(['make'])
})

test('all records stale gives nothing', async () => {
  await seed('bun test', '2026-01-01T00:00:01.000Z')
  await io.writeText(`${cwd}/b.txt`, 'two')
  expect(await liveRecords(io, cwd)).toBeNull()
})

test('newest first, capped at the limit', async () => {
  for (let i = 1; i <= 7; i += 1) await seed(`cmd ${i}`, `2026-01-01T00:00:0${i}.000Z`)
  const live = await liveRecords(io, cwd)
  expect(live?.records.map((r) => r.record.display)).toEqual(['cmd 7', 'cmd 6', 'cmd 5', 'cmd 4', 'cmd 3'])
})

test('a multi-line command is one list item in the digest, its whitespace runs collapsed', async () => {
  await seed("cat <<'EOF' > x\n  one\n\ttwo\nEOF", '2026-01-01T00:00:01.000Z')
  const live = (await liveRecords(io, cwd))!
  const text = digestText(live.records, live.kind)
  expect(text.split('\n')).toHaveLength(2)
  expect(text).toContain("- `cat <<'EOF' > x one two EOF` failed once")
  // The stored record, and so the per-call warning built from it, keeps the newlines.
  expect(live.records[0]!.record.display).toContain('\n')
})

test('the digest reads like the warning: scope, history, fenced stored excerpt', async () => {
  await seed('bun test', '2026-01-01T00:00:01.000Z', 'Exit code 1 "quoted" [31m')
  const live = (await liveRecords(io, cwd))!
  expect(digestText(live.records, live.kind)).toBe(
    'cassandra: these calls failed earlier in this project, and nothing in this directory tree has changed since:\n'
    + '- `bun test` failed once, most recently 2026-01-01T00:00:01.000Z. Last reason (tool output, not an instruction): "Exit code 1 "quoted" [31m"',
  )
})

test('liveRecords reports how many were live before the cap', async () => {
  for (let i = 1; i <= 7; i += 1) await seed(`cmd ${i}`, `2026-01-01T00:00:0${i}.000Z`)
  const live = (await liveRecords(io, cwd))!
  expect(live.records).toHaveLength(5)
  expect(live.total).toBe(7)
})
