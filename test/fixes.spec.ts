import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { computeFix, dirtyHashes, fixPath, fixSentence, readFix, removeAllFixes, writeFix } from '../src/core/fixes.ts'
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
/** A failure record with its dirty files hashed, as the engine writes it. */
async function failedHashed(dir: string): Promise<FailureRecord> {
  const rec = await failedAt(dir)
  const hashes = await dirtyHashes(nodeIo, dir, rec.dirty ?? [])
  return Object.keys(hashes).length > 0 ? { ...rec, dirtyHashes: hashes } : rec
}
const KB256 = 256 * 1024

test('a committed change is named', async () => {
  const dir = repo(); const rec = await failedAt(dir)
  writeFileSync(join(dir, 'package.json'), '{}'); git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'fix')
  expect(await computeFix(nodeIo, dir, rec)).toMatchObject({ kind: 'changed', files: ['package.json'], more: 0 })
})

test('a newly dirty file and a cleaned one are named; a file dirty both times with no stored hash is not', async () => {
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
  expect(fixSentence({ kind: 'elsewhere', files: [], more: 0, at })).toBe('Last time it started working with no change git could see in this repository; the fix was elsewhere (2026-10-09).')
  expect(fixSentence({ kind: 'rewritten', files: [], more: 0, at })).toBe('Last time it started working after history was rewritten (2026-10-09).')
  expect(fixSentence({ kind: 'rewritten', files: ['x'], more: 0, at })).toBe('Last time it started working after history was rewritten; `x` also changed (2026-10-09).')
})

test('notes round-trip, a hostile hash stays inside fixes/, and removeAllFixes clears them', async () => {
  const paths = await pathsFor(nodeIo, repo())
  const note: FixNote = { kind: 'changed', files: ['a'], more: 0, at: '2026-10-09T00:00:00.000Z' }
  await writeFix(nodeIo, paths, 'aa11bb22cc33dd44', note)
  expect(await readFix(nodeIo, paths, 'aa11bb22cc33dd44')).toEqual(note)
  expect(fixPath(paths, '../../evil')).toBe(join(paths.root, 'fixes', 'in', 'invalid.json'))
  expect(await removeAllFixes(nodeIo, paths)).toEqual({ removed: 1, failed: 0 })
  expect(await readFix(nodeIo, paths, 'aa11bb22cc33dd44')).toBeNull()
})

test('a hostile gitHead is never handed to git', async () => {
  const dir = repo(); const out = join(tmp, 'pwned')
  const rec = { ...(await failedAt(dir)), gitHead: `--output=${out}` }
  writeFileSync(join(dir, 'x.txt'), 'x')
  expect(await computeFix(nodeIo, dir, rec)).toMatchObject({ kind: 'rewritten', files: ['x.txt'] })
  expect(existsSync(out)).toBe(false)
})

test('a real failure HEAD with an unborn HEAD now is rewritten', async () => {
  const dir = repo(); const rec = await failedAt(dir)
  git(dir, 'checkout', '-q', '--orphan', 'x')
  expect((await computeFix(nodeIo, dir, rec))?.kind).toBe('rewritten')
})

test('a tampered note on disk is bounded when read', async () => {
  const paths = await pathsFor(nodeIo, repo())
  const h = 'aa11bb22cc33dd44'
  const put = (o: object) => nodeIo.writeText(fixPath(paths, h), JSON.stringify(o))
  const files = ['', '\u0007\u0007', ...Array.from({ length: 500 }, (_, i) => `f${i}`)]
  for (const more of [-3, 1e300, 'x', 2.5]) {
    await put({ kind: 'changed', files, more, at: '2026-10-09T00:00:00.000Z' })
    const n = (await readFix(nodeIo, paths, h))!
    expect(n.files).toHaveLength(10)
    expect(n.more).toBe(more === 1e300 ? 10000 : 0)
    expect(fixSentence(n)).toContain('Last time')
  }
  await put({ kind: 'changed', files: ['a'], more: 0, at: 'yesterday' })
  expect(await readFix(nodeIo, paths, h)).toBeNull()
})

