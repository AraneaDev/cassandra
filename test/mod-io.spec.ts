import { afterEach, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { settle } from '../src/core/engine.ts'
import { modIo, type ModHost } from '../src/io/mod.ts'
import { nodeHost } from './support/node-host.ts'

const roots: string[] = []
const tmp = (): string => {
  const r = mkdtempSync(join(tmpdir(), 'cass-mod-io-'))
  roots.push(r)
  return r
}
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

/** A node-backed host that logs every command it runs, and can refuse `chmod`. */
function logged(env: Record<string, string>, refuseChmod = false): { host: ModHost; ran: string[][] } {
  const base = nodeHost({ env })
  const ran: string[][] = []
  const host: ModHost = {
    ...base,
    process: {
      run: async (argv, init) => {
        ran.push([...argv])
        if (refuseChmod && argv[0] === 'chmod') throw new Error('not allowed')
        return base.process.run(argv, init)
      },
    },
  }
  return { host, ran }
}

test('the mod makes the data root owner-only with one chmod, whatever was in it before', async () => {
  const home = join(tmp(), 'home')
  mkdirSync(join(home, 'old'), { recursive: true, mode: 0o755 })
  chmodSync(home, 0o755)
  writeFileSync(join(home, 'old', 'record.json'), '{}', { mode: 0o644 })
  const work = tmp()
  writeFileSync(join(work, 'a.txt'), 'one')
  const { host, ran } = logged({ CLAUDE_PLUGIN_DATA: home, HOME: tmp() })
  const call = { tool: 'Bash', input: { command: 'bun test' }, cwd: work, sessionId: 's1' }
  expect(await settle(modIo(host), call, { kind: 'failure', reason: 'boom' }, null)).toBe(true)
  expect(statSync(home).mode & 0o777).toBe(0o700)
  // A second failure, through a fresh io as the mod builds one per call, chmods nothing more.
  await settle(modIo(host), call, { kind: 'failure', reason: 'boom' }, null)
  expect(ran.filter((a) => a[0] === 'chmod')).toEqual([['chmod', '700', '--', home]])
})

test('a chmod the host refuses does not stop the record being written', async () => {
  const home = join(tmp(), 'home')
  const work = tmp()
  writeFileSync(join(work, 'a.txt'), 'one')
  const { host, ran } = logged({ CLAUDE_PLUGIN_DATA: home, HOME: tmp() }, true)
  expect(await settle(modIo(host), { tool: 'Bash', input: { command: 'npm test' }, cwd: work, sessionId: 's1' }, { kind: 'failure', reason: 'boom' }, null)).toBe(true)
  expect(ran.some((a) => a[0] === 'chmod')).toBe(true)
  expect(ran.some((a) => a[0] === 'mv')).toBe(true)
})
