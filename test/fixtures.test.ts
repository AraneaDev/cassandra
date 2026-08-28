import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { handle } from '../src/hook'
import type { HookPayload } from '../src/types'

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cass-fix-'))
  process.env.CASSANDRA_HOME = join(tmp, 'home')
})

afterEach(() => {
  delete process.env.CASSANDRA_HOME
  rmSync(tmp, { recursive: true, force: true })
})

function payloads(): HookPayload[] {
  return JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'payloads.json'), 'utf8'))
}

test('every real payload is handled without throwing', () => {
  for (const p of payloads()) {
    expect(() => handle({ ...p, cwd: tmp })).not.toThrow()
  }
})

test('every real payload either stays silent or emits the documented shape', () => {
  for (const p of payloads()) {
    const out = handle({ ...p, cwd: tmp })
    if (out === null) continue
    expect(() => JSON.parse(out)).not.toThrow()
    expect(JSON.parse(out).hookSpecificOutput.hookEventName).toBe('PreToolUse')
  }
})

test('the fixture set contains Bash calls, not only MCP ones', () => {
  const all = payloads()
  expect(all.length).toBeGreaterThanOrEqual(4)
  expect(all.filter((p) => p.tool_name === 'Bash').length).toBeGreaterThan(0)
})