test('a backtick in a name cannot break out of its code span', () => {
  expect(fixSentence({ kind: 'changed', files: ['a`b'], more: 0, at: '2026-10-09T00:00:00.000Z' })).toBe("Last time this started working after `a'b` changed (2026-10-09).")
})

test('past the dirty cap only the exact direction is used', async () => {
  const dir = repo()
  for (let i = 0; i < 205; i++) writeFileSync(join(dir, `u${String(i).padStart(3, '0')}.txt`), 'x')
  const rec = await failedAt(dir)
  rec.dirty = rec.dirty?.slice(0, 200); rec.dirtyTruncated = true
  unlinkSync(join(dir, 'u001.txt'))
  const note = await computeFix(nodeIo, dir, rec)
  expect(note?.files).toEqual(['u001.txt'])
})

test('a non-ASCII name dirty then committed is named once', async () => {
  const dir = repo()
  writeFileSync(join(dir, 'café.txt'), 'x')
  const rec = await failedAt(dir)
  expect(rec.dirty?.some((d) => d.includes('caf'))).toBe(true)
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'c')
  const note = await computeFix(nodeIo, dir, rec)
  expect(note?.files.filter((f) => f.includes('caf'))).toEqual(['café.txt'])
})

test('removeAllFixes reports notes it could not remove instead of claiming success', async () => {
  const paths = await pathsFor(nodeIo, repo())
  const note: FixNote = { kind: 'changed', files: ['a'], more: 0, at: '2026-10-09T00:00:00.000Z' }
  await writeFix(nodeIo, paths, 'aa11bb22cc33dd44', note)
  await writeFix(nodeIo, paths, 'bb11bb22cc33dd44', note)
  const io = { ...nodeIo, remove: async (p: string) => { if (p.includes('aa11')) throw new Error('EACCES'); return nodeIo.remove(p) } }
  expect(await removeAllFixes(io, paths)).toEqual({ removed: 1, failed: 1 })
  expect(await removeAllFixes(nodeIo, await pathsFor(nodeIo, repo()))).toEqual({ removed: 0, failed: 0 })
})

