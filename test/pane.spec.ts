import { beforeEach, expect, test } from 'bun:test'
import { evidence } from '../src/core/describe.ts'
import { fixSentence, writeFix } from '../src/core/fixes.ts'
import { fingerprint } from '../src/core/fingerprint.ts'
import { stateStamp } from '../src/core/freshness.ts'
import { dayGroup, paneModel, type PaneView } from '../src/core/pane.ts'
import { pathsFor } from '../src/core/paths.ts'
import { deleteRecord, readRecord, upsertRecord } from '../src/core/record.ts'
import { bumpCompactions } from '../src/core/session.ts'
import { appendStat } from '../src/core/stats.ts'
import type { FailureRecord, FixNote } from '../src/core/types.ts'
import { memoryIo, type MemoryIo } from './support/memory-io.ts'

let io: MemoryIo
const cwd = '/work/proj'
const NOW = '2026-10-31T12:00:00.000Z'
const view: PaneView = {
  tab: 'history', selected: null, expanded: false, confirmAll: false, confirmRetest: null,
  showFull: false, query: '', notice: null, lastWarning: null,
}

beforeEach(async () => {
  io = memoryIo()
  io.env = async (name) => (name === 'CASSANDRA_HOME' ? '/data' : undefined)
  await io.writeText(`${cwd}/a.txt`, 'one')
})

type Extra = Partial<Pick<FailureRecord, 'input' | 'cwd' | 'inputTooLarge' | 'inputSecret' | 'errorFull' | 'gitHead' | 'dirty' | 'stateStamp' | 'stateKind' | 'sessionId'>>

async function seed(command: string, lastSeen: string, excerpt = '', kind: 'failure' | 'denial' = 'failure', extra: Extra = {}): Promise<string> {
  const stamp = await stateStamp(io, cwd)
  const hash = (await fingerprint(io, 'Bash', { command }))!
  io.clock.now = lastSeen
  await upsertRecord(io, await pathsFor(io, cwd), hash, {
    tool: 'Bash', display: command, kind, stateStamp: stamp.value, stateKind: stamp.kind as 'mtime',
    sessionId: 's1', compactions: 0, errorExcerpt: excerpt, ...extra,
  })
  io.clock.now = NOW
  return hash
}

/** A git repository at `cwd` whose HEAD is `head` and whose working tree is clean. */
async function gitAt(head: string, branch: string | null = 'main'): Promise<void> {
  await io.writeText(`${cwd}/.git/HEAD`, 'ref: refs/heads/main\n')
  io.script = (argv) => {
    if (argv.includes('rev-parse')) return { exitCode: 0, stdout: `${head}\n`, stderr: '' }
    if (argv.includes('status')) return { exitCode: 0, stdout: '', stderr: '' }
    if (argv.includes('symbolic-ref')) return branch ? { exitCode: 0, stdout: `${branch}\n`, stderr: '' } : { exitCode: 1, stdout: '', stderr: '' }
    return null
  }
}

/** A local-time ISO string, so day groups hold in any time zone. */
const local = (y: number, mo: number, d: number, h = 12, mi = 0): string => new Date(y, mo - 1, d, h, mi).toISOString()

test('an empty project gives an empty model named after the project', async () => {
  io.clock.now = NOW
  const m = await paneModel(io, cwd, view, 's1')
  expect(m).toMatchObject({
    project: 'proj', git: null, rows: [], total: 0, hashes: [], selected: null, detail: null, error: null, rates: null,
    justWarned: null, tabs: { history: 0, warnings: 0, stale: 0, denied: 0 },
    counters: { warnNow: 0, remembered: 0, warningsToday: 0, clearedByRetest: 0 },
  })
})

