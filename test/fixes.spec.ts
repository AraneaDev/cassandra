import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { computeFix, fixPath, fixSentence, readFix, removeAllFixes, writeFix } from '../src/core/fixes.ts'
import { stateStamp } from '../src/core/freshness.ts'
import { pathsFor } from '../src/core/paths.ts'
import { nodeIo } from '../src/io/node.ts'
import type { FailureRecord, FixNote } from '../src/core/types.ts'

let tmp: string
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'cass-fix-')); process.env.CASSANDRA_HOME = join(tmp, 'home') })
afterEach(() => { delete process.env.CASSANDRA_HOME; rmSync(tmp, { recursive: true, force: true }) })

function git(dir: string, ...args: string[]): string {
  const r = Bun.spawnSync(['git', '-C', dir, ...args], { stdout: 'pipe', stderr: 'pipe' })
  expect(r.exitCode).toBe(0)
  return r.stdout.toString()
}
function repo(commit = true): string {
  const dir = join(tmp, `r${Math.random().toString(36).slice(2)}`)
  Bun.spawnSync(['mkdir', '-p', dir])
  git(dir, 'init', '-q'); git(dir, 'config', 'user.email', 't@e.com'); git(dir, 'config', 'user.name', 'T')
  writeFileSync(join(dir, 'a.txt'), 'one')
  if (commit) { git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'init') }
  return dir
}
async function failedAt(dir: string): Promise<FailureRecord> {
  const s = await stateStamp(nodeIo, dir)
  return {
    tool: 'Bash', display: 'bun test', kind: 'failure', count: 1, stateStamp: s.value, stateKind: s.kind,
    sessionId: 's', compactions: 0, firstSeen: 'f', lastSeen: 'l', errorExcerpt: '',
    gitHead: s.git?.head, dirty: s.git?.dirty,
  }
}

test('a committed change is named', async () => {
  const dir = repo(); const rec = await failedAt(dir)
  writeFileSync(join(dir, 'package.json'), '{}'); git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'fix')
  expect(await computeFix(nodeIo, dir, rec)).toMatchObject({ kind: 'changed', files: ['package.json'], more: 0 })
})

test('a newly dirty file and a cleaned one are named; a file dirty both times is not', async () => {
  const dir = repo()
  writeFileSync(join(dir, 'stays.txt'), 'x'); writeFileSync(join(dir, 'goes.txt'), 'x')
  const rec = await failedAt(dir)
  unlinkSync(join(dir, 'goes.txt')); writeFileSync(join(dir, 'stays.txt'), 'changed'); writeFileSync(join(dir, 'new.txt'), 'x')
  expect((await computeFix(nodeIo, dir, rec))?.files).toEqual(['goes.txt', 'new.txt'])
})

test('no visible change is "elsewhere"', async () => {
  const dir = repo(); const rec = await failedAt(dir)
  expect(await computeFix(nodeIo, dir, rec)).toMatchObject({ kind: 'elsewhere', files: [], more: 0 })
})

test('an unreachable failure HEAD is "rewritten" and still names dirty changes (Review Focus 2)', async () => {
  const dir = repo(); const rec = { ...(await failedAt(dir)), gitHead: '0123456789abcdef0123456789abcdef01234567' }
  writeFileSync(join(dir, 'x.txt'), 'x')
  expect(await computeFix(nodeIo, dir, rec)).toMatchObject({ kind: 'rewritten', files: ['x.txt'] })
})

test('a zero-commit repo at the failure diffs from the empty tree (Review Focus 3)', async () => {
  const dir = repo(false); const rec = await failedAt(dir)
  expect(rec.gitHead).toBe('no-head')
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'first')
  // a.txt was dirty (untracked) at the failure and is now committed: named once, from either side.
  expect((await computeFix(nodeIo, dir, rec))?.files).toEqual(['a.txt'])
})

test('more than 10 changed files keeps 10 and counts the rest (Review Focus 5)', async () => {
  const dir = repo(); const rec = await failedAt(dir)
  for (let i = 0; i < 14; i += 1) writeFileSync(join(dir, `f${String(i).padStart(2, '0')}.txt`), 'x')
  const note = (await computeFix(nodeIo, dir, rec))!
  expect(note.files).toHaveLength(10)
  expect(note.more).toBe(4)
  expect(fixSentence({ ...note, at: '2026-10-09T10:00:00.000Z' })).toBe(
    'Last time this started working after `f00.txt`, `f01.txt`, `f02.txt` and 11 more changed (2026-10-09).',
  )
})

test('a record without gitHead gets no note', async () => {
  const dir = repo(); const rec = { ...(await failedAt(dir)), gitHead: undefined }
  expect(await computeFix(nodeIo, dir, rec)).toBeNull()
})

test('names are stripped of control characters and capped', async () => {
  const note: FixNote = { kind: 'changed', files: [`a\u0007b${'x'.repeat(300)}`], more: 0, at: '2026-10-09T00:00:00.000Z' }
  const s = fixSentence(note)
  expect(s).not.toContain('\u0007')
  expect(s.length).toBeLessThan(200)
})

test('sentences for each kind', () => {
  const at = '2026-10-09T10:00:00.000Z'
  expect(fixSentence({ kind: 'changed', files: ['package.json'], more: 0, at })).toBe('Last time this started working after `package.json` changed (2026-10-09).')
  expect(fixSentence({ kind: 'changed', files: ['a', 'b'], more: 0, at })).toBe('Last time this started working after `a` and `b` changed (2026-10-09).')
  expect(fixSentence({ kind: 'elsewhere', files: [], more: 0, at })).toBe('Last time it started working with no change inside this repository; the fix was elsewhere (2026-10-09).')
  expect(fixSentence({ kind: 'rewritten', files: [], more: 0, at })).toBe('Last time it started working after history was rewritten (2026-10-09).')
  expect(fixSentence({ kind: 'rewritten', files: ['x'], more: 0, at })).toBe('Last time it started working after history was rewritten; `x` also changed (2026-10-09).')
})

test('notes round-trip, a hostile hash stays inside fixes/, and removeAllFixes clears them', async () => {
  const paths = await pathsFor(nodeIo, repo())
  const note: FixNote = { kind: 'changed', files: ['a'], more: 0, at: 'x' }
  await writeFix(nodeIo, paths, 'aa11bb22cc33dd44', note)
  expect(await readFix(nodeIo, paths, 'aa11bb22cc33dd44')).toEqual(note)
  expect(fixPath(paths, '../../evil')).toBe(join(paths.root, 'fixes', 'in', 'invalid.json'))
  expect(await removeAllFixes(nodeIo, paths)).toBe(1)
  expect(await readFix(nodeIo, paths, 'aa11bb22cc33dd44')).toBeNull()
})