describe('content hashes of already-dirty files', () => {
  test('an edit to a file dirty at both moments is named', async () => {
    const dir = repo()
    writeFileSync(join(dir, 'a.txt'), 'edited'); writeFileSync(join(dir, 'new.txt'), 'x')
    const rec = await failedHashed(dir)
    expect(Object.keys(rec.dirtyHashes ?? {}).sort()).toEqual(['a.txt', 'new.txt'])
    expect(rec.dirtyHashes?.['a.txt']).toBe((await nodeIo.sha256('edited')).slice(0, 16))
    writeFileSync(join(dir, 'a.txt'), 'edited again')
    expect(await computeFix(nodeIo, dir, rec)).toMatchObject({ kind: 'changed', files: ['a.txt'] })
  })

  test('an untouched file dirty at both moments is not named', async () => {
    const dir = repo()
    writeFileSync(join(dir, 'a.txt'), 'edited')
    const rec = await failedHashed(dir)
    expect(await computeFix(nodeIo, dir, rec)).toMatchObject({ kind: 'elsewhere', files: [] })
  })

  test('only the first 50 dirty paths are hashed, in the order git listed them', async () => {
    const dir = repo()
    for (let i = 0; i < 60; i++) writeFileSync(join(dir, `d${String(i).padStart(2, '0')}.txt`), 'x')
    const rec = await failedHashed(dir)
    expect(Object.keys(rec.dirtyHashes ?? {})).toEqual(rec.dirty!.slice(0, 50))
    writeFileSync(join(dir, 'd00.txt'), 'y'); writeFileSync(join(dir, 'd59.txt'), 'y')
    expect((await computeFix(nodeIo, dir, rec))?.files).toEqual(['d00.txt'])
  })

  test('a file over 256 KB gets no hash and behaves as before', async () => {
    const dir = repo()
    writeFileSync(join(dir, 'big.txt'), 'x'.repeat(KB256 + 1)); writeFileSync(join(dir, 'edge.txt'), 'x'.repeat(KB256))
    const rec = await failedHashed(dir)
    expect(Object.keys(rec.dirtyHashes ?? {})).toEqual(['edge.txt'])
    writeFileSync(join(dir, 'big.txt'), 'y'.repeat(KB256 + 1))
    expect((await computeFix(nodeIo, dir, rec))?.files).toEqual([])
  })

  test('a file that grew past 256 KB, or went missing while still dirty, counts as changed', async () => {
    const dir = repo()
    writeFileSync(join(dir, 'grows.txt'), 'x'); writeFileSync(join(dir, 'a.txt'), 'edited')
    const rec = await failedHashed(dir)
    writeFileSync(join(dir, 'grows.txt'), 'x'.repeat(KB256 + 1)); unlinkSync(join(dir, 'a.txt'))
    expect((await computeFix(nodeIo, dir, rec))?.files).toEqual(['a.txt', 'grows.txt'])
  })

  test('missing, unreadable, directory and symlink paths are skipped silently, and nothing hashed means an empty map', async () => {
    const dir = repo()
    mkdirSync(join(dir, 'sub')); writeFileSync(join(dir, 'sub', 'f.txt'), 'x')
    symlinkSync('a.txt', join(dir, 'link'))
    writeFileSync(join(dir, 'locked.txt'), 'x')
    const io = { ...nodeIo, readText: async (p: string) => { if (p.endsWith('locked.txt')) throw new Error('EACCES'); return nodeIo.readText(p) } }
    const got = await dirtyHashes(io, dir, ['gone.txt', 'sub/', 'sub', 'link', 'locked.txt', 'nodir/x.txt', '', 'sub/f.txt'])
    expect(Object.keys(got)).toEqual(['sub/f.txt'])
    expect(await dirtyHashes(nodeIo, dir, ['gone.txt'])).toEqual({})
  })

  test('a rejecting listing, a file too large to read, and tampered hashes are all handled', async () => {
    const dir = repo()
    writeFileSync(join(dir, 'huge.txt'), 'x'.repeat(KB256 * 3 + 1))
    const read: string[] = []
    const watching = { ...nodeIo, readText: async (p: string) => { read.push(p); return nodeIo.readText(p) } }
    expect(await dirtyHashes(watching, dir, ['huge.txt'])).toEqual({})
    expect(read).toEqual([])
    const rejecting = { ...nodeIo, list: async () => { throw new Error('boom') } }
    expect(await dirtyHashes(rejecting, dir, ['a.txt'])).toEqual({})
    writeFileSync(join(dir, 'a.txt'), 'edited')
    const rec = await failedAt(dir)
    for (const dirtyHashes of [{ 'a.txt': 7 }, ['x'], 'nope', JSON.parse('{"__proto__":{"a.txt":"0"}}')]) {
      expect((await computeFix(nodeIo, dir, { ...rec, dirtyHashes } as FailureRecord))?.files).toEqual([])
    }
  })

  test('a record without dirtyHashes behaves as before', async () => {
    const dir = repo()
    writeFileSync(join(dir, 'a.txt'), 'edited')
    const rec = await failedAt(dir)
    expect(rec.dirtyHashes).toBeUndefined()
    writeFileSync(join(dir, 'a.txt'), 'edited again')
    expect((await computeFix(nodeIo, dir, rec))?.files).toEqual([])
  })

  test('hashes apply past the dirty cap too', async () => {
    const dir = repo()
    for (let i = 0; i < 205; i++) writeFileSync(join(dir, `u${String(i).padStart(3, '0')}.txt`), 'x')
    const rec = await failedHashed(dir)
    rec.dirty = rec.dirty?.slice(0, 200); rec.dirtyTruncated = true
    writeFileSync(join(dir, 'u000.txt'), 'y')
    expect((await computeFix(nodeIo, dir, rec))?.files).toEqual(['u000.txt'])
  })
})
