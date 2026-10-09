import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, existsSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const SCRIPT = join(import.meta.dir, '..', 'hooks', 'scripts', 'session-start.sh')
const TOOLS = ['cat', 'sed', 'tr', 'cut', 'mkdir', 'mv', 'rm']
let tmp: string
let bin: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cass-start-'))
  // A PATH that holds only the tools the script needs, so bun is never found
  // however this machine happens to be set up.
  bin = join(tmp, 'bin')
  mkdirSync(bin)
  for (const t of TOOLS) {
    const real = Bun.which(t)
    if (real) symlinkSync(real, join(bin, t))
  }
  mkdirSync(join(tmp, 'plugin'), { recursive: true })
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

function start(sessionId: string, env: Record<string, string>): string {
  const r = Bun.spawnSync([Bun.which('sh') ?? '/bin/sh', SCRIPT], {
    stdin: Buffer.from(JSON.stringify({ session_id: sessionId, hook_event_name: 'SessionStart' })),
    env: { PATH: bin, HOME: tmp, CLAUDE_PLUGIN_ROOT: join(tmp, 'plugin'), ...env },
    stdout: 'pipe', stderr: 'ignore',
  })
  return r.stdout.toString()
}

const pointer = () => join(tmp, '.cassandra', 'data-root')

test('a session the mod has claimed starts silently, even with no binary and no bun', () => {
  mkdirSync(join(tmp, 'data', 'sessions'), { recursive: true })
  writeFileSync(join(tmp, 'data', 'sessions', 'abc.mod'), 'x')
  expect(start('abc', { CLAUDE_PLUGIN_DATA: join(tmp, 'data') })).toBe('')
})

test('an unclaimed session with no bun says the classic path is inert, and mentions the mod', () => {
  const out = start('abc', { CLAUDE_PLUGIN_DATA: join(tmp, 'data') })
  expect(out).toContain('bun was not found')
  expect(out).toContain('in-process mod')
})

test('a hostile session id cannot point the marker check outside the sessions directory', () => {
  writeFileSync(join(tmp, 'escape.mod'), 'x')
  expect(start('../../escape', { CLAUDE_PLUGIN_DATA: join(tmp, 'data') })).toContain('bun was not found')
})

test('the data root is left as a pointer for the mod, which cannot see CLAUDE_PLUGIN_DATA', () => {
  start('abc', { CLAUDE_PLUGIN_DATA: join(tmp, 'data') })
  expect(readFileSync(pointer(), 'utf8')).toBe(join(tmp, 'data'))
  // A second run with the same value leaves it as it was.
  start('abc', { CLAUDE_PLUGIN_DATA: join(tmp, 'data') })
  expect(readFileSync(pointer(), 'utf8')).toBe(join(tmp, 'data'))
})

test('an explicit CASSANDRA_HOME writes no pointer', () => {
  start('abc', { CASSANDRA_HOME: join(tmp, 'home'), CLAUDE_PLUGIN_DATA: join(tmp, 'data') })
  expect(existsSync(pointer())).toBe(false)
})

test('a pointer to a missing or relative directory is ignored, as dataRoot ignores it', () => {
  mkdirSync(join(tmp, '.cassandra', 'sessions'), { recursive: true })
  writeFileSync(join(tmp, '.cassandra', 'sessions', 'abc.mod'), 'x')
  for (const stale of [join(tmp, 'gone'), 'relative/dir']) {
    writeFileSync(pointer(), stale)
    expect(start('abc', {})).toBe('')
  }
})
