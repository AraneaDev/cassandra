import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ModHost } from '../../src/io/mod.ts'

/** Options for the node-backed stand-in of the engine's `$`. Read live, so a test may change them mid-run. */
export interface NodeHostOptions {
  sessionId?: string
  cwd?: string
  env?: Record<string, string | undefined>
  /** Rows the mod appended with `$.session.append`, recorded in order. */
  appended?: Array<{ agentId?: string; text: string }>
  /** Make `$.session.append` reject, as the engine does for a loop that is not running. */
  appendRejects?: boolean
  /** Make `$.session.append` resolve `{ deny }` with this reason, as when a plugin above refuses the row. */
  appendDenies?: string
}

/** The slice of `$` the mod uses beyond `ModHost`. */
export type NodeHost = ModHost & {
  session: {
    id(): Promise<string>
    cwd(): Promise<string>
    append(args: { message: { content: Array<{ text: string }> }; agentId?: string }): Promise<{ deny?: string }>
  }
}

/**
 * A stand-in for the engine's `$`, backed by the real filesystem, so the mod's I/O and
 * hooks run under `bun test` and in CI. It follows the engine's documented behaviour:
 * read and stat reject when missing, write creates parent directories, list rejects on
 * any error and reports whole-millisecond times, and run takes stdin and a cwd.
 */
export function nodeHost(opts: NodeHostOptions = {}): NodeHost {
  return {
    fs: {
      async read(path) {
        return readFileSync(path, 'utf8')
      },
      async write(path, text) {
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, text)
      },
      async list(path) {
        return readdirSync(path, { withFileTypes: true }).map((d) => {
          if (d.isDirectory()) return { name: d.name, kind: 'dir' as const, size: 0, mtimeMs: 0 }
          if (!d.isFile()) return { name: d.name, kind: 'other' as const, size: 0, mtimeMs: 0 }
          const st = statSync(join(path, d.name))
          return { name: d.name, kind: 'file' as const, size: st.size, mtimeMs: Math.floor(st.mtimeMs) }
        })
      },
      async exists(path) {
        return existsSync(path)
      },
      async stat(path) {
        const st = statSync(path)
        return { kind: st.isDirectory() ? 'dir' as const : st.isFile() ? 'file' as const : 'other' as const }
      },
    },
    process: {
      async run(argv, init = {}) {
        const r = Bun.spawnSync([...argv], {
          cwd: init.cwd,
          stdin: init.stdin === undefined ? 'ignore' : Buffer.from(init.stdin),
          stdout: 'pipe',
          stderr: 'ignore',
        })
        if (r.exitCode === null) throw new Error('did not finish')
        return { exitCode: r.exitCode, stdout: r.stdout.toString() }
      },
    },
    env: {
      async get(name) {
        return opts.env ? opts.env[name] : process.env[name]
      },
    },
    session: {
      async id() {
        return opts.sessionId ?? 's1'
      },
      async cwd() {
        return opts.cwd ?? process.cwd()
      },
      async append(args) {
        if (opts.appendRejects) throw new Error('no running loop')
        if (opts.appendDenies !== undefined) return { deny: opts.appendDenies }
        ;(opts.appended ??= []).push({ agentId: args.agentId, text: args.message.content.map((c) => c.text).join('') })
        return {}
      },
    },
  }
}
