import { createHash } from 'node:crypto'
import type { Entry, Io, RunResult } from '../../src/core/io.ts'
import { basename, dirname, normalize } from '../../src/core/path.ts'

/** An `Io` held entirely in memory, with knobs a test can turn. */
export interface MemoryIo extends Io {
  /** Paths that exist but cannot be read: a read rejects, a listing reports not-missing. */
  unreadable: Set<string>
  /** What `run` answers for an argv. */
  script: (argv: readonly string[]) => RunResult | null
  /** What `now` answers. */
  clock: { now: string }
}

/** A fresh, empty in-memory filesystem rooted at `/`. */
export function memoryIo(): MemoryIo {
  const files = new Map<string, { text: string; mtimeMs: number }>()
  const dirs = new Set<string>(['/'])
  const unreadable = new Set<string>()
  let tick = 1_700_000_000_000

  const addParents = (path: string): void => {
    for (let d = dirname(path); !dirs.has(d); d = dirname(d)) dirs.add(d)
  }
  const deny = (path: string): void => {
    if (unreadable.has(path) || unreadable.has(dirname(path))) throw new Error(`EACCES: ${path}`)
  }

  const io: MemoryIo = {
    unreadable,
    script: () => null,
    clock: { now: '2026-01-01T00:00:00.000Z' },
    async readText(path) {
      const p = normalize(path)
      deny(p)
      return files.get(p)?.text ?? null
    },
    async writeText(path, text) {
      const p = normalize(path)
      deny(p)
      addParents(p)
      files.set(p, { text, mtimeMs: (tick += 1) })
    },
    async appendText(path, text) {
      const p = normalize(path)
      deny(p)
      addParents(p)
      files.set(p, { text: (files.get(p)?.text ?? '') + text, mtimeMs: (tick += 1) })
    },
    async remove(path) {
      const p = normalize(path)
      deny(p)
      files.delete(p)
    },
    async list(dir) {
      const d = normalize(dir)
      if (unreadable.has(d)) return { ok: false, missing: false }
      if (!dirs.has(d)) return { ok: false, missing: true }
      const entries: Entry[] = []
      for (const [p, f] of files) {
        if (dirname(p) === d) entries.push({ name: basename(p), kind: 'file', size: new TextEncoder().encode(f.text).length, mtimeMs: f.mtimeMs })
      }
      for (const sub of dirs) {
        if (sub !== d && dirname(sub) === d) entries.push({ name: basename(sub), kind: 'dir', size: 0, mtimeMs: 0 })
      }
      return { ok: true, entries }
    },
    async exists(path) {
      const p = normalize(path)
      return files.has(p) || dirs.has(p)
    },
    async run(argv) {
      return io.script(argv)
    },
    async sha256(text) {
      return createHash('sha256').update(text).digest('hex')
    },
    async env() {
      return undefined
    },
    async homeDir() {
      return '/home/test'
    },
    now() {
      return io.clock.now
    },
  }
  return io
}