test('tabs count every record by state', async () => {
  const s1 = await seed('old one', '2026-10-30T10:00:00.000Z')
  const s2 = await seed('old two', '2026-10-30T11:00:00.000Z')
  const d = await seed('denied', '2026-10-30T12:00:00.000Z', '', 'denial')
  await io.writeText(`${cwd}/b.txt`, 'tree changed')
  const w = await seed('warns', '2026-10-30T13:00:00.000Z')
  const m = await paneModel(io, cwd, view, 's1')
  expect(m.tabs).toEqual({ history: 4, warnings: 1, stale: 2, denied: 1 })
  expect(m.rows.map((r) => [r.hash, r.state])).toEqual([[w, 'warns'], [d, 'denied'], [s2, 'stale'], [s1, 'stale']])
  const warnings = await paneModel(io, cwd, { ...view, tab: 'warnings' }, 's1')
  expect(warnings.rows.map((r) => r.hash)).toEqual([w])
  expect((await paneModel(io, cwd, { ...view, tab: 'stale' }, 's1')).rows.map((r) => r.hash)).toEqual([s2, s1])
  expect((await paneModel(io, cwd, { ...view, tab: 'denied' }, 's1')).rows.map((r) => r.hash)).toEqual([d])
})

test('counters', async () => {
  await seed('old one', '2026-10-30T10:00:00.000Z')
  await seed('old two', '2026-10-30T11:00:00.000Z')
  await seed('denied', '2026-10-30T12:00:00.000Z', '', 'denial')
  await io.writeText(`${cwd}/b.txt`, 'tree changed')
  await seed('warns', '2026-10-30T13:00:00.000Z')
  const paths = await pathsFor(io, cwd)
  io.clock.now = '2026-10-28T12:00:00.000Z'
  await appendStat(io, paths, { kind: 'warned', hash: 'h', boundary: 'session' })
  await appendStat(io, paths, { kind: 'retest_cleared', hash: 'h' })
  io.clock.now = NOW
  await appendStat(io, paths, { kind: 'warned', hash: 'h', boundary: 'same_context' })
  await appendStat(io, paths, { kind: 'warned', hash: 'h', boundary: 'session' })
  await appendStat(io, paths, { kind: 'retest_cleared', hash: 'h' })
  await appendStat(io, paths, { kind: 'retest_failed', hash: 'h' })
  const m = await paneModel(io, cwd, view, 's1')
  expect(m.counters).toEqual({ warnNow: 1, remembered: 4, warningsToday: 2, clearedByRetest: 1 })
  expect(m.rates).toBe('fp 0.0% · same_context 33.3%')
})

test('rows are grouped by day', async () => {
  const now = local(2026, 10, 31, 15) // a Saturday
  expect(dayGroup(local(2026, 10, 31, 0, 1), now)).toBe('Today')
  expect(dayGroup(local(2026, 10, 30, 23, 59), now)).toBe('Yesterday')
  expect(dayGroup(local(2026, 10, 26), now)).toBe('Monday')
  expect(dayGroup(local(2026, 10, 25), now)).toBe('Sunday')
  expect(dayGroup(local(2026, 10, 24), now)).toBe('Last week')
  expect(dayGroup(local(2026, 10, 18), now)).toBe('Last week')
  expect(dayGroup(local(2026, 10, 17), now)).toBe('Older')
  expect(dayGroup('not a date', now)).toBe('Older')
  io.clock.now = now
  await seed('bun test', local(2026, 10, 30, 9, 5))
  io.clock.now = now
  const m = await paneModel(io, cwd, view, 's1')
  expect(m.rows[0]).toMatchObject({ group: 'Yesterday', time: '09:05', count: 1, where: '', display: 'bun test' })
})

test('rows older than this week show their date, the others their time', async () => {
  const now = local(2026, 11, 3, 15) // a Tuesday, so Oct 25 and Sep 30 cross a month boundary
  const when: Array<[string, string]> = [
    ['today', local(2026, 11, 3, 8, 7)],
    ['yesterday', local(2026, 11, 2, 23, 59)],
    ['weekday', local(2026, 10, 28, 6, 30)],
    ['last week start', local(2026, 10, 27, 9, 5)],
    ['last week', local(2026, 10, 25, 18, 45)],
    ['last week edge', local(2026, 10, 21, 0, 1)],
    ['older', local(2026, 9, 30, 12, 0)],
    ['older jan', local(2026, 1, 2, 3, 4)],
  ]
  for (const [command, at] of when) await seed(command, at)
  io.clock.now = now
  const m = await paneModel(io, cwd, view, 's1')
  const byName = Object.fromEntries(m.rows.map((r) => [r.display, [r.group, r.time]]))
  expect(byName).toEqual({
    today: ['Today', '08:07'],
    yesterday: ['Yesterday', '23:59'],
    weekday: ['Wednesday', '06:30'],
    'last week start': ['Last week', '10-27'],
    'last week': ['Last week', '10-25'],
    'last week edge': ['Last week', '10-21'],
    older: ['Older', '09-30'],
    'older jan': ['Older', '01-02'],
  })
})

