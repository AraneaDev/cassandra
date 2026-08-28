import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { isMissingSubtree, stateStamp, unchanged } from '../src/freshness'

let tmp: string

function git(cwd: string, ...args: string[]): void {
  Bun.spawnSync(['git', ...args], { cwd, stdout: 'ignore', stderr: 'ignore' })
}

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q')
  git(dir, 'config', 'user.email', 't@example.com')
  git(dir, 'config', 'user.name', 'T')
  writeFileSync(join(dir, 'a.txt'), 'one')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'init')
}

beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'cass-fresh-')) })
afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

// The safety rule that bounds the whole risk.
test('a none stamp never counts as unchanged', () => {
  expect(unchanged('anything', 'git', { kind: 'none', value: '' })).toBe(false)
  expect(unchanged('', 'none', { kind: 'none', value: '' })).toBe(false)
  expect(unchanged('x', 'none', { kind: 'git', value: 'x' })).toBe(false)
})

test('a stamp taken twice with nothing touched is identical', () => {
  const repo = join(tmp, 'r'); initRepo(repo)
  expect(stateStamp(repo).value).toBe(stateStamp(repo).value)
})

test('git: an uncommitted edit changes the stamp', () => {
  const repo = join(tmp, 'r'); initRepo(repo)
  const before = stateStamp(repo)
  writeFileSync(join(repo, 'a.txt'), 'two')
  expect(stateStamp(repo).value).not.toBe(before.value)
})

test('git: a new untracked file changes the stamp', () => {
  const repo = join(tmp, 'r'); initRepo(repo)
  const before = stateStamp(repo)
  writeFileSync(join(repo, 'b.txt'), 'new')
  expect(stateStamp(repo).value).not.toBe(before.value)
})

test('git: a commit changes the stamp', () => {
  const repo = join(tmp, 'r'); initRepo(repo)
  const before = stateStamp(repo)
  writeFileSync(join(repo, 'a.txt'), 'two')
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'second')
  expect(stateStamp(repo).value).not.toBe(before.value)
})

test('git: a sed -i style rewrite changes the stamp', () => {
  const repo = join(tmp, 'r'); initRepo(repo)
  const before = stateStamp(repo)
  // Written the portable way rather than as `sed -i`. BSD sed on macOS reads the next
  // argument as the backup suffix, so `sed -i 's/…/…/' file` consumes the script as the
  // suffix and fails; GNU sed does not. Redirect-and-move is what `-i` does underneath
  // and behaves the same on both, so the test exercises a real in-place rewrite by a
  // real subprocess on every platform instead of quietly doing nothing on one.
  Bun.spawnSync(['sh', '-c', 'sed "s/one/three/" a.txt > a.new && mv a.new a.txt'], { cwd: repo })
  expect(stateStamp(repo).value).not.toBe(before.value)
})

test('git: stamp kind is git inside a repository', () => {
  const repo = join(tmp, 'r'); initRepo(repo)
  expect(stateStamp(repo).kind).toBe('git')
})

test('mtime: kind is mtime outside a repository', () => {
  const plain = join(tmp, 'p'); mkdirSync(plain, { recursive: true })
  writeFileSync(join(plain, 'a.txt'), 'one')
  expect(stateStamp(plain).kind).toBe('mtime')
})

test('mtime: a rewritten file changes the stamp', async () => {
  const plain = join(tmp, 'p'); mkdirSync(plain, { recursive: true })
  writeFileSync(join(plain, 'a.txt'), 'one')
  const before = stateStamp(plain)
  await Bun.sleep(1100)
  writeFileSync(join(plain, 'a.txt'), 'two')
  expect(stateStamp(plain).value).not.toBe(before.value)
})

test('mtime: a new file changes the stamp even within the same second', () => {
  const plain = join(tmp, 'p'); mkdirSync(plain, { recursive: true })
  writeFileSync(join(plain, 'a.txt'), 'one')
  const before = stateStamp(plain)
  writeFileSync(join(plain, 'b.txt'), 'new')
  expect(stateStamp(plain).value).not.toBe(before.value)
})

