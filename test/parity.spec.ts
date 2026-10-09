import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { install, type ModEngine, type ToolCallEvent, type ToolCallOutcome } from '../mod/install.ts'
import type { Io } from '../src/core/io.ts'
import { handle } from '../src/hook.ts'
import { nodeIo } from '../src/io/node.ts'
import { nodeHost } from './support/node-host.ts'

const NOW = '2026-01-01T00:00:00.000Z'

/** One scripted step: a call and how it ended, or a compaction. */
type Step =
  | { call: string; tool?: string; input?: Record<string, unknown>; ends: 'fail' | 'ok' | 'deny' | 'interrupt'; agentId?: string; sessionId?: string }
  | { compact: true }
  | { touch: string }

const SCRIPT: Step[] = [
  { call: 'bun test', ends: 'fail' },
  { call: 'bun test', ends: 'fail' },
  { compact: true },
  { call: 'bun test', ends: 'fail', agentId: 'a1' },
  { call: 'bun test', ends: 'fail', sessionId: 's2' },
  { call: 'ignored', tool: 'mcp__srv__do', input: { b: 2, a: 1 }, ends: 'deny' },
  { call: 'ignored', tool: 'mcp__srv__do', input: { a: 1, b: 2 }, ends: 'deny' },
  { call: 'sleep 30', ends: 'interrupt' },
  { call: 'make', ends: 'fail' },
  { call: 'make', ends: 'ok' },
  { touch: 'b.txt' },
  { call: 'bun test', ends: 'fail' },
]

const scrub = (s: Record<string, string>): Record<string, string> => Object.fromEntries(Object.entries(s).map(([k, v]) => [k, v.replace(/"stateStamp":"[0-9a-f]{16}"/, '"stateStamp":"S"')]))

let tmp: string

beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'cass-parity-')) })
const realHome = process.env.HOME
afterEach(() => {
  delete process.env.CASSANDRA_HOME
  process.env.HOME = realHome
  rmSync(tmp, { recursive: true, force: true })
})

/**
 * A denied call cannot carry `context` in the mod (the deny arm of a `tool.call` result
 * has none), while the binary's PreToolUse line is printed before the denial. That is a
 * known, documented difference in delivery, not in what is recorded, so both runners say
 * `(deny)` for those steps and the store comparison still covers them.
 */
const DENY = '(deny)'

/** Every file under a data root, as relative path to content, with project slugs stripped. */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name)
      if (e.isDirectory()) walk(full)
      else if (!e.name.endsWith('.mod') && !relative(root, full).includes('pending')) out[relative(root, full).replace(/^[^/]+-[0-9a-f]{8}\//, 'P/')] = readFileSync(full, 'utf8')
    }
  }
  walk(root)
  return out
}

function repo(name: string): string {
  const dir = join(tmp, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'a.txt'), 'one')
  return dir
}

async function runBinary(cwd: string): Promise<string[]> {
  process.env.CASSANDRA_HOME = join(tmp, 'home-binary')
  // The core writes a data-root pointer under HOME; keep it out of the real home.
  process.env.HOME = tmp
  const io: Io = { ...nodeIo, now: () => NOW }
  const said: string[] = []
  let n = 0
  for (const step of SCRIPT) {
    if ('touch' in step) { writeFileSync(join(cwd, step.touch), 'x'); continue }
    if ('compact' in step) { await handle({ hook_event_name: 'PostCompact', session_id: 's1', cwd }, io); continue }
    const base = { session_id: step.sessionId ?? 's1', cwd, tool_name: step.tool ?? 'Bash', tool_input: step.input ?? { command: step.call }, tool_use_id: `t${(n += 1)}`, agent_id: step.agentId }
    const pre = await handle({ ...base, hook_event_name: 'PreToolUse' }, io)
    said.push(step.ends === 'deny' ? DENY : pre ? JSON.parse(pre).hookSpecificOutput.additionalContext : '')
    if (step.ends === 'ok') await handle({ ...base, hook_event_name: 'PostToolUse' }, io)
    if (step.ends === 'fail') await handle({ ...base, hook_event_name: 'PostToolUseFailure', error: 'Exit code 1\nboom' }, io)
    if (step.ends === 'deny') await handle({ ...base, hook_event_name: 'PermissionDenied', denial_reason: 'policy' }, io)
    if (step.ends === 'interrupt') await handle({ ...base, hook_event_name: 'PostToolUseFailure', is_interrupt: true }, io)
  }
  return said
}

async function runMod(cwd: string): Promise<string[]> {
  const opts = { sessionId: 's1', cwd, env: { CASSANDRA_HOME: join(tmp, 'home-mod'), HOME: tmp } }
  const host = nodeHost(opts) as ModEngine
  const hooks = new Map<string, (...a: unknown[]) => Promise<unknown>>()
  install(((event: string, a: unknown, b?: unknown) => { hooks.set(event, (b ?? a) as never) }) as never, (io) => ({ ...io, now: () => NOW }))
  const said: string[] = []
  let n = 0
  for (const step of SCRIPT) {
    if ('touch' in step) { writeFileSync(join(cwd, step.touch), 'x'); continue }
    if ('compact' in step) { await hooks.get('session.compact')!(host, {}, async () => ({ messages: [] })); continue }
    opts.sessionId = step.sessionId ?? 's1'
    const answer: ToolCallOutcome = step.ends === 'ok' ? { result: {}, text: '' }
      : step.ends === 'deny' ? { deny: 'policy' }
      : step.ends === 'interrupt' ? { isError: true, result: 'Interrupted', text: 'Interrupted' }
      : { isError: true, result: 'Exit code 1\nboom', text: 'Exit code 1\nboom' }
    const next = Object.assign(async () => answer, { signal: { aborted: step.ends === 'interrupt' } as AbortSignal })
    const e: ToolCallEvent = { tool: step.tool ?? 'Bash', tool_use_id: `t${(n += 1)}`, ...(step.input ?? { command: step.call }), ...(step.agentId ? { agentId: step.agentId } : {}) }
    const r = await hooks.get('tool.call')!(host, e, next) as ToolCallOutcome
    said.push(step.ends === 'deny' ? DENY : r.context?.at(-1) ?? '')
  }
  return said
}

test('the binary and the mod say the same things and leave the same store (mtime path)', async () => {
  const saidBinary = await runBinary(repo('one'))
  const saidMod = await runMod(repo('two'))
  expect(saidMod).toEqual(saidBinary)
  expect(saidBinary.filter(Boolean).length).toBeGreaterThan(0)
  expect(scrub(snapshot(join(tmp, 'home-mod')))).toEqual(scrub(snapshot(join(tmp, 'home-binary'))))
})

test('the same holds on the git path', async () => {
  const init = (dir: string): string => {
    for (const a of [['init', '-q'], ['config', 'user.email', 't@e.com'], ['config', 'user.name', 'T'], ['add', '-A'], ['commit', '-qm', 'init', '--date', '2026-01-01T00:00:00Z']]) {
      Bun.spawnSync(['git', '-C', dir, ...a], { stdout: 'ignore', stderr: 'ignore', env: { ...process.env, GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' } })
    }
    return dir
  }
  const saidBinary = await runBinary(init(repo('g1')))
  const saidMod = await runMod(init(repo('g2')))
  expect(saidMod).toEqual(saidBinary)
  expect(scrub(snapshot(join(tmp, 'home-mod')))).toEqual(scrub(snapshot(join(tmp, 'home-binary'))))
})
