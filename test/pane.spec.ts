import { beforeEach, expect, test } from 'bun:test'
import { settle } from '../src/core/engine.ts'
import { fixSentence, writeFix } from '../src/core/fixes.ts'
import { fingerprint } from '../src/core/fingerprint.ts'
import { stateStamp } from '../src/core/freshness.ts'
import { paneModel, type PaneView } from '../src/core/pane.ts'
import { pathsFor } from '../src/core/paths.ts'
import { upsertRecord } from '../src/core/record.ts'
import { appendStat, readStats, warningRates } from '../src/core/stats.ts'
import type { FixNote } from '../src/core/types.ts'
import { memoryIo, type MemoryIo } from './support/memory-io.ts'

let io: MemoryIo
const cwd = '/work/proj'
const view: PaneView = { selected: null, confirmAll: false, notice: null }

beforeEach(async () => {
  io = memoryIo()
  io.env = async (name) => (name === 'CASSANDRA_HOME' ? '/data' : undefined)
  await io.writeText(`${cwd}/a.txt`, 'one')
})

async function seed(command: string, lastSeen: string, excerpt = '', kind: 'failure' | 'denial' = 'failure'): Promise<string> {
  const stamp = await stateStamp(io, cwd)
  const hash = (await fingerprint(io, 'Bash', { command }))!
  io.clock.now = lastSeen
  await upsertRecord(io, await pathsFor(io, cwd), hash, {
    tool: 'Bash', display: command, kind, stateStamp: stamp.value, stateKind: stamp.kind as 'mtime',
    sessionId: 's1', compactions: 0, errorExcerpt: excerpt,
  })
  return hash
}

test('an empty project gives an empty model', async () => {
  const m = await paneModel(io, cwd, view, 10)
  expect(m).toMatchObject({ rows: [], total: 0, selected: null, detail: null, error: null, stats: null })
})

test('rows are newest first, then stale once the tree changes', async () => {
  const a = await seed('bun test', '2026-03-04T00:00:01.000Z')
  const b = await seed('make', '2026-05-06T00:00:01.000Z', '', 'denial')
  const m = await paneModel(io, cwd, view, 10)
  expect(m.rows.map((r) => r.hash)).toEqual([b, a])
  expect(m.rows[0]).toMatchObject({ id: b.slice(0, 8), kind: 'denied', count: 1, day: '05-06', stale: false })
  expect(m.rows[1]).toMatchObject({ kind: 'failed', day: '03-04' })
  await io.writeText(`${cwd}/c.txt`, 'two')
  const after = await paneModel(io, cwd, view, 10)
  expect(after.rows.every((r) => r.stale)).toBe(true)
  expect(after.detail?.probe).toBe('mtime · something changed since')
})

test('a display with a newline and control character is one clean line', async () => {
  await seed('echo a\nb\u0007c', '2026-01-01T00:00:01.000Z')
  const m = await paneModel(io, cwd, view, 10)
  expect(m.rows[0]!.display).toBe('echo a b c')
})

test('a vanished selection falls back to the first row; a present one is kept', async () => {
  const a = await seed('one', '2026-01-01T00:00:01.000Z')
  const b = await seed('two', '2026-01-01T00:00:02.000Z')
  expect((await paneModel(io, cwd, { ...view, selected: 'gone' }, 10)).selected).toBe(b)
  expect((await paneModel(io, cwd, { ...view, selected: a }, 10)).selected).toBe(a)
})

test('detail reports the excerpt, the probe and the fix', async () => {
  const a = await seed('one', '2026-01-01T00:00:01.000Z', 'boom')
  let m = await paneModel(io, cwd, view, 10)
  expect(m.detail).toEqual({ reason: 'boom', probe: 'mtime · nothing changed since', fix: null })
  const note: FixNote = { kind: 'changed', files: ['x.ts'], more: 0, at: '2026-02-02T00:00:00.000Z' }
  await writeFix(io, await pathsFor(io, cwd), a, note)
  m = await paneModel(io, cwd, view, 10)
  expect(m.detail?.fix).toBe(fixSentence(note))
  await seed('two', '2026-01-01T00:00:05.000Z')
  expect((await paneModel(io, cwd, view, 10)).detail?.reason).toBeNull()
  await seed('three', '2026-01-01T00:00:06.000Z', 'line one\n\u0007line two')
  expect((await paneModel(io, cwd, view, 10)).detail?.reason).toBe('line one line two')
})