test('mtime: dot directories and node_modules are skipped', () => {
  const plain = join(tmp, 'p'); mkdirSync(join(plain, 'node_modules'), { recursive: true })
  mkdirSync(join(plain, '.cache'), { recursive: true })
  writeFileSync(join(plain, 'a.txt'), 'one')
  const before = stateStamp(plain)
  writeFileSync(join(plain, 'node_modules', 'x'), 'noise')
  writeFileSync(join(plain, '.cache', 'y'), 'noise')
  expect(stateStamp(plain).value).toBe(before.value)
})

test('a nonexistent directory yields none rather than throwing', () => {
  expect(stateStamp(join(tmp, 'gone')).kind).toBe('none')
})

test('unchanged requires the kind to match, so a fallback switch never warns', () => {
  expect(unchanged('abc', 'git', { kind: 'mtime', value: 'abc' })).toBe(false)
})

test('mtime: deleting the last file moves the stamp and stays kind mtime, not none', () => {
  const plain = join(tmp, 'p'); mkdirSync(plain, { recursive: true })
  writeFileSync(join(plain, 'a.txt'), 'one')
  const before = stateStamp(plain)
  rmSync(join(plain, 'a.txt'), { force: true })
  const after = stateStamp(plain)
  expect(after.kind).toBe('mtime')
  expect(after.value).not.toBe(before.value)
})

test('mtime: a directory of only node_modules and a dot-directory is still kind mtime', () => {
  const plain = join(tmp, 'p')
  mkdirSync(join(plain, 'node_modules'), { recursive: true })
  mkdirSync(join(plain, '.git-ish'), { recursive: true })
  writeFileSync(join(plain, 'node_modules', 'x'), 'noise')
  writeFileSync(join(plain, '.git-ish', 'y'), 'noise')
  const stamp = stateStamp(plain)
  expect(stamp.kind).toBe('mtime')
})

test('mtime: two different readable-but-empty directories share the canonical empty stamp', () => {
  const p1 = join(tmp, 'p1'); mkdirSync(p1, { recursive: true })
  const p2 = join(tmp, 'p2'); mkdirSync(p2, { recursive: true })
  const s1 = stateStamp(p1)
  const s2 = stateStamp(p2)
  expect(s1.kind).toBe('mtime')
  expect(s2.kind).toBe('mtime')
  expect(s1.value).toBe(s2.value)

  const withFile = join(tmp, 'p3'); mkdirSync(withFile, { recursive: true })
  writeFileSync(join(withFile, 'a.txt'), 'one')
  expect(stateStamp(withFile).value).not.toBe(s1.value)
})

// This environment runs as root, where an unreadable directory cannot be
// simulated (chmod has no effect on the walk). The error classification is
// factored into `isMissingSubtree` specifically so it can be unit-tested
// directly against the error shapes readdirSync actually throws, rather than
// relying on a real permissions failure.
test('isMissingSubtree treats ENOENT and ENOTDIR as gone, everything else as poisoning', () => {
  expect(isMissingSubtree({ code: 'ENOENT' })).toBe(true)
  expect(isMissingSubtree({ code: 'ENOTDIR' })).toBe(true)
  expect(isMissingSubtree({ code: 'EACCES' })).toBe(false)
  expect(isMissingSubtree({ code: 'EPERM' })).toBe(false)
  expect(isMissingSubtree({ code: 'EIO' })).toBe(false)
  expect(isMissingSubtree(undefined)).toBe(false)
  expect(isMissingSubtree(new Error('no code'))).toBe(false)
})

test('git: an uninitialized (zero-commit) repo yields kind git', () => {
  const repo = join(tmp, 'r'); mkdirSync(repo, { recursive: true })
  git(repo, 'init', '-q')
  git(repo, 'config', 'user.email', 't@example.com')
  git(repo, 'config', 'user.name', 'T')
  writeFileSync(join(repo, 'a.txt'), 'one')
  expect(stateStamp(repo).kind).toBe('git')
})

