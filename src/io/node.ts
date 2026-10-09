import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Entry, Io, Listing } from '../core/io.ts'

/**
 * Distinguishes a path that is genuinely gone from one that could not be read for some
 * other reason. Only `ENOENT` and `ENOTDIR` mean gone. Every other code, most importantly
 * `EACCES`/`EPERM`, means the content is still there but invisible, and must not be
 * treated the same as absence.
 */
export function isMissingSubtree(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

function listSync(dir: string): Listing {
  let dirents
  try {
    dirents = readdirSync(dir, { withFileTypes: true })
  } catch (err) {
    return { ok: false, missing: isMissingSubtree(err) }
  }
  const entries: Entry[] = []
  for (const d of dirents) {
    if (d.isDirectory()) {
      entries.push({ name: d.name, kind: 'dir', size: 0, mtimeMs: 0 })
      continue
    }
    if (!d.isFile()) {
      entries.push({ name: d.name, kind: 'other', size: 0, mtimeMs: 0 })
      continue
    }
    try {
      const st = statSync(join(dir, d.name))
      entries.push({ name: d.name, kind: 'file', size: st.size, mtimeMs: st.mtimeMs })
    } catch {
      // A file that vanished mid-listing simply does not appear.
    }
  }
  return { ok: true, entries }
}

/**
 * The `Io` the binary and the CLI run on.
 *
 * `writeText` stages to a temp file in the same directory and renames it into place,
 * which POSIX guarantees atomic within a filesystem: Claude Code runs Bash calls in
 * parallel, and a concurrent reader that saw a half-written record would judge it
 * corrupt and delete it. The staging name carries the pid and a random suffix so two
 * writers cannot collide, and ends in `.tmp` so the record listing never reads one.
 */
export const nodeIo: Io = {
  async readText(path) {
    try {
      return readFileSync(path, 'utf8')
    } catch (err) {
      if (isMissingSubtree(err)) return null
      throw err
    }
  },
  async writeText(path, text) {
    mkdirSync(dirname(path), { recursive: true })
    const staging = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
    try {
      writeFileSync(staging, text)
      renameSync(staging, path)
    } catch (err) {
      try {
        rmSync(staging, { force: true })
      } catch {
        // Nothing further to try.
      }
      throw err
    }
  },
  async appendText(path, text) {
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, text)
  },
  async remove(path) {
    rmSync(path, { force: true })
  },
  async list(dir) {
    return listSync(dir)
  },
  async exists(path) {
    return existsSync(path)
  },
  async run(argv, cwd) {
    try {
      const r = Bun.spawnSync([...argv], { cwd, stdout: 'pipe', stderr: 'ignore' })
      return { exitCode: r.exitCode ?? 1, stdout: r.stdout.toString() }
    } catch {
      return null
    }
  },
  async sha256(text) {
    return createHash('sha256').update(text).digest('hex')
  },
  async env(name) {
    return process.env[name]
  },
  async homeDir() {
    return homedir()
  },
  now() {
    return new Date().toISOString()
  },
}