test('stats match the numbers cassandra stats reads', async () => {
  await seed('one', '2026-01-01T00:00:01.000Z')
  const paths = await pathsFor(io, cwd)
  expect((await paneModel(io, cwd, view, 10)).stats).toBeNull()
  for (const [kind, boundary] of [['warned', 'same_context'], ['warned', 'session'], ['false_positive'], ['confirmed'], ['confirmed'], ['confirmed']] as const) {
    await appendStat(io, paths, { kind, hash: 'h', boundary })
  }
  const r = warningRates(await readStats(io, paths))
  expect(r.fpRate).toBe(25)
  expect((await paneModel(io, cwd, view, 10)).stats).toBe('fp 25.0% · same_context 50.0%')
})

test('stats show one decimal, like cassandra stats', async () => {
  await seed('one', '2026-01-01T00:00:01.000Z')
  const paths = await pathsFor(io, cwd)
  const log: Array<Parameters<typeof appendStat>[2]> = [
    { kind: 'warned', hash: 'h', boundary: 'same_context' },
    { kind: 'warned', hash: 'h', boundary: 'session' },
    { kind: 'warned', hash: 'h', boundary: 'session' },
    { kind: 'false_positive', hash: 'h' },
    { kind: 'confirmed', hash: 'h' },
    { kind: 'confirmed', hash: 'h' },
  ]
  for (const e of log) await appendStat(io, paths, e)
  // 1 of 3 resolved is a false positive; 1 of 3 warnings is same_context.
  expect((await paneModel(io, cwd, view, 10)).stats).toBe('fp 33.3% · same_context 33.3%')
})

test('maxRows caps the rows and counts the rest', async () => {
  for (let i = 1; i <= 5; i += 1) await seed(`cmd ${i}`, `2026-01-01T00:00:0${i}.000Z`)
  const m = await paneModel(io, cwd, view, 2)
  expect(m.rows).toHaveLength(2)
  expect(m.more).toBe(3)
  expect(m.total).toBe(5)
})

test('an unreadable store gives the error model', async () => {
  await seed('one', '2026-01-01T00:00:01.000Z')
  io.list = async () => { throw new Error('EIO') }
  const m = await paneModel(io, cwd, { ...view, notice: 'hi' }, 10)
  expect(m).toMatchObject({ rows: [], more: 0, total: 0, selected: null, detail: null, stats: null, error: "Cassandra could not read this project's store.", notice: 'hi' })
})

test('warningRates is zero with no events', () => {
  expect(warningRates([])).toMatchObject({ warned: 0, fpRate: 0, sameContextRate: 0 })
})

test('a package record shows its package in the row', async () => {
  const root = '/work/mono'
  await io.writeText(`${root}/.git/HEAD`, 'ref: refs/heads/main\n')
  await io.writeText(`${root}/packages/a/package.json`, '{}')
  await settle(io, { tool: 'Bash', input: { command: 'bun test' }, cwd: `${root}/packages/a`, sessionId: 's1' }, { kind: 'failure', reason: 'x' }, null)
  const m = await paneModel(io, root, view, 10)
  expect(m.rows[0]!.display).toBe('bun test')
  expect(m.rows[0]!.where).toBe(' (in packages/a)')
})

test('a root record has no suffix, and a hand-edited non-string scope reads as none', async () => {
  const hash = await seed('bun test', '2026-01-01T00:00:01.000Z')
  const paths = await pathsFor(io, cwd)
  const file = `${paths.records}/${hash.slice(0, 2)}/${hash}.json`
  expect((await paneModel(io, cwd, view, 10)).rows[0]!.where).toBe('')
  await io.writeText(file, JSON.stringify({ ...JSON.parse((await io.readText(file))!), scope: 1 }))
  const m = await paneModel(io, cwd, view, 10)
  expect(m.error).toBeNull()
  expect(m.rows[0]).toMatchObject({ display: 'bun test', where: '' })
})
