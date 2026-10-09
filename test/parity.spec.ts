import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { install, type ModEngine, type ToolCallEvent, type ToolCallOutcome } from '../mod/install.ts'
import type { Io } from '../src/core/io.ts'
import { handle } from '../src/hook.ts'
import { nodeIo } from '../src/io/node.ts'
import { nodeHost } from './support/node-host.ts'

const NOW = '2026-01-01T00:00:00.000Z'

/**
 * One scripted step: a call and how it ended, or a compaction. `postDir` is where the
 * binary's outcome payload says the shell ended up, as after a `cd` in the command; the
 * mod reads the directory before the call and never sees it.
 */
type Step =
  | { call: string; tool?: string; input?: Record<string, unknown>; ends: 'fail' | 'ok' | 'deny' | 'interrupt'; agentId?: string; sessionId?: string; dir?: string; postDir?: string }
  | { compact: true }
  | { spawn: string }
  | { touch: string; text?: string }
  | { remove: string }

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
  { spawn: 'general-purpose' },
  { spawn: 'fork' },
  { compact: true },
  { call: 'lint check', ends: 'fail' },
  { touch: 'fix.txt' },
  { call: 'lint check', ends: 'ok' },
  { remove: 'fix.txt' },
  { call: 'lint check', ends: 'fail' },
  { call: 'lint check', ends: 'fail' },
]

// Stamps differ by design: the binary sees fractional file times and adds a coarse hash.
const scrub = (s: Record<string, string>): Record<string, string> => Object.fromEntries(Object.entries(s).map(([k, v]) => [k, v.replace(/"stateStamp":"[0-9a-f]{16}"/g, '"stateStamp":"S"').replace(/,"stateCoarse":"[0-9a-f]{16}"/g, '')]))


function expectNonTrivial(said: string[], store: Record<string, string>): void {
  const keys = Object.keys(store)
  expect(keys.length).toBeGreaterThan(0)
  expect(keys.some((k) => k.startsWith('P/records/'))).toBe(true)
  expect(keys).toContain('P/stats.jsonl')
  expect(said.some((s) => s.startsWith('cassandra: '))).toBe(true)
  expect(said.some((s) => s.startsWith('cassandra: these calls failed earlier in this project'))).toBe(true)
  expect(store['P/stats.jsonl']).toContain('"kind":"briefed"')
}

let tmp: string

beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'cass-parity-')) })
const realHome = process.env.HOME
afterEach(() => {
  delete process.env.CASSANDRA_HOME
  if (realHome === undefined) delete process.env.HOME
  else process.env.HOME = realHome
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
      else if (!e.name.endsWith('.mod') && !relative(root, full).split('/').includes('pending')) out[relative(root, full).replace(/^[^/]+-[0-9a-f]{8}\//, 'P/')] = readFileSync(full, 'utf8')
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

async function runBinary(cwd: string, script: Step[] = SCRIPT): Promise<string[]> {
  process.env.CASSANDRA_HOME = join(tmp, 'home-binary')
  // The core writes a data-root pointer under HOME; keep it out of the real home.
  process.env.HOME = tmp
  const io: Io = { ...nodeIo, now: () => NOW }
  const said: string[] = []
  let n = 0
  for (const step of script) {
    if ('touch' in step) { writeFileSync(join(cwd, step.touch), step.text ?? 'x'); continue }
    if ('remove' in step) { rmSync(join(cwd, step.remove), { force: true }); continue }
    if ('compact' in step) {
      await handle({ hook_event_name: 'PostCompact', session_id: 's1', cwd }, io)
      const note = await handle({ hook_event_name: 'SessionStart', session_id: 's1', cwd, source: 'compact' }, io)
      said.push(note ? JSON.parse(note).hookSpecificOutput.additionalContext : '')
      continue
    }
    if ('spawn' in step) {
      const note = await handle({ hook_event_name: 'SubagentStart', session_id: 's1', cwd, agent_id: 'sub-1', agent_type: step.spawn }, io)
      said.push(note ? JSON.parse(note).hookSpecificOutput.additionalContext : '')
      continue
    }
    const base = { session_id: step.sessionId ?? 's1', cwd: step.dir ? join(cwd, step.dir) : cwd, tool_name: step.tool ?? 'Bash', tool_input: step.input ?? { command: step.call }, tool_use_id: `t${(n += 1)}`, agent_id: step.agentId }
    const pre = await handle({ ...base, hook_event_name: 'PreToolUse' }, io)
    said.push(step.ends === 'deny' ? DENY : pre ? JSON.parse(pre).hookSpecificOutput.additionalContext : '')
    const post = step.postDir ? { ...base, cwd: join(cwd, step.postDir) } : base
    if (step.ends === 'ok') await handle({ ...post, hook_event_name: 'PostToolUse' }, io)
    if (step.ends === 'fail') await handle({ ...post, hook_event_name: 'PostToolUseFailure', error: 'Exit code 1\nboom' }, io)
    if (step.ends === 'deny') await handle({ ...post, hook_event_name: 'PermissionDenied', denial_reason: 'policy' }, io)
    if (step.ends === 'interrupt') await handle({ ...post, hook_event_name: 'PostToolUseFailure', is_interrupt: true }, io)
  }
  return said
}

async function runMod(cwd: string, script: Step[] = SCRIPT): Promise<string[]> {
  const opts: { sessionId: string; cwd: string; env: Record<string, string>; appended?: Array<{ agentId?: string; text: string }> } = { sessionId: 's1', cwd, env: { CASSANDRA_HOME: join(tmp, 'home-mod'), HOME: tmp } }
  const host = nodeHost(opts) as ModEngine
  const hooks = new Map<string, (...a: unknown[]) => Promise<unknown>>()
  install(((event: string, a: unknown, b?: unknown) => { hooks.set(event, (b ?? a) as never) }) as never, (io) => ({ ...io, now: () => NOW }))
  const said: string[] = []
  let n = 0
  for (const step of script) {
    if ('touch' in step) { writeFileSync(join(cwd, step.touch), step.text ?? 'x'); continue }
    if ('remove' in step) { rmSync(join(cwd, step.remove), { force: true }); continue }
    if ('compact' in step || 'spawn' in step) {
      opts.cwd = cwd
      const before = opts.appended?.length ?? 0
      const flush = (row: Record<string, unknown>) => hooks.get('session.append')!(host, { ...row, uuid: `u-${(n += 1)}` }, async () => ({}))
      if ('compact' in step) {
        await hooks.get('session.compact')!(host, {}, async () => ({ messages: [] }))
        await flush({ door: 'notice', origin: { kind: 'engine' }, message: { type: 'system', content: [] } })
      } else {
        await hooks.get('agent.spawn')!(host, { subagentType: step.spawn }, async () => ({ model: 'm', agentId: 'sub-1' }))
        await flush({ door: 'tool-result', origin: { kind: 'tool' }, agentId: 'sub-1', message: { type: 'user', content: [] } })
      }
      said.push((opts.appended ?? []).slice(before).map((a) => a.text).join('\n'))
      continue
    }
    opts.sessionId = step.sessionId ?? 's1'
    opts.cwd = step.dir ? join(cwd, step.dir) : cwd
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
  expectNonTrivial(saidBinary, snapshot(join(tmp, 'home-binary')))
  expectNonTrivial(saidMod, snapshot(join(tmp, 'home-mod')))
  for (const said of [saidBinary, saidMod]) expect(said.some((l) => l.includes('Last time this started working'))).toBe(false)
  for (const home of ['home-binary', 'home-mod']) expect(Object.keys(snapshot(join(tmp, home))).some((k) => k.startsWith('P/fixes/'))).toBe(false)
})

test('the same holds on the git path', async () => {
  const init = (dir: string): string => {
    for (const a of [['init', '-q'], ['config', 'user.email', 't@e.com'], ['config', 'user.name', 'T'], ['add', '-A'], ['commit', '-qm', 'init', '--date', '2026-01-01T00:00:00Z']]) {
      const r = Bun.spawnSync(['git', '-C', dir, ...a], { stdout: 'ignore', stderr: 'ignore', env: { ...process.env, GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' } })
      expect(r.exitCode).toBe(0)
    }
    expect(existsSync(join(dir, '.git'))).toBe(true)
    expect(Bun.spawnSync(['git', '-C', dir, 'rev-parse', 'HEAD'], { stdout: 'ignore', stderr: 'ignore' }).exitCode).toBe(0)
    return dir
  }
  const saidBinary = await runBinary(init(repo('g1')))
  const saidMod = await runMod(init(repo('g2')))
  expect(saidMod).toEqual(saidBinary)
  expect(scrub(snapshot(join(tmp, 'home-mod')))).toEqual(scrub(snapshot(join(tmp, 'home-binary'))))
  for (const [said, home] of [[saidBinary, 'home-binary'], [saidMod, 'home-mod']] as const) {
    expectNonTrivial(said, snapshot(join(tmp, home)))
    expect(said.some((l) => l.includes('Last time this started working after'))).toBe(true)
    expect(Object.keys(snapshot(join(tmp, home))).some((k) => k.startsWith('P/fixes/'))).toBe(true)
  }
})

/** An edit to a file that was already dirty when the call failed. */
const DIRTY_EDIT: Step[] = [
  { touch: 'd.txt', text: 'before' },
  { call: 'build', ends: 'fail' },
  { touch: 'd.txt', text: 'after' },
  { call: 'build', ends: 'ok' },
  { call: 'build', ends: 'fail' },
  { call: 'build', ends: 'fail' },
]

test('on the git path both front ends store the same dirtyHashes, and name an edit to an already-dirty file', async () => {
  const init = (dir: string): string => {
    for (const a of [['init', '-q'], ['config', 'user.email', 't@e.com'], ['config', 'user.name', 'T'], ['add', '-A'], ['commit', '-qm', 'init', '--date', '2026-01-01T00:00:00Z']]) {
      expect(Bun.spawnSync(['git', '-C', dir, ...a], { stdout: 'ignore', stderr: 'ignore', env: { ...process.env, GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' } }).exitCode).toBe(0)
    }
    return dir
  }
  const saidBinary = await runBinary(init(repo('h1')), DIRTY_EDIT)
  const saidMod = await runMod(init(repo('h2')), DIRTY_EDIT)
  expect(saidMod).toEqual(saidBinary)
  expect(saidBinary.at(-1)).toContain('Last time this started working after `d.txt` changed')
  const want = { 'd.txt': (await nodeIo.sha256('after')).slice(0, 16) }
  for (const home of ['home-binary', 'home-mod']) {
    const store = snapshot(join(tmp, home))
    const records = Object.entries(store).filter(([k]) => k.startsWith('P/records/')).map(([, v]) => JSON.parse(v) as { dirtyHashes?: Record<string, string> })
    expect(records.map((r) => r.dirtyHashes)).toEqual([want])
    // The scrub masks stamps only, so a dirtyHashes difference would still fail the comparison below.
    expect(Object.values(scrub(store)).some((v) => v.includes(`"dirtyHashes":{"d.txt":"${want['d.txt']}"}`))).toBe(true)
  }
  expect(scrub(snapshot(join(tmp, 'home-mod')))).toEqual(scrub(snapshot(join(tmp, 'home-binary'))))
})

const MONO: Step[] = [
  { call: 'bun test', ends: 'fail', dir: 'packages/a' },
  { call: 'bun test', ends: 'fail', dir: 'packages/b' },
  { call: 'bun test', ends: 'fail', dir: 'packages/a' },
  { call: 'bun test', ends: 'ok', dir: 'packages/b' },
  { call: 'bun test', ends: 'fail', dir: 'packages/a' },
  { call: 'bun test', ends: 'fail' },
  // The shell ends up in packages/a, but the call started at the root.
  { call: 'cd packages/a && bun test', ends: 'fail' },
  { touch: 'fix.txt' },
  { call: 'cd packages/a && bun test', ends: 'ok', postDir: 'packages/a' },
]

test('in a monorepo both front ends keep each package to itself', async () => {
  const mono = (name: string): string => {
    const dir = repo(name)
    for (const p of ['', 'packages/a', 'packages/b']) {
      mkdirSync(join(dir, p), { recursive: true })
      writeFileSync(join(dir, p, 'package.json'), '{}')
    }
    for (const a of [['init', '-q'], ['config', 'user.email', 't@e.com'], ['config', 'user.name', 'T'], ['add', '-A'], ['commit', '-qm', 'init', '--date', '2026-01-01T00:00:00Z']]) {
      expect(Bun.spawnSync(['git', '-C', dir, ...a], { stdout: 'ignore', stderr: 'ignore', env: { ...process.env, GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' } }).exitCode).toBe(0)
    }
    return dir
  }
  const saidBinary = await runBinary(mono('m1'), MONO)
  const saidMod = await runMod(mono('m2'), MONO)
  expect(saidMod).toEqual(saidBinary)
  expect(saidBinary[0]).toBe('')
  expect(saidBinary[1]).toBe('')
  expect(saidBinary[2]).toContain('`bun test` (in packages/a) failed once before')
  expect(saidBinary[3]).toContain('`bun test` (in packages/b) failed once before')
  expect(saidBinary[4]).toContain('`bun test` (in packages/a) failed 2 times before')
  expect(saidBinary[5]).toBe('')
  expect(saidBinary.slice(6)).toEqual(['', ''])
  const store = snapshot(join(tmp, 'home-binary'))
  expect(scrub(snapshot(join(tmp, 'home-mod')))).toEqual(scrub(store))
  const records = Object.entries(store).filter(([k]) => k.startsWith('P/records/')).map(([, v]) => JSON.parse(v) as { scope?: string })
  expect(records.map((r) => r.scope ?? '').sort()).toEqual(['', 'packages/a'])
  expect(Object.values(store).some((v) => v.includes('cd packages/a'))).toBe(false)
  for (const home of ['home-binary', 'home-mod']) expect(Object.keys(snapshot(join(tmp, home))).some((k) => k.startsWith('P/fixes/'))).toBe(true)
})

/** Two sibling git repositories, as a user with several checkouts side by side has. */
function pair(a: string, b: string): [string, string] {
  return [a, b].map((name) => {
    const dir = repo(name)
    for (const x of [['init', '-q'], ['config', 'user.email', 't@e.com'], ['config', 'user.name', 'T'], ['add', '-A'], ['commit', '-qm', 'init', '--date', '2026-01-01T00:00:00Z']]) {
      expect(Bun.spawnSync(['git', '-C', dir, ...x], { stdout: 'ignore', stderr: 'ignore', env: { ...process.env, GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' } }).exitCode).toBe(0)
    }
    return dir
  }) as [string, string]
}

/** Project directories in a data root that hold at least one record, by slug. */
function projectsWithRecords(home: string): string[] {
  return readdirSync(home, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== 'pending' && existsSync(join(home, e.name, 'records')) && Object.keys(snapshot(join(home, e.name, 'records'))).length > 0)
    .map((e) => e.name.replace(/-[0-9a-f]{8}$/, ''))
}

const CD_FAIL: Step[] = [{ call: 'cd ../b && make', ends: 'fail', postDir: '../b' }]
// The second call is warned, then succeeds from the other repository.
const CD_WARNED: Step[] = [
  { call: 'cd ../b && make', ends: 'fail', postDir: '../b' },
  { call: 'cd ../b && make', ends: 'ok', postDir: '../b' },
]

// The outcome payload reports the shell's directory after the command; a `cd` into a
// sibling repository must not move the call there.
test('a command that cd`s into another repository and fails is still recorded in the repo it started in', async () => {
  const saidBinary = await runBinary(pair('one/a', 'one/b')[0], CD_FAIL)
  const saidMod = await runMod(pair('two/a', 'two/b')[0], CD_FAIL)
  expect(saidMod).toEqual(saidBinary)
  for (const home of ['home-binary', 'home-mod']) {
    expect(projectsWithRecords(join(tmp, home))).toEqual(['a'])
    expect(readdirSync(join(tmp, home)).some((n) => n.startsWith('b-'))).toBe(false)
  }
  expect(scrub(snapshot(join(tmp, 'home-mod')))).toEqual(scrub(snapshot(join(tmp, 'home-binary'))))
})

test('a warned command that succeeds after a cd forgets the record in the repo it started in', async () => {
  const saidBinary = await runBinary(pair('one/a', 'one/b')[0], CD_WARNED)
  const saidMod = await runMod(pair('two/a', 'two/b')[0], CD_WARNED)
  expect(saidMod).toEqual(saidBinary)
  expect(saidBinary[1]).toContain('failed once before')
  for (const home of ['home-binary', 'home-mod']) {
    expect(projectsWithRecords(join(tmp, home))).toEqual([])
    expect(readdirSync(join(tmp, home)).some((n) => n.startsWith('b-'))).toBe(false)
    expect(Object.values(snapshot(join(tmp, home))).some((v) => v.includes('"kind":"false_positive"'))).toBe(true)
  }
  expect(scrub(snapshot(join(tmp, 'home-mod')))).toEqual(scrub(snapshot(join(tmp, 'home-binary'))))
})
