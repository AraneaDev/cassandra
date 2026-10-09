import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Io } from '../src/core/io.ts'
import { nodeIo } from '../src/io/node.ts'
import { memoryIo } from './support/memory-io.ts'

/** One implementation under contract: an `Io`, a writable root, and a way to make a path unreadable. */
export interface Subject {
  io: Io
  root: string
  makeUnreadable: (path: string) => void
  canRun: boolean
  cleanup: () => void
}

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0

/** Subjects keyed by name. Task 6 adds `mod`. */
export const SUBJECTS: Record<string, () => Subject> = {
  node: () => {
    const root = mkdtempSync(join(tmpdir(), 'cass-io-'))
    return {
      io: nodeIo, root, canRun: true,
      makeUnreadable: (p) => chmodSync(p, 0o000),
      cleanup: () => { try { chmodSync(join(root, 'locked'), 0o700) } catch {} rmSync(root, { recursive: true, force: true }) },
    }
  },
  memory: () => {
    const io = memoryIo()
    return { io, root: '/work', canRun: false, makeUnreadable: (p) => io.unreadable.add(p), cleanup: () => {} }
  },
}

for (const [name, make] of Object.entries(SUBJECTS)) {
  describe(`Io contract: ${name}`, () => {
    let s: Subject
    const fresh = (): Subject => (s = make())
    afterEach(() => s?.cleanup())

    test('readText of a missing file is null', async () => {
      fresh()
      expect(await s.io.readText(join(s.root, 'nope.txt'))).toBeNull()
    })

    test('writeText creates parents and readText returns the text', async () => {
      fresh()
      const p = join(s.root, 'a', 'b', 'c.txt')
      await s.io.writeText(p, 'hello')
      expect(await s.io.readText(p)).toBe('hello')
    })

    test('writeText replaces existing content', async () => {
      fresh()
      const p = join(s.root, 'x.txt')
      await s.io.writeText(p, 'one')
      await s.io.writeText(p, 'two')
      expect(await s.io.readText(p)).toBe('two')
    })

    test('appendText creates the file and its parents, then appends', async () => {
      fresh()
      const p = join(s.root, 'logs', 'l.jsonl')
      await s.io.appendText(p, 'a\n')
      await s.io.appendText(p, 'b\n')
      expect(await s.io.readText(p)).toBe('a\nb\n')
    })

    test('remove deletes a file and ignores a missing one', async () => {
      fresh()
      const p = join(s.root, 'gone.txt')
      await s.io.writeText(p, 'x')
      await s.io.remove(p)
      await s.io.remove(p)
      expect(await s.io.readText(p)).toBeNull()
      expect(await s.io.exists(p)).toBe(false)
    })

    test('list of a missing directory is missing', async () => {
      fresh()
      expect(await s.io.list(join(s.root, 'absent'))).toEqual({ ok: false, missing: true })
    })

    test('list reports files with size and time, and directories as dir', async () => {
      fresh()
      await s.io.writeText(join(s.root, 'd', 'f.txt'), 'abc')
      await s.io.writeText(join(s.root, 'd', 'sub', 'g.txt'), 'z')
      const l = await s.io.list(join(s.root, 'd'))
      if (!l.ok) throw new Error('expected a listing')
      const byName = Object.fromEntries(l.entries.map((e) => [e.name, e]))
      expect(byName['f.txt']).toMatchObject({ kind: 'file', size: 3 })
      expect(byName['f.txt']!.mtimeMs).toBeGreaterThan(0)
      expect(byName.sub).toMatchObject({ kind: 'dir' })
    })

    test.skipIf(isRoot)('an unreadable directory lists as not missing, and reading in it rejects', async () => {
      fresh()
      const locked = join(s.root, 'locked')
      await s.io.writeText(join(locked, 'f.txt'), 'x')
      s.makeUnreadable(locked)
      expect(await s.io.list(locked)).toEqual({ ok: false, missing: false })
      await expect(s.io.readText(join(locked, 'f.txt'))).rejects.toBeDefined()
    })

    test('exists sees files and directories', async () => {
      fresh()
      await s.io.writeText(join(s.root, 'e', 'f.txt'), 'x')
      expect(await s.io.exists(join(s.root, 'e'))).toBe(true)
      expect(await s.io.exists(join(s.root, 'e', 'f.txt'))).toBe(true)
      expect(await s.io.exists(join(s.root, 'e', 'g.txt'))).toBe(false)
    })

    test('sha256 is lowercase hex of the UTF-8 bytes', async () => {
      fresh()
      expect(await s.io.sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    })

    test('now is ISO 8601', () => {
      fresh()
      expect(Number.isNaN(Date.parse(s.io.now()))).toBe(false)
    })

    test('run returns exit code and stdout, and null for a program that does not exist', async () => {
      fresh()
      if (!s.canRun) return
      expect(await s.io.run(['sh', '-c', 'echo hi; exit 3'], s.root)).toEqual({ exitCode: 3, stdout: 'hi\n' })
      expect(await s.io.run(['cassandra-no-such-program-xyz'], s.root)).toBeNull()
    })
  })
}
