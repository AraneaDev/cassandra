import type { Entry, EnvName, Io, RunResult } from '../core/io.ts'
import { dirname } from '../core/path.ts'

/** How long any one helper process may take before the call counts as failed. */
const RUN_TIMEOUT_MS = 5000

/**
 * The slice of Claude Code's `$` the core needs, typed structurally.
 *
 * Typing it here rather than importing `claude-code` lets this file, and everything that
 * uses it, typecheck and run under `bun test` in CI, where the engine's types do not
 * exist. The real `$` satisfies it as is; `mod/index.ts` is where that is checked.
 */
export interface ModHost {
  fs: {
    read(path: string): Promise<string>
    write(path: string, text: string): Promise<void>
    list(path: string): Promise<ReadonlyArray<{ name: string; kind: 'file' | 'dir' | 'other'; size: number; mtimeMs: number }>>
    exists(path: string): Promise<boolean>
    stat(path: string): Promise<{ kind: 'file' | 'dir' | 'other' }>
  }
  process: {
    run(argv: readonly string[], init?: { cwd?: string; stdin?: string; timeoutMs?: number }): Promise<{ exitCode: number; stdout: string }>
  }
  env: {
    get(name: string): Promise<string | undefined>
  }
}

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * The `Io` the mod runs on.
 *
 * `$.fs` reads, writes, lists and stats, and nothing more: there is no remove, rename or
 * append, and its rejections carry no error code. So an atomic replace writes a staging
 * file and moves it into place with `mv`; append and remove shell out; and "missing or
 * unreadable" for a failed listing is decided by asking whether the directory exists.
 * Every one of those subprocesses sits on a rare path (a failure, a warning, a forget),
 * never on the hot miss path, which is one hash and one read.
 */
export function modIo($: ModHost): Io {
  const run = async (argv: readonly string[], cwd: string, stdin?: string): Promise<RunResult | null> => {
    try {
      const r = await $.process.run(argv, { cwd, stdin, timeoutMs: RUN_TIMEOUT_MS })
      return { exitCode: r.exitCode, stdout: r.stdout }
    } catch {
      return null
    }
  }
  const must = (r: RunResult | null, what: string): void => {
    if (!r || r.exitCode !== 0) throw new Error(`cassandra: ${what}`)
  }

  // `$.fs.exists` is false for a file behind an unreadable directory, so a file is only
  // missing when it is absent and its parent is absent or listable.
  const confirmedMissing = async (path: string): Promise<boolean> => {
    if (await $.fs.exists(path)) return false
    const parent = dirname(path)
    if (!(await $.fs.exists(parent))) return true
    try {
      await $.fs.list(parent)
      return true
    } catch {
      return false
    }
  }

  return {
    async readText(path) {
      try {
        return await $.fs.read(path)
      } catch (err) {
        if (await confirmedMissing(path)) return null
        throw err
      }
    },
    async writeText(path, text) {
      const staging = `${path}.${Math.random().toString(36).slice(2)}.tmp`
      try {
        await $.fs.write(staging, text)
      } catch (err) {
        // The host write is not atomic: a rejection can still leave part of the file.
        await run(['rm', '-f', '--', staging], '/')
        throw err
      }
      const moved = await run(['mv', '-f', '--', staging, path], '/')
      if (!moved || moved.exitCode !== 0) {
        await run(['rm', '-f', '--', staging], '/')
        must(moved, `could not move ${staging} into place`)
      }
    },
    async appendText(path, text) {
      must(await run(['sh', '-c', 'mkdir -p -- "$(dirname -- "$1")" && cat >> "$1"', 'sh', path], '/', text), `could not append to ${path}`)
    },
    async remove(path) {
      must(await run(['rm', '-f', '--', path], '/'), `could not remove ${path}`)
    },
    async list(dir) {
      try {
        const entries: Entry[] = (await $.fs.list(dir)).map((e) => ({ name: e.name, kind: e.kind, size: e.size, mtimeMs: e.mtimeMs }))
        return { ok: true, entries }
      } catch {
        let missing: boolean
        try {
          missing = !(await $.fs.exists(dir)) || (await $.fs.stat(dir)).kind !== 'dir'
        } catch {
          missing = false
        }
        return { ok: false, missing }
      }
    },
    exists(path) {
      return $.fs.exists(path)
    },
    run(argv, cwd) {
      return run(argv, cwd)
    },
    async sha256(text) {
      return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
    },
    async env(name: EnvName) {
      // `$.env.get` takes string literals only, so each name is spelled out.
      switch (name) {
        case 'CASSANDRA_HOME': return $.env.get('CASSANDRA_HOME')
        case 'CLAUDE_PLUGIN_DATA': return $.env.get('CLAUDE_PLUGIN_DATA')
        case 'HOME': return $.env.get('HOME')
      }
    },
    async homeDir() {
      return ''
    },
    now() {
      return new Date().toISOString()
    },
  }
}