test('the query filters rows by display, case-insensitive', async () => {
  const a = await seed('bun TEST', '2026-10-30T10:00:00.000Z')
  await seed('make', '2026-10-30T11:00:00.000Z')
  const c = await seed('npm test', '2026-10-30T12:00:00.000Z')
  const m = await paneModel(io, cwd, { ...view, query: 'Test' }, 's1')
  expect(m.rows.map((r) => r.hash)).toEqual([c, a])
  expect(m.selected).toBe(c)
  expect(m.tabs.history).toBe(3)
})

test('Forget all counts the whole store', async () => {
  const a = await seed('one', '2026-10-30T10:00:00.000Z')
  const b = await seed('two', '2026-10-30T11:00:00.000Z', '', 'denial')
  const m = await paneModel(io, cwd, { ...view, tab: 'denied', query: 'tw' }, 's1')
  expect(m.rows.map((r) => r.hash)).toEqual([b])
  expect(m.total).toBe(2)
  expect(m.hashes).toEqual([b, a])
})

test('a vanished selection falls back to the first row; a present one is kept', async () => {
  const a = await seed('one', '2026-10-30T10:00:00.000Z')
  const b = await seed('two', '2026-10-30T11:00:00.000Z')
  expect((await paneModel(io, cwd, { ...view, selected: 'gone' }, 's1')).selected).toBe(b)
  expect((await paneModel(io, cwd, { ...view, selected: a }, 's1')).selected).toBe(a)
  expect((await paneModel(io, cwd, { ...view, selected: a, query: 'two' }, 's1')).selected).toBe(b)
  const none = await paneModel(io, cwd, { ...view, query: 'nothing' }, 's1')
  expect(none).toMatchObject({ rows: [], selected: null, detail: null, total: 2 })
})

test('a display with a newline and control character is one clean line', async () => {
  await seed('echo a\nb\u0007c', '2026-10-30T10:00:00.000Z')
  expect((await paneModel(io, cwd, view, 's1')).rows[0]!.display).toBe('echo a b c')
})

test('the detail of a dirty git failure names what differs now', async () => {
  await gitAt('b2c3d4e5f60718293a4b5c6d7e8f901234567890')
  const hash = await seed('bun test', '2026-10-30T10:00:00.000Z', 'boom', 'failure', {
    stateKind: 'git', stateStamp: 'old', gitHead: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', dirty: ['x.ts'], errorFull: 'boom\n  at x.ts:1',
  })
  const m = await paneModel(io, cwd, view, 's1')
  expect(m.git).toEqual({ branch: 'main', head: 'b2c3d4e' })
  expect(m.rows[0]).toMatchObject({ hash, state: 'stale' })
  expect(m.detail).toMatchObject({
    warnsNow: false,
    evidenceThen: 'HEAD a1b2c3d, 1 uncommitted file (x.ts)',
    evidenceNow: 'HEAD b2c3d4e, working tree clean',
    reason: 'boom', full: 'boom\n  at x.ts:1', exitCode: null,
    firstSeen: '2026-10-30T10:00:00.000Z', lastSeen: '2026-10-30T10:00:00.000Z', tries: 1,
    session: 'in this session', fix: null,
  })
  expect((await paneModel(io, cwd, view, 's2')).detail?.session).toBe('in an earlier session')
})

