import { afterEach, beforeEach, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const wrapper = join(import.meta.dir, '..', 'hooks', 'scripts', 'hook.sh')
let root: string

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'cass-wrap-')) })
afterEach(() => rmSync(root, { recursive: true, force: true }))

const run = (input: string) => {
  const r = Bun.spawnSync(['sh', wrapper], { stdin: new TextEncoder().encode(input), env: { ...process.env, CLAUDE_PLUGIN_ROOT: root } })
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() }
}

test('every command hook in hooks.json goes through the wrapper, none straight at the binary', () => {
  const manifest = readFileSync(join(import.meta.dir, '..', 'hooks', 'hooks.json'), 'utf8')
  expect(manifest).not.toContain('bin/cassandra-hook')
  expect(manifest.match(/hooks\/scripts\/hook\.sh/g)?.length ?? 0).toBeGreaterThan(0)
})

test('with no binary built, the wrapper reads the event and leaves quietly', () => {
  expect(run('{"hook_event_name":"PreToolUse"}')).toEqual({ code: 0, out: '', err: '' })
})

test('with the binary built, the wrapper hands it the event and returns what it says', () => {
  mkdirSync(join(root, 'bin'))
  const bin = join(root, 'bin', 'cassandra-hook')
  writeFileSync(bin, '#!/bin/sh\nprintf "got:"; cat\n')
  chmodSync(bin, 0o755)
  expect(run('{"x":1}')).toEqual({ code: 0, out: 'got:{"x":1}', err: '' })
})