test('git: a mutation in a zero-commit repo moves the stamp', () => {
  const repo = join(tmp, 'r'); mkdirSync(repo, { recursive: true })
  git(repo, 'init', '-q')
  git(repo, 'config', 'user.email', 't@example.com')
  git(repo, 'config', 'user.name', 'T')
  writeFileSync(join(repo, 'a.txt'), 'one')
  const before = stateStamp(repo)
  writeFileSync(join(repo, 'b.txt'), 'new')
  expect(stateStamp(repo).value).not.toBe(before.value)
})

test('git: the first commit in a zero-commit repo moves the stamp again', () => {
  const repo = join(tmp, 'r'); mkdirSync(repo, { recursive: true })
  git(repo, 'init', '-q')
  git(repo, 'config', 'user.email', 't@example.com')
  git(repo, 'config', 'user.name', 'T')
  writeFileSync(join(repo, 'a.txt'), 'one')
  const before = stateStamp(repo)
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'init')
  expect(stateStamp(repo).value).not.toBe(before.value)
})

/**
 * Build a directory tree whose deepest level cannot be named in a single syscall.
 *
 * `root` sits just under PATH_MAX so it reads fine; five 200-character levels below it
 * push the last one past the limit, and `readdirSync` on that path fails with
 * ENAMETOOLONG. The levels are created through a shell `cd` chain so `mkdir` only ever
 * receives a relative name, which is the one way to create a path longer than any
 * pathname argument is allowed to be. Returns the readable root.
 *
 * The target depends on the platform: PATH_MAX is 4096 on Linux and 1024 on macOS. A
 * fixed 3400 exceeds the macOS limit while building `root` itself, so construction threw
 * there and the test failed for a reason that had nothing to do with the walk.
 */
function buildOverlongTree(base: string): string {
  const seg = 'd'.repeat(200)
  const target = process.platform === 'darwin' ? 800 : 3400
  let root = base
  while (root.length + 201 < target) root = join(root, seg)
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'a.txt'), 'one')
  const built = Bun.spawnSync([
    'sh', '-c', 'cd "$1" && for i in 1 2 3 4; do mkdir "$2" && cd "$2"; done && mkdir "$2"',
    'sh', root, seg,
  ])
  expect(built.exitCode).toBe(0)
  return root
}

/**
 * `isMissingSubtree` is unit-tested directly, but nothing proved the walk acts on its
 * verdict: deleting `poisoned = true` from `src/freshness.ts` left the whole suite green.
 *
 * This drives a real non-ENOENT failure through the walk. Root runs with
 * CAP_DAC_OVERRIDE here, so an unreadable directory cannot be simulated with chmod; a
 * structural failure can. The subtree exists and is not empty, the walk cannot see into
 * it, and the only correct answer is `none`, which never warns.
 */
test('a non-ENOENT failure inside the walk poisons the whole stamp', () => {
  const base = join(tmp, 'deep')
  mkdirSync(base, { recursive: true })
  try {
    const root = buildOverlongTree(base)

    // The premise: root is readable, the deepest level is not, and the reason is
    // ENAMETOOLONG rather than the ENOENT/ENOTDIR the walk is allowed to skip.
    expect(() => readdirSync(root)).not.toThrow()
    let deepest = root
    for (let i = 0; i < 5; i += 1) deepest = join(deepest, 'd'.repeat(200))
    let code: string | undefined
    try {
      readdirSync(deepest)
    } catch (err) {
      code = (err as NodeJS.ErrnoException).code
    }
    expect(code).toBe('ENAMETOOLONG')
    expect(isMissingSubtree({ code })).toBe(false)

    // The verdict the walk must reach: not a partial stamp over what it could read.
    expect(stateStamp(root).kind).toBe('none')
    expect(unchanged('anything', 'mtime', stateStamp(root))).toBe(false)
  } finally {
    // rmSync cannot remove a tree it cannot name; rm(1) walks it with fchdir.
    Bun.spawnSync(['rm', '-rf', base])
  }
})