test('the session detail counts compactions since the failure', async () => {
  await seed('bun test', '2026-10-30T10:00:00.000Z')
  expect((await paneModel(io, cwd, view, 's1')).detail?.session).toBe('in this session')
  await bumpCompactions(io, await pathsFor(io, cwd), 's1')
  expect((await paneModel(io, cwd, view, 's1')).detail?.session).toBe('in this session (before the latest compaction)')
})

test('a detached head has no branch', async () => {
  await gitAt('b2c3d4e5f60718293a4b5c6d7e8f901234567890', null)
  expect((await paneModel(io, cwd, view, 's1')).git).toEqual({ branch: null, head: 'b2c3d4e' })
})

test('a record whose HEAD is gone still draws', async () => {
  await seed('bun test', '2026-10-30T10:00:00.000Z', '', 'failure', { stateKind: 'git', stateStamp: 'old', gitHead: 'a1b2c3d4e5f6' })
  const m = await paneModel(io, cwd, view, 's1')
  expect(m.error).toBeNull()
  expect(m.git).toBeNull()
  expect(m.detail).toMatchObject({ warnsNow: false, evidenceThen: 'HEAD a1b2c3d, working tree clean', evidenceNow: 'not a git repository now' })
})

test('the detail of a directory-tree failure says whether files changed', async () => {
  await seed('bun test', '2026-10-30T10:00:00.000Z')
  expect((await paneModel(io, cwd, view, 's1')).detail).toMatchObject({
    warnsNow: true, evidenceThen: 'the files under this directory tree', evidenceNow: 'no file changed since',
  })
  await io.writeText(`${cwd}/b.txt`, 'tree changed')
  expect((await paneModel(io, cwd, view, 's1')).detail).toMatchObject({ warnsNow: false, evidenceNow: 'files changed since' })
})

test('exit code is read from the excerpt', async () => {
  await seed('one', '2026-10-30T10:00:00.000Z', 'Exit code 2 error: nope')
  expect((await paneModel(io, cwd, view, 's1')).detail).toMatchObject({ exitCode: 2, reason: 'Exit code 2 error: nope' })
  await seed('two', '2026-10-30T11:00:00.000Z', 'no exit code here')
  expect((await paneModel(io, cwd, view, 's1')).detail?.exitCode).toBeNull()
  await seed('three', '2026-10-30T12:00:00.000Z')
  expect((await paneModel(io, cwd, view, 's1')).detail).toMatchObject({ exitCode: null, reason: null, full: null })
})

test('the detail carries the fix note', async () => {
  const a = await seed('one', '2026-10-30T10:00:00.000Z')
  const note: FixNote = { kind: 'changed', files: ['x.ts'], more: 0, at: '2026-10-30T11:00:00.000Z' }
  await writeFix(io, await pathsFor(io, cwd), a, note)
  expect((await paneModel(io, cwd, view, 's1')).detail?.fix).toBe(fixSentence(note))
})

test('retest availability', async () => {
  const denied = await seed('denied', '2026-10-30T10:00:00.000Z', '', 'denial', { input: { command: 'denied' }, cwd })
  const old = await seed('old', '2026-10-30T10:00:00.000Z')
  const big = await seed('big', '2026-10-30T10:00:00.000Z', '', 'failure', { inputTooLarge: true, cwd })
  const ok = await seed('ok', '2026-10-30T10:00:00.000Z', '', 'failure', { input: { command: 'ok' }, cwd: `${cwd}/sub` })
  const secret = await seed('secret', '2026-10-30T10:00:00.000Z', '', 'failure', { inputSecret: true })
  const retest = async (selected: string) => (await paneModel(io, cwd, { ...view, selected }, 's1')).detail?.retest
  expect(await retest(secret)).toEqual({ ok: false, why: 'secret' })
  expect(await retest(denied)).toEqual({ ok: false, why: 'denied' })
  expect(await retest(old)).toEqual({ ok: false, why: 'no-input' })
  expect(await retest(big)).toEqual({ ok: false, why: 'too-large' })
  expect(await retest(ok)).toEqual({ ok: true, tool: 'Bash', input: { command: 'ok' }, cwd: `${cwd}/sub` })
})

