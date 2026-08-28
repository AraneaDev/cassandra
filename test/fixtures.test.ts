import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { handle } from '../src/hook'
import type { HookPayload } from '../src/types'

let cassandraHome: string
let cwd: string

beforeEach(() => {
  cassandraHome = mkdtempSync(join(tmpdir(), 'cass-home-'))
  cwd = mkdtempSync(join(tmpdir(), 'cass-cwd-'))
  process.env.CASSANDRA_HOME = cassandraHome
})

afterEach(() => {
  delete process.env.CASSANDRA_HOME
  rmSync(cassandraHome, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
})

function payloads(): HookPayload[] {
  return JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'payloads.json'), 'utf8'))
}

/**
 * The harvest only finds payloads on a machine that has actually run Claude Code.
 * `make-fixtures` says so itself and falls back to a small synthetic set elsewhere, so on
 * a clean checkout, CI included, there is no captured payload to assert anything about.
 *
 * The two tests below therefore skip rather than fail there. Lowering their floors to
 * whatever the synthetic set happens to contain would make them green everywhere while no
 * longer catching what they exist for: a payload set that quietly stops producing
 * warnings. They keep their full strength on a machine that has the transcripts.
 */
const hasHarvest = payloads().filter((p) => p.session_id === 'harvested').length > 4

test('every real payload is handled without throwing', () => {
  for (const p of payloads()) {
    expect(() => handle({ ...p, cwd })).not.toThrow()
  }
})

test.skipIf(!hasHarvest)('replayed payloads emit warnings with the documented shape', () => {
  const all = payloads()
  const harvested = all.filter((p) => p.session_id === 'harvested')
  const toReplay = harvested.slice(0, Math.min(100, harvested.length))

  let warningsEmitted = 0
  let replayed = 0

  for (const payload of toReplay) {
    if (!payload.tool_name) continue
    if (payload.tool_name !== 'Bash' && !payload.tool_name.startsWith('mcp__')) continue
    if (!payload.tool_input) continue
    replayed += 1

    // First: simulate a failure to create a record
    handle({
      hook_event_name: 'PostToolUseFailure',
      session_id: payload.session_id,
      cwd,
      tool_name: payload.tool_name,
      tool_input: payload.tool_input,
      tool_use_id: payload.tool_use_id,
      error_message: 'simulated failure for replay',
    })

    // Second: replay the same tool call as PreToolUse
    const out = handle({ ...payload, cwd })
    if (out !== null) {
      warningsEmitted++
      expect(() => JSON.parse(out)).not.toThrow()
      const parsed = JSON.parse(out)
      expect(parsed.hookSpecificOutput.hookEventName).toBe('PreToolUse')
      expect(typeof parsed.hookSpecificOutput.additionalContext).toBe('string')
    }
  }

  // A bare `> 0` tolerated 99 of 100 payloads silently ceasing to warn, which is the
  // regression this test exists to catch. The floor is proportional instead. It is not a
  // strict equality because a payload can legitimately produce no fingerprint, for
  // instance a Bash call whose command is absent or entirely whitespace. Measured today:
  // every replayed payload warns.
  expect(replayed).toBeGreaterThan(20)
  expect(warningsEmitted / replayed).toBeGreaterThanOrEqual(0.9)
})

test.skipIf(!hasHarvest)('harvested payloads include Bash calls beyond the synthetic set', () => {
  const all = payloads()
  const harvested = all.filter((p) => p.session_id === 'harvested')
  const harvestedBash = harvested.filter((p) => p.tool_name === 'Bash')

  expect(harvested.length).toBeGreaterThan(4)
  expect(harvestedBash.length).toBeGreaterThan(0)
})