test("just warned shows only this session's latest warning of a record that still exists", async () => {
  const hash = await seed('bun test', '2026-10-30T10:00:00.000Z', 'Exit code 1 boom')
  const paths = await pathsFor(io, cwd)
  const at = '2026-10-31T11:59:00.000Z'
  const warned = { ...view, lastWarning: { hash, at } }
  expect((await paneModel(io, cwd, warned, 's1')).justWarned).toBeNull()
  await appendStat(io, paths, { kind: 'warned', hash, boundary: 'session', sessionId: 's1' })
  const record = (await readRecord(io, paths, hash))!
  expect((await paneModel(io, cwd, warned, 's1')).justWarned).toEqual({
    hash, at, display: 'bun test', count: 1, lastSeen: '2026-10-30T10:00:00.000Z',
    reason: 'Exit code 1 boom', evidence: evidence(record), fix: null,
  })
  expect((await paneModel(io, cwd, warned, 's2')).justWarned).toBeNull()
  expect((await paneModel(io, cwd, view, 's1')).justWarned).toBeNull()
  await deleteRecord(io, paths, hash)
  expect((await paneModel(io, cwd, warned, 's1')).justWarned).toBeNull()
})

test('a last warning naming this session shows without a warned event, and one naming another session does not', async () => {
  const hash = await seed('bun test', '2026-10-30T10:00:00.000Z', 'Exit code 1 boom')
  const paths = await pathsFor(io, cwd)
  const at = '2026-10-31T11:59:00.000Z'
  // The stats append that would have logged the warning failed: there is no warned event.
  const snapshot = { hash, at, sessionId: 's1', count: 1, lastSeen: '2026-10-30T10:00:00.000Z', evidence: 'E', reason: 'Exit code 1 boom', fix: null }
  expect((await paneModel(io, cwd, { ...view, lastWarning: snapshot }, 's1')).justWarned).not.toBeNull()
  await appendStat(io, paths, { kind: 'warned', hash, boundary: 'session', sessionId: 's2' })
  expect((await paneModel(io, cwd, { ...view, lastWarning: snapshot }, 's2')).justWarned).toBeNull()
})

test('the Just warned card reads the reason and the fix as they were when warned; an older last warning reads them live', async () => {
  const hash = await seed('bun test', '2026-10-30T10:00:00.000Z', 'Exit code 2 later failure')
  const paths = await pathsFor(io, cwd)
  const note: FixNote = { kind: 'changed', files: ['x.ts'], more: 0, at: '2026-10-31T11:00:00.000Z' }
  await writeFix(io, paths, hash, note)
  const at = '2026-10-31T11:59:00.000Z'
  const snapshot = { hash, at, sessionId: 's1', count: 1, lastSeen: '2026-10-30T10:00:00.000Z', evidence: 'E', reason: 'Exit code 1 as warned', fix: null }
  const then = (await paneModel(io, cwd, { ...view, lastWarning: snapshot }, 's1')).justWarned
  expect([then?.reason, then?.fix]).toEqual(['Exit code 1 as warned', null])
  const withFix = (await paneModel(io, cwd, { ...view, lastWarning: { ...snapshot, reason: null, fix: 'Fixed then.' } }, 's1')).justWarned
  expect([withFix?.reason, withFix?.fix]).toEqual([null, 'Fixed then.'])
  await appendStat(io, paths, { kind: 'warned', hash, boundary: 'session', sessionId: 's1' })
  const live = (await paneModel(io, cwd, { ...view, lastWarning: { hash, at } }, 's1')).justWarned
  expect([live?.reason, live?.fix]).toEqual(['Exit code 2 later failure', fixSentence(note)])
})

test('an unreadable store gives the error model', async () => {
  await seed('one', '2026-10-30T10:00:00.000Z')
  io.list = async () => { throw new Error('EIO') }
  const m = await paneModel(io, cwd, { ...view, notice: 'hi' }, 's1')
  expect(m).toMatchObject({ rows: [], total: 0, selected: null, detail: null, rates: null, error: "Cassandra could not read this project's store." })
  expect(m.view.notice).toBe('hi')
})
