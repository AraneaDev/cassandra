import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ModEngine, Next, ToolCallEvent, ToolCallOutcome } from '../mod/engine.ts'
import { install } from '../mod/install.ts'
import type { Io } from '../src/core/io.ts'
import { modIo } from '../src/io/mod.ts'
import { fingerprint } from '../src/core/fingerprint.ts'
import { pathsFor } from '../src/core/paths.ts'
import { readRecord } from '../src/core/record.ts'
import { readStats } from '../src/core/stats.ts'
import { nodeHost, type NodeHostOptions } from './support/node-host.ts'

type Hook = ($: ModEngine, e: never, next: Next<never, never>) => Promise<unknown>

let tmp: string
let cwd: string
let opts: NodeHostOptions
let hooks: Map<string, Hook>
/** The matcher each `tool.call` hook was registered with, by the key it is stored under. */
let matchers: Map<string, RegExp>
let host: ModEngine
let wrap: (io: Io) => Io

const io = (): Io => modIo(host)

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cass-mod-'))
  cwd = join(tmp, 'proj')
  mkdirSync(cwd, { recursive: true })
  writeFileSync(join(cwd, 'a.txt'), 'one')
  opts = { sessionId: 's1', cwd, env: { CASSANDRA_HOME: join(tmp, 'home'), HOME: tmp } }
  host = nodeHost(opts)
  hooks = new Map()
  matchers = new Map()
  wrap = (i) => i
  const on = ((event: string, a: unknown, b?: unknown) => {
    const own = event === 'tool.call' && (a as { tool: RegExp }).tool.source.startsWith('^mcp__cassandra__')
    const key = own ? 'tool.call:cassandra' : event
    if (event === 'tool.call') matchers.set(key, (a as { tool: RegExp }).tool)
    hooks.set(key, (b ?? a) as Hook)
  }) as unknown as Parameters<typeof install>[0]
  install(on, (i) => wrap(i))
})

afterEach(() => rmSync(tmp, { recursive: true, force: true }))

/** Drive one tool call through the mod, with the engine answering `answer`. */
async function call(command: string, answer: ToolCallOutcome, extra: Partial<ToolCallEvent> = {}, aborted = false) {
  let nextCalls = 0
  const next = Object.assign(async () => {
    nextCalls += 1
    return answer
  }, { signal: { aborted } as AbortSignal }) as unknown as Next<ToolCallEvent, ToolCallOutcome>
  const r = await (hooks.get('tool.call') as unknown as ($: ModEngine, e: ToolCallEvent, n: typeof next) => Promise<ToolCallOutcome>)(
    host, { tool: 'Bash', tool_use_id: 't1', command, ...extra }, next,
  )
  return { r, nextCalls }
}

const failed = (text = 'Exit code 1\nboom'): ToolCallOutcome => ({ isError: true, result: text, text })
const ok = (): ToolCallOutcome => ({ result: { stdout: '' }, text: '' })

test('a miss passes the engine result through untouched, the same object', async () => {
  const answer = ok()
  const { r, nextCalls } = await call('ls', answer)
  expect(r).toBe(answer)
  expect(nextCalls).toBe(1)
})

test('a failure is recorded, and the unchanged repeat carries the warning as context', async () => {
  await call('bun test', failed())
  const { r } = await call('bun test', failed())
  expect(r.context?.[0]).toStartWith('cassandra (advisory): this exact call already failed once in this project')
})

test('the warning points at the pane when a surface exists and at /cassandra why when headless', async () => {
  await call('bun test', failed())
  const { r } = await call('bun test', failed())
  expect(r.context?.[0]).toEndWith('The user can see and clear this in the Cassandra pane.')
  opts.surfaces = []
  const headless = await call('bun test', failed())
  expect(headless.r.context?.[0]).toMatch(/The user can see it with \/cassandra why [0-9a-f]{8}\.$/)
})

test('the warning is appended to context another plugin already set', async () => {
  await call('bun test', failed())
  const { r } = await call('bun test', { ...failed(), context: ['from another plugin'] })
  expect(r.context).toEqual(['from another plugin', expect.stringContaining('cassandra (advisory):')])
})

test('a deny result is returned as is, with no context, and recorded as a denial', async () => {
  const answer: ToolCallOutcome = { deny: 'blocked by policy' }
  await call('rm -rf x', answer)
  const { r } = await call('rm -rf x', answer)
  expect(r).toBe(answer)
  const hash = (await fingerprint(io(), 'Bash', { command: 'rm -rf x' }))!
  expect((await readRecord(io(), await pathsFor(io(), cwd), hash))?.kind).toBe('denial')
})

test('a changed tree is silent', async () => {
  await call('bun test', failed())
  writeFileSync(join(cwd, 'b.txt'), 'two')
  const { r } = await call('bun test', failed())
  expect(r.context).toBeUndefined()
})

test('warned then succeeded logs a false positive and forgets the record', async () => {
  await call('bun test', failed())
  await call('bun test', ok())
  const paths = await pathsFor(io(), cwd)
  expect((await readStats(io(), paths)).map((s) => s.kind)).toEqual(['warned', 'false_positive'])
  const hash = (await fingerprint(io(), 'Bash', { command: 'bun test' }))!
  expect(await readRecord(io(), paths, hash)).toBeNull()
})

test('an interrupted call records nothing', async () => {
  await call('sleep 30', failed('Interrupted'), {}, true)
  const hash = (await fingerprint(io(), 'Bash', { command: 'sleep 30' }))!
  expect(await readRecord(io(), await pathsFor(io(), cwd), hash)).toBeNull()
})

test('a core error before next still runs the call exactly once and returns its result', async () => {
  wrap = (i) => ({ ...i, sha256: async () => { throw new Error('boom') } })
  const answer = failed()
  const { r, nextCalls } = await call('bun test', answer)
  expect(r).toBe(answer)
  expect(nextCalls).toBe(1)
})

test('a core error after next returns the result untouched', async () => {
  let ran = false
  wrap = (i) => ({ ...i, sha256: async (t) => { if (ran) throw new Error('boom'); return i.sha256(t) } })
  const answer = failed()
  const next = Object.assign(async () => { ran = true; return answer }, { signal: { aborted: false } as AbortSignal })
  const hook = hooks.get('tool.call') as unknown as ($: ModEngine, e: ToolCallEvent, n: typeof next) => Promise<ToolCallOutcome>
  expect(await hook(host, { tool: 'Bash', tool_use_id: 't1', command: 'bun test' }, next)).toBe(answer)
})

test('the session marker is written before the call, so the classic hook beneath stands down', async () => {
  const marker = join(tmp, 'home', 'sessions', 's1.mod')
  let sawMarker = false
  const next = Object.assign(async () => { sawMarker = existsSync(marker); return ok() }, { signal: { aborted: false } as AbortSignal })
  const hook = hooks.get('tool.call') as unknown as ($: ModEngine, e: ToolCallEvent, n: typeof next) => Promise<ToolCallOutcome>
  await hook(host, { tool: 'Bash', tool_use_id: 't1', command: 'ls' }, next)
  expect(sawMarker).toBe(true)
})

test('after /clear the new session id is claimed at its first call (Review Focus 1)', async () => {
  await call('ls', ok())
  opts.sessionId = 's2'
  await call('ls', ok())
  expect(existsSync(join(tmp, 'home', 'sessions', 's2.mod'))).toBe(true)
})

test('a marker pruned by another session is rewritten within the hour (Review Focus 2)', async () => {
  const realNow = Date.now
  try {
    await call('ls', ok())
    const marker = join(tmp, 'home', 'sessions', 's1.mod')
    rmSync(marker)
    await call('ls', ok())
    expect(existsSync(marker)).toBe(false)
    Date.now = () => realNow() + 61 * 60 * 1000
    await call('ls', ok())
    expect(existsSync(marker)).toBe(true)
  } finally {
    Date.now = realNow
  }
})

test('session.end releases the claim', async () => {
  await call('ls', ok())
  const end = hooks.get('session.end') as unknown as ($: ModEngine, e: { sessionId: string }, n: () => Promise<unknown>) => Promise<unknown>
  await end(host, { sessionId: 's1' }, async () => ({}))
  expect(existsSync(join(tmp, 'home', 'sessions', 's1.mod'))).toBe(false)
})

test('a main-loop compaction is counted, a subagent one and a skipped one are not', async () => {
  const compact = hooks.get('session.compact') as unknown as ($: ModEngine, e: { agentId?: string }, n: () => Promise<unknown>) => Promise<unknown>
  await compact(host, {}, async () => ({ messages: [] }))
  await compact(host, { agentId: 'a1' }, async () => ({ messages: [] }))
  await compact(host, {}, async () => ({ skip: 'vetoed' }))
  const { compactionCount } = await import('../src/core/session.ts')
  expect(await compactionCount(io(), await pathsFor(io(), cwd), 's1')).toBe(1)
})

test('the MCP input the mod fingerprints leaves out the engine reserved keys', async () => {
  const { toolInput } = await import('../mod/calls.ts')
  expect(toolInput({ tool: 'mcp__s__t', tool_use_id: 'x', agentId: 'a', consent: 'c', b: 2, a: 1 })).toEqual({ b: 2, a: 1 })
})

test('a permission-rule denial that comes back as an errored result records nothing', async () => {
  const denied = failed('Permission to use Bash with command rm -f x has been denied.')
  await call('rm -f x', denied)
  const hash = (await fingerprint(io(), 'Bash', { command: 'rm -f x' }))!
  expect(await readRecord(io(), await pathsFor(io(), cwd), hash)).toBeNull()
})

test('a result that requires approval records nothing', async () => {
  await call('rm -f y', failed('This command requires approval'))
  const hash = (await fingerprint(io(), 'Bash', { command: 'rm -f y' }))!
  expect(await readRecord(io(), await pathsFor(io(), cwd), hash)).toBeNull()
})

test('a Bash call a hook blocked before it ran records nothing', async () => {
  await call('sleep 40 && false', failed('<tool_use_error>Blocked: sleep 40 followed by: false.</tool_use_error>'))
  const hash = (await fingerprint(io(), 'Bash', { command: 'sleep 40 && false' }))!
  expect(await readRecord(io(), await pathsFor(io(), cwd), hash)).toBeNull()
})

test('the tool-use-error wrapper means never-run for Bash only', async () => {
  const { outcomeOf } = await import('../mod/calls.ts')
  const wrapped = { isError: true, text: '<tool_use_error>server said no</tool_use_error>' }
  expect(outcomeOf(wrapped, false, 'Bash')).toEqual({ kind: 'not_run' })
  expect(outcomeOf(wrapped, false, 'mcp__s__t')).toEqual({ kind: 'failure', reason: wrapped.text })
  expect(outcomeOf({ isError: true, text: 'Exit code 2\nls: cannot access' }, false, 'Bash').kind).toBe('failure')
})

test('session.start claims the session without waiting for a tool call', async () => {
  const start = hooks.get('session.start') as unknown as ($: ModEngine, e: unknown, n: () => Promise<unknown>) => Promise<unknown>
  const started = { ok: true }
  expect(await start(host, {}, async () => started)).toBe(started)
  expect(existsSync(join(tmp, 'home', 'sessions', 's1.mod'))).toBe(true)
})

test('session.start survives a core error', async () => {
  wrap = () => { throw new Error('boom') }
  const start = hooks.get('session.start') as unknown as ($: ModEngine, e: unknown, n: () => Promise<unknown>) => Promise<unknown>
  const started = { ok: true }
  expect(await start(host, {}, async () => started)).toBe(started)
})

test('a data root that changes after the claim gets the marker re-written under the new root', async () => {
  await call('ls', ok())
  expect(existsSync(join(tmp, 'home', 'sessions', 's1.mod'))).toBe(true)
  opts.env = { ...opts.env, CASSANDRA_HOME: join(tmp, 'home2') }
  await call('ls', ok())
  expect(existsSync(join(tmp, 'home2', 'sessions', 's1.mod'))).toBe(true)
})

test('a nullish engine result passes through tool.call without throwing', async () => {
  const hook = hooks.get('tool.call') as unknown as ($: ModEngine, e: ToolCallEvent, n: unknown) => Promise<unknown>
  const next = Object.assign(async () => undefined, { signal: { aborted: false } as AbortSignal })
  expect(await hook(host, { tool: 'Bash', tool_use_id: 't1', command: 'ls' }, next)).toBeUndefined()
})

test('a nullish compaction result passes through without throwing', async () => {
  const compact = hooks.get('session.compact') as unknown as ($: ModEngine, e: object, n: () => Promise<unknown>) => Promise<unknown>
  expect(await compact(host, {}, async () => undefined)).toBeUndefined()
})

test('a Bash failure whose output mentions approval is still a failure', async () => {
  await call('echo y', failed('Exit code 1\nthis requires approval'))
  const hash = (await fingerprint(io(), 'Bash', { command: 'echo y' }))!
  expect(await readRecord(io(), await pathsFor(io(), cwd), hash)).not.toBeNull()
})

test('with no resolvable data root the call still runs and nothing throws', async () => {
  opts.env = {}
  const { r, nextCalls } = await call('ls', ok())
  expect(nextCalls).toBe(1)
  expect(r).toBeDefined()
})

test('when the session claim cannot be written the mod stands aside, so the binary is the only recorder', async () => {
  wrap = (i) => ({ ...i, writeText: (p, t) => (p.endsWith('.mod') ? Promise.reject(new Error('read-only')) : i.writeText(p, t)) })
  const answer = failed()
  const { r, nextCalls } = await call('bun test', answer)
  expect(r).toBe(answer)
  expect(nextCalls).toBe(1)
  const hash = (await fingerprint(io(), 'Bash', { command: 'bun test' }))!
  expect(await readRecord(io(), await pathsFor(io(), cwd), hash)).toBeNull()
})

type Spawn = ($: ModEngine, e: { subagentType: string }, n: () => Promise<Record<string, unknown>>) => Promise<unknown>
type Compact = ($: ModEngine, e: { agentId?: string; trigger?: string }, n: () => Promise<unknown>) => Promise<unknown>
type Row = { door: string; origin: Record<string, unknown>; agentId?: string; message: unknown; uuid: string }
type Append = ($: ModEngine, e: Row, n: () => Promise<unknown>) => Promise<unknown>

async function seedFailure(command = 'bun test'): Promise<void> {
  await call(command, failed())
}

const spawn = (type: string, answer: Record<string, unknown>) =>
  (hooks.get('agent.spawn') as unknown as Spawn)(host, { subagentType: type }, async () => answer)
const compact = (e: { agentId?: string; trigger?: string }, answer: unknown) =>
  (hooks.get('session.compact') as unknown as Compact)(host, e, async () => answer)

/** One row of a loop reaching the transcript, as the engine stores it. */
async function row(agentId?: string, door = 'response', origin: Record<string, unknown> = { kind: 'model', model: 'm' }) {
  const stored = { uuid: 'u1' }
  const r = await (hooks.get('session.append') as unknown as Append)(
    host, { door, origin, agentId, message: { type: 'assistant', content: [] }, uuid: 'u1' }, async () => stored,
  )
  expect(r).toBe(stored)
}

const briefed = async () => (await readStats(io(), await pathsFor(io(), cwd))).filter((s) => s.kind === 'briefed')

test("a new subagent's first tool result brings the live failures into its own conversation; the spawn is untouched", async () => {
  await seedFailure()
  const result = { model: 'm', agentId: 'sub-1' }
  expect(await spawn('general-purpose', result)).toBe(result)
  expect(opts.appended ?? []).toEqual([])
  await row('sub-1', 'tool-result')
  expect(opts.appended).toEqual([{ agentId: 'sub-1', text: expect.stringContaining('`bun test` failed once') }])
  expect((await briefed()).at(-1)).toMatchObject({ kind: 'briefed', boundary: 'subagent' })
  await row('sub-1', 'tool-result')
  expect(opts.appended).toHaveLength(1)
})

test("a main-loop row does not deliver a subagent's note", async () => {
  await seedFailure()
  await spawn('general-purpose', { agentId: 'sub-1' })
  await row(undefined, 'tool-result')
  await row('sub-2', 'tool-result')
  expect(opts.appended ?? []).toEqual([])
})

test('a fork, a refused spawn and a spawn with no id owe nothing', async () => {
  await seedFailure()
  await spawn('fork', { agentId: 'f-1' })
  await spawn('general-purpose', { deny: 'no', agentId: 'd-1' })
  await spawn('general-purpose', { model: 'm' })
  await row('f-1', 'tool-result')
  await row('d-1', 'tool-result')
  await row(undefined, 'tool-result')
  expect(opts.appended ?? []).toEqual([])
})

test('no live failures means no note and no stat', async () => {
  await spawn('general-purpose', { agentId: 'sub-1' })
  await row('sub-1', 'tool-result')
  await seedFailure()
  writeFileSync(join(cwd, 'b.txt'), 'changed')
  await spawn('general-purpose', { agentId: 'sub-2' })
  await row('sub-2', 'tool-result')
  expect(opts.appended ?? []).toEqual([])
  expect(await briefed()).toEqual([])
})

test('a refused append leaves no stat and is retried on the next row of that loop', async () => {
  await seedFailure()
  await spawn('general-purpose', { agentId: 'sub-1' })
  opts.appendRejects = true
  await row('sub-1', 'tool-result')
  expect(await briefed()).toEqual([])
  opts.appendRejects = false
  await row('sub-1', 'tool-result')
  expect(opts.appended).toEqual([{ agentId: 'sub-1', text: expect.stringContaining('cassandra:') }])
  expect(await briefed()).toHaveLength(1)
})

test('after five refused appends the note is dropped', async () => {
  await seedFailure()
  await spawn('general-purpose', { agentId: 'sub-1' })
  opts.appendRejects = true
  for (let i = 0; i < 5; i++) await row('sub-1', 'tool-result')
  opts.appendRejects = false
  await row('sub-1', 'tool-result')
  expect(opts.appended ?? []).toEqual([])
  expect(await briefed()).toEqual([])
})

test('a compaction is briefed at the first row after its boundary rows; a skipped one owes nothing', async () => {
  await seedFailure()
  await compact({}, { skip: 'vetoed' })
  await row()
  expect(opts.appended ?? []).toEqual([])
  await compact({}, { messages: [] })
  await row(undefined, 'compaction', { kind: 'engine' })
  expect(opts.appended ?? []).toEqual([])
  await row(undefined, 'notice', { kind: 'engine' })
  expect(opts.appended).toEqual([{ agentId: undefined, text: expect.stringContaining('`bun test` failed once') }])
  expect((await briefed()).at(-1)).toMatchObject({ kind: 'briefed', boundary: 'compaction' })
})

test("a subagent's compaction is briefed in that subagent's conversation, and the main count is not bumped", async () => {
  await seedFailure()
  await compact({ agentId: 'sub-9' }, { messages: [] })
  await row()
  expect(opts.appended ?? []).toEqual([])
  await row('sub-9')
  expect(opts.appended).toEqual([{ agentId: 'sub-9', text: expect.stringContaining('cassandra:') }])
  const { compactionCount } = await import('../src/core/session.ts')
  expect(await compactionCount(io(), await pathsFor(io(), cwd), 's1')).toBe(0)
})

test("cassandra's own note row does not deliver", async () => {
  await seedFailure()
  await compact({}, { messages: [] })
  await row(undefined, 'note', { kind: 'plugin', name: 'cassandra' })
  expect(opts.appended ?? []).toEqual([])
  await row(undefined, 'note', { kind: 'plugin', name: 'other' })
  expect(opts.appended).toHaveLength(1)
})

test('session.end clears the owed notes', async () => {
  await seedFailure()
  await spawn('general-purpose', { agentId: 'sub-1' })
  await compact({}, { messages: [] })
  const end = hooks.get('session.end') as unknown as ($: ModEngine, e: { sessionId: string }, n: () => Promise<unknown>) => Promise<unknown>
  await end(host, { sessionId: 's1' }, async () => ({}))
  await row('sub-1', 'tool-result')
  await row()
  expect(opts.appended ?? []).toEqual([])
})

test('a core error during the hand-over is swallowed and the row passes through', async () => {
  await seedFailure()
  await spawn('general-purpose', { agentId: 'sub-1' })
  wrap = () => { throw new Error('boom') }
  await row('sub-1', 'tool-result')
  expect(opts.appended ?? []).toEqual([])
})

test("a subagent's opening rows and its responses neither deliver its note nor cost an attempt; its first tool result does", async () => {
  await seedFailure()
  await spawn('general-purpose', { agentId: 'sub-1' })
  opts.appendRejects = true
  for (let i = 0; i < 6; i++) {
    await row('sub-1', 'prompt', { kind: 'sdk' })
    await row('sub-1', 'attachment', { kind: 'engine' })
  }
  opts.appendRejects = false
  await row('sub-1', 'prompt', { kind: 'sdk' })
  await row('sub-1', 'attachment', { kind: 'engine' })
  await row('sub-1', 'response')
  await row('sub-1', 'response')
  expect(opts.appended ?? []).toEqual([])
  expect(await briefed()).toEqual([])
  await row('sub-1', 'tool-result', { kind: 'tool' })
  expect(opts.appended).toEqual([{ agentId: 'sub-1', text: expect.stringContaining('cassandra:') }])
})

test('a one-turn subagent that never uses a tool gets no note and leaves no stat', async () => {
  await seedFailure()
  await spawn('general-purpose', { agentId: 'sub-1' })
  await row('sub-1', 'prompt', { kind: 'sdk' })
  await row('sub-1', 'response')
  expect(opts.appended ?? []).toEqual([])
  expect(await briefed()).toEqual([])
})

const compactionCountNow = async () => {
  const { compactionCount } = await import('../src/core/session.ts')
  return compactionCount(io(), await pathsFor(io(), cwd), 's1')
}

const endSession = (sessionId: string) =>
  (hooks.get('session.end') as unknown as ($: ModEngine, e: { sessionId: string }, n: () => Promise<unknown>) => Promise<unknown>)(host, { sessionId }, async () => ({}))

test('a precompute compaction owes nothing and is not counted; its result passes through unchanged', async () => {
  await seedFailure()
  const answer = { messages: [] }
  expect(await compact({ trigger: 'precompute' }, answer)).toBe(answer)
  await row(undefined, 'notice', { kind: 'engine' })
  await row()
  expect(opts.appended ?? []).toEqual([])
  expect(await compactionCountNow()).toBe(0)
  expect(await briefed()).toEqual([])
})

test('after /clear a spawn claims the new session before the classic SubagentStart runs beneath it', async () => {
  await seedFailure()
  await endSession('s1')
  opts.sessionId = 's2'
  const { handle } = await import('../src/hook.ts')
  const marker = join(tmp, 'home', 'sessions', 's2.mod')
  const subagentStart = { hook_event_name: 'SubagentStart', session_id: 's2', cwd, agent_id: 'sub-1', agent_type: 'general-purpose' }
  process.env.CASSANDRA_HOME = join(tmp, 'home')
  try {
    let markerSeen = false
    let binarySaid: string | null = 'not called'
    let nextCalls = 0
    const result = { agentId: 'sub-1' }
    const r = await (hooks.get('agent.spawn') as unknown as Spawn)(host, { subagentType: 'general-purpose' }, async () => {
      nextCalls += 1
      markerSeen = existsSync(marker)
      binarySaid = await handle(subagentStart)
      return result
    })
    expect(r).toBe(result)
    expect(nextCalls).toBe(1)
    expect(markerSeen).toBe(true)
    expect(binarySaid).toBeNull()
  } finally {
    delete process.env.CASSANDRA_HOME
  }
  await row('sub-1', 'tool-result')
  expect(opts.appended).toEqual([{ agentId: 'sub-1', text: expect.stringContaining('cassandra:') }])
  expect(await briefed()).toHaveLength(1)
})

test('after /clear a compaction claims the new session before it runs', async () => {
  await seedFailure()
  await endSession('s1')
  opts.sessionId = 's2'
  let markerSeen = false
  await (hooks.get('session.compact') as unknown as Compact)(host, {}, async () => {
    markerSeen = existsSync(join(tmp, 'home', 'sessions', 's2.mod'))
    return { messages: [] }
  })
  expect(markerSeen).toBe(true)
})

test('when the claim cannot be written a spawn and a compaction owe nothing, count nothing, and still run once', async () => {
  await seedFailure()
  await endSession('s1')
  wrap = (i) => ({ ...i, writeText: (p, t) => (p.endsWith('.mod') ? Promise.reject(new Error('read-only')) : i.writeText(p, t)) })
  let nextCalls = 0
  const spawned = { agentId: 'sub-1' }
  expect(await (hooks.get('agent.spawn') as unknown as Spawn)(host, { subagentType: 'general-purpose' }, async () => { nextCalls += 1; return spawned })).toBe(spawned)
  const compacted = { messages: [] }
  expect(await (hooks.get('session.compact') as unknown as Compact)(host, {}, async () => { nextCalls += 1; return compacted })).toBe(compacted)
  expect(nextCalls).toBe(2)
  wrap = (i) => i
  await row('sub-1', 'tool-result')
  await row(undefined, 'notice', { kind: 'engine' })
  expect(opts.appended ?? []).toEqual([])
  expect(await compactionCountNow()).toBe(0)
})

test('a claim that throws still runs the spawn and the compaction exactly once', async () => {
  wrap = () => { throw new Error('boom') }
  let nextCalls = 0
  const spawned = { agentId: 'sub-1' }
  expect(await (hooks.get('agent.spawn') as unknown as Spawn)(host, { subagentType: 'general-purpose' }, async () => { nextCalls += 1; return spawned })).toBe(spawned)
  const compacted = { messages: [] }
  expect(await (hooks.get('session.compact') as unknown as Compact)(host, {}, async () => { nextCalls += 1; return compacted })).toBe(compacted)
  expect(nextCalls).toBe(2)
})

test('an append a plugin above refuses is dropped: no stat and no retry', async () => {
  await seedFailure()
  await spawn('general-purpose', { agentId: 'sub-1' })
  opts.appendDenies = 'policy'
  await row('sub-1', 'tool-result')
  expect(opts.appended ?? []).toEqual([])
  expect(await briefed()).toEqual([])
  opts.appendDenies = undefined
  await row('sub-1', 'tool-result')
  expect(opts.appended ?? []).toEqual([])
  expect(await briefed()).toEqual([])
})

test("a subagent's compaction note is delivered on that subagent's next non-response row", async () => {
  await seedFailure()
  await compact({ agentId: 'sub-9' }, { messages: [] })
  await row('sub-9', 'compaction', { kind: 'engine' })
  expect(opts.appended ?? []).toEqual([])
  await row('sub-9', 'attachment', { kind: 'engine' })
  expect(opts.appended).toEqual([{ agentId: 'sub-9', text: expect.stringContaining('cassandra:') }])
  expect((await briefed()).at(-1)).toMatchObject({ kind: 'briefed', boundary: 'compaction' })
})

test('a refused compaction append is re-owed and delivered at the next row', async () => {
  await seedFailure()
  await compact({}, { messages: [] })
  opts.appendRejects = true
  await row(undefined, 'notice', { kind: 'engine' })
  expect(await briefed()).toEqual([])
  opts.appendRejects = false
  await row(undefined, 'notice', { kind: 'engine' })
  expect(opts.appended).toEqual([{ agentId: undefined, text: expect.stringContaining('cassandra:') }])
  expect((await briefed()).at(-1)).toMatchObject({ kind: 'briefed', boundary: 'compaction' })
})

test('a refused append does not overwrite a newer note owed to the same loop meanwhile', async () => {
  await seedFailure()
  await spawn('general-purpose', { agentId: 'sub-1' })
  const plain = host
  host = {
    ...plain,
    session: {
      ...plain.session,
      append: async () => {
        // The same loop compacts while the append is in flight, then the append is refused.
        await (hooks.get('session.compact') as unknown as Compact)(plain, { agentId: 'sub-1' }, async () => ({ messages: [] }))
        throw new Error('no running loop')
      },
    },
  }
  await row('sub-1', 'tool-result')
  host = plain
  // The newer compaction entry stands, so a row that is not a tool result delivers it.
  await row('sub-1', 'attachment', { kind: 'engine' })
  expect(opts.appended).toEqual([{ agentId: 'sub-1', text: expect.stringContaining('cassandra:') }])
  expect((await briefed()).at(-1)).toMatchObject({ kind: 'briefed', boundary: 'compaction' })
})

type ToolHook = ($: ModEngine, e: ToolCallEvent, n: () => Promise<unknown>) => Promise<{ result: unknown }>
const toolHook = () => hooks.get('tool.call:cassandra') as unknown as ToolHook

test('session.start registers both tools', async () => {
  await (hooks.get('session.start') as unknown as ($: ModEngine, e: unknown, n: () => Promise<unknown>) => Promise<unknown>)(host, {}, async () => ({}))
  expect((opts.registered ?? []).map((t) => t.name)).toEqual(['query', 'resolve'])
})

test('the tools are answered without next, and calling them records nothing (Review Focus 4)', async () => {
  await seedFailure()
  let nextCalls = 0
  const next = async () => { nextCalls += 1; return {} }
  const q = await toolHook()(host, { tool: 'mcp__cassandra__query', tool_use_id: 'q1', command: 'bun test' }, next)
  expect(String(q.result)).toContain('`bun test` failed once')
  const r = await toolHook()(host, { tool: 'mcp__cassandra__resolve', tool_use_id: 'r1', command: 'bun test', reason: 'fixed globally' }, next)
  expect(String(r.result)).toStartWith('cassandra: Forgot `bun test`')
  const bad = await toolHook()(host, { tool: 'mcp__cassandra__resolve', tool_use_id: 'r2', reason: 'x' }, next)
  expect(String(bad.result)).toStartWith('cassandra: ')
  expect(nextCalls).toBe(0)
  const stats = await readStats(io(), await pathsFor(io(), cwd))
  expect(stats.filter((s) => s.kind !== 'resolved')).toEqual([])
  const own = await fingerprint(io(), 'mcp__cassandra__query', { command: 'bun test' })
  expect(own).toBeNull()
})

test("the tracking matcher excludes Cassandra's own tools and nothing else", async () => {
  const { TRACKED } = await import('../mod/calls.ts')
  expect(TRACKED.test('mcp__cassandra__query')).toBe(false)
  expect(TRACKED.test('mcp__cassandra__resolve')).toBe(false)
  expect(TRACKED.test('mcp__srv__do')).toBe(true)
  expect(TRACKED.test('Bash')).toBe(true)
  expect(TRACKED.test('Read')).toBe(false)
  expect(TRACKED.test('mcp__cassandra_x__y')).toBe(true)
  expect(TRACKED.test('mcp__srv__cassandra__x')).toBe(true)
  expect(TRACKED.test('mcp__cassandra__select')).toBe(true)
  expect(TRACKED.test('mcp__cassandra__queryx')).toBe(true)
  expect(TRACKED.test('Bash2')).toBe(false)
})

test("the tools hook matches Cassandra's two tools and nothing else", () => {
  const m = matchers.get('tool.call:cassandra')!
  expect(m.test('mcp__cassandra__query')).toBe(true)
  expect(m.test('mcp__cassandra__resolve')).toBe(true)
  expect(m.test('mcp__cassandra__queryx')).toBe(false)
  expect(m.test('mcp__cassandra__other')).toBe(false)
})

test('a refused tool registration still lets session.start prune and claim', async () => {
  opts.registerRejects = true
  const stale = join(tmp, 'home', 'sessions', 'old.mod')
  mkdirSync(join(tmp, 'home', 'sessions'), { recursive: true })
  writeFileSync(stale, 'x')
  const long = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)
  utimesSync(stale, long, long)
  const started = { ok: true }
  const r = await (hooks.get('session.start') as unknown as ($: ModEngine, e: unknown, n: () => Promise<unknown>) => Promise<unknown>)(host, {}, async () => started)
  expect(r).toBe(started)
  expect(existsSync(join(tmp, 'home', 'sessions', 's1.mod'))).toBe(true)
  expect(existsSync(stale)).toBe(false)
  expect(opts.registered ?? []).toEqual([])
  expect(opts.commands).toEqual(['cassandra'])
})

test('a tool the core cannot serve is still answered, without next', async () => {
  wrap = () => { throw new Error('boom') }
  let nextCalls = 0
  const r = await toolHook()(host, { tool: 'mcp__cassandra__query' }, async () => { nextCalls += 1; return {} })
  expect(r.result).toBe('cassandra: could not answer.')
  expect(nextCalls).toBe(0)
})

type CommandHook = ($: ModEngine, e: { command: string; args: string; origin?: { kind: string } }, n: () => Promise<unknown>) => Promise<{ text?: string; exitCode?: number }>
const command = (args: string | undefined, ...given: Array<{ kind: string } | undefined>) => (hooks.get('command.run') as unknown as CommandHook)(host, { command: 'cassandra', args: args as string, origin: given.length ? given[0] : { kind: 'composer' } }, async () => ({}))
const start = () => (hooks.get('session.start') as unknown as ($: ModEngine, e: unknown, n: () => Promise<unknown>) => Promise<unknown>)(host, {}, async () => ({}))

test('session.start registers /cassandra and pins the live count', async () => {
  await seedFailure()
  opts.statuses = []
  await start()
  expect(opts.commands).toEqual(['cassandra'])
  expect(opts.statuses.at(-1)).toBe('1 live failure')
})

test('/cassandra answers with the CLI text and exit code for each subcommand (Review Focus 1)', async () => {
  await seedFailure()
  const { runCommand } = await import('../src/commands/run.ts')
  const cli = async (args: string[]) => {
    const r = await runCommand(io(), cwd, args)
    return { text: r.text, exitCode: r.code }
  }
  const listed = await cli([])
  expect(listed.exitCode).toBe(0)
  expect(await command('')).toEqual(listed)
  const why = await cli(['why'])
  expect(why.exitCode).toBe(1)
  expect(await command('  why   ')).toEqual(why)
  const forget = await cli(['forget'])
  expect(forget.exitCode).toBe(1)
  expect(await command('forget')).toEqual(forget)
  const { USAGE } = await import('../src/commands/run.ts')
  expect(await command('nope')).toEqual({ text: USAGE, exitCode: 1 })

  opts.statuses = []
  const all = await command('forget --all')
  expect(opts.statuses).toStrictEqual([undefined])
  await seedFailure()
  expect(all).toEqual(await cli(['forget', '--all']))
  expect(all.exitCode).toBe(0)
})

test('the status line refreshes only when the store changes (Review Focus 2)', async () => {
  opts.statuses = []
  await call('ls', ok())
  expect(opts.statuses).toStrictEqual([])
  await call('bun test', failed())
  expect(opts.statuses).toStrictEqual(['1 live failure'])
  await call('bun test', ok())
  expect(opts.statuses).toStrictEqual(['1 live failure', undefined])
})

test('a resolve through the tools hook refreshes the status line', async () => {
  await seedFailure()
  opts.statuses = []
  const r = await toolHook()(host, { tool: 'mcp__cassandra__resolve', tool_use_id: 'r1', command: 'bun test', reason: 'fixed' }, async () => ({}))
  expect(String(r.result)).toStartWith('cassandra: Forgot')
  expect(opts.statuses).toStrictEqual([undefined])
})

test('a command the core cannot serve answers with the fallback text and code 1', async () => {
  await seedFailure()
  wrap = (i) => ({ ...i, sha256: async () => { throw new Error('boom') } })
  expect(await command('list')).toEqual({ text: 'could not read what this project remembers.', exitCode: 1 })
})

test('a command whose io cannot be built still answers with the fallback text', async () => {
  wrap = () => { throw new Error('boom') }
  expect(await command('stats')).toEqual({ text: 'could not read what this project remembers.', exitCode: 1 })
})

test('a bare /cassandra with no args at all gets the list text', async () => {
  await seedFailure()
  const { runCommand } = await import('../src/commands/run.ts')
  const listed = await runCommand(io(), cwd, [])
  expect(await command(undefined)).toEqual({ text: listed.text, exitCode: 0 })
})

test('a forget that forgets nothing leaves the status line alone', async () => {
  await seedFailure()
  opts.statuses = []
  expect((await command('forget')).exitCode).toBe(1)
  expect((await command('forget deadbeef')).exitCode).toBe(1)
  expect(opts.statuses).toStrictEqual([])
})

test('forget --all wipes for a composer, a bridge and an sdk origin', async () => {
  for (const kind of ['composer', 'bridge', 'sdk']) {
    await seedFailure()
    expect((await command('forget --all', { kind })).exitCode).toBe(0)
    expect((await command('list')).text).not.toContain('bun test')
  }
})

test('forget --all from a plugin or a schedule is refused and changes nothing', async () => {
  await seedFailure()
  const before = await command('list')
  for (const kind of ['plugin', 'scheduled-trigger']) {
    opts.statuses = []
    expect(await command('forget --all', { kind })).toEqual({ text: 'forget --all only runs when you type it yourself; nothing was forgotten.', exitCode: 1 })
    expect(opts.statuses).toStrictEqual([])
    expect(await command('list')).toEqual(before)
  }
  expect(await command('forget --all', undefined)).toEqual({ text: 'forget --all only runs when you type it yourself; nothing was forgotten.', exitCode: 1 })
})

test('forget <id> still forgets one record from a plugin origin', async () => {
  await seedFailure()
  const id = /\b([0-9a-f]{8})\b/.exec((await command('list')).text ?? '')?.[1] ?? ''
  const r = await command(`forget ${id}`, { kind: 'plugin' })
  expect(r.text).toStartWith('Forgot')
  expect(r.exitCode).toBe(0)
})

// ---- /cassandra pane ----

interface Drawn { type: string; props: Record<string, any>; children: any[] }
const g = globalThis as any
// The engine supplies the JSX factory `h` as a global; here it builds plain nodes.
g.h ??= (type: string, props: Record<string, any> | null, ...children: any[]): Drawn => ({ type, props: props ?? {}, children: children.flat() })
g.Fragment ??= 'Fragment'

function walk(n: any, out: Drawn[] = []): Drawn[] {
  if (n && typeof n === 'object') {
    out.push(n)
    for (const c of n.children ?? []) walk(c, out)
  }
  return out
}
const textOf = (n: Drawn): string => n.children.map((c) => (typeof c === 'string' ? c : textOf(c))).join('')

type PaneHook = ($: ModEngine, e: Record<string, unknown>, n: (e: any) => Promise<unknown>) => Promise<unknown>
const paneHook = (event: string) => hooks.get(event) as unknown as PaneHook
const PANE = { component: 'Pane', requestId: 'cassandra' }
const render = async (props: Record<string, unknown> = { bodyColumns: 100, scroll: { offset: 0, bodyRows: 30 } }, surface = 'terminal') =>
  walk(await paneHook('ui.render')(host, { ...PANE, surface, props, viewport: { columns: 120, rows: 40 } }, async () => ({})))
const rowKeys = async () => (await render()).filter((n) => n.type === 'Button' && String(n.props.key).startsWith('row:')).map((n) => String(n.props.key))
/** The row drawn as selected: the one on the marked row's ground. */
const selectedKey = async () => (await render())
  .filter((n) => n.type === 'Button' && String(n.props.key).startsWith('row:') && walk(n).some((t) => t.props?.backgroundColor === 'userMessageBackground'))
  .map((n) => String(n.props.key))[0]
const press = async (element: string, surface = 'terminal') => {
  let passed = 0
  const r = await paneHook('ui.press')(host, { ...PANE, plugin: 'cassandra', element, surface }, async (e) => { passed += 1; return { element: e.element } })
  expect(passed).toBe(1)
  expect(r).toEqual({ element })
}
const focus = async (element: string | undefined) => {
  let passed = 0
  const r = await paneHook('ui.focus')(host, { ...PANE, element, origin: { kind: 'person' } }, async () => { passed += 1; return {} })
  expect(passed).toBe(1)
  expect(r).toEqual({})
}
const state = (key: string) => opts.state?.get(key)
const remembered = async () => (await import('../src/core/record.ts')).listRecords(io(), await pathsFor(io(), cwd))

test('/cassandra pane opens the pane focused, answers, and resets the confirmation and the notice (Review Focus 2)', async () => {
  opts.state = new Map<string, unknown>([['confirmAll', true], ['notice', 'Could not forget the selected record.']])
  expect(await command('pane')).toEqual({ text: 'Opened the Cassandra pane.', exitCode: 0 })
  expect(opts.opened).toEqual([{ id: 'cassandra', title: 'Cassandra', focus: true, closeOnEscape: true }])
  expect(state('confirmAll')).toBe(false)
  expect(state('notice')).toBeNull()
})

test('/cassandra pane with no surface answers that it needs an interactive session and opens nothing', async () => {
  opts.surfaces = []
  expect(await command('pane', { kind: 'sdk' })).toEqual({ text: 'The pane needs an interactive session.', exitCode: 1 })
  expect(opts.opened).toBeUndefined()
})

test('/cassandra pane whose open fails answers with the fallback text', async () => {
  host = { ...host, ui: { ...host.ui, open: async () => { throw new Error('no panes here') } } }
  expect(await command('pane')).toEqual({ text: 'could not read what this project remembers.', exitCode: 1 })
})

test('the render hook draws one row per remembered record', async () => {
  await seedFailure('bun test')
  await seedFailure('npm test')
  const ids = (await remembered()).map((r) => `row:${r.hash.slice(0, 8)}`)
  expect((await rowKeys()).sort()).toEqual(ids.sort())
})

test('the render hook works without a measured body or viewport', async () => {
  await seedFailure()
  const drawn = walk(await paneHook('ui.render')(host, { ...PANE, surface: 'terminal', props: {} }, async () => ({})))
  expect(drawn.filter((n) => n.type === 'Button' && String(n.props.key).startsWith('row:'))).toHaveLength(1)
})

test('the render hook draws the error line when the store cannot be read (Review Focus 4)', async () => {
  await seedFailure()
  wrap = (i) => ({ ...i, list: async () => { throw new Error('boom') } })
  const lines = (await render()).filter((n) => n.type === 'Text').map(textOf)
  expect(lines).toEqual(["Cassandra could not read this project's store."])
})

test('the render hook draws the error line when the state cannot be read', async () => {
  host = { ...host, state: { ...host.state, get: async () => { throw new Error('boom') } } }
  const lines = (await render()).filter((n) => n.type === 'Text').map(textOf)
  expect(lines).toEqual(["Cassandra could not read this project's store."])
})

test('pressing a row selects it', async () => {
  await seedFailure('bun test')
  await seedFailure('npm test')
  const keys = await rowKeys()
  await press(keys[1]!)
  expect(await selectedKey()).toBe(keys[1])
  expect(String(state('selected'))).toStartWith(keys[1]!.slice('row:'.length))
})

test('pressing a row that is gone changes nothing', async () => {
  await press('row:deadbeef')
  expect(state('selected')).toBeUndefined()
})

test('moving focus onto a row selects it; other stops select nothing', async () => {
  await seedFailure('bun test')
  await seedFailure('npm test')
  const keys = await rowKeys()
  await focus(keys[1]!)
  expect(await selectedKey()).toBe(keys[1])
  await focus('forget')
  await focus(undefined)
  expect(await selectedKey()).toBe(keys[1])
})

test('forget forgets exactly the selected record, bumps rev and refreshes the status', async () => {
  await seedFailure('bun test')
  await seedFailure('npm test')
  const keys = await rowKeys()
  await press(keys[1]!)
  opts.statuses = []
  const rev = Number(state('rev') ?? 0)
  await press('forget')
  expect((await remembered()).map((r) => `row:${r.hash.slice(0, 8)}`)).toEqual([keys[0]!])
  expect(Number(state('rev'))).toBeGreaterThan(rev)
  expect(opts.statuses).toEqual(['1 live failure'])
  expect(state('notice')).toBeNull()
})

test('two quick presses of forget never forget an unseen row; each redraw lets the next one act (Review Focus 5)', async () => {
  await seedFailure('bun test')
  await seedFailure('npm test')
  await seedFailure('make')
  await render()
  // The second press finds the drawn row gone and only asks for a redraw.
  const rev = Number(state('rev') ?? 0)
  await Promise.all([press('forget'), press('forget')])
  expect(await remembered()).toHaveLength(2)
  expect(Number(state('rev'))).toBeGreaterThan(rev + 1)
  await render()
  await press('forget')
  expect(await remembered()).toHaveLength(1)
  await render()
  await press('forget')
  expect(await remembered()).toHaveLength(0)
  expect(state('notice')).toBeNull()
  // Nothing left to forget: nothing happens.
  await render()
  await press('forget')
  expect(state('notice')).toBeNull()
})

test('forget-all asks first, and cancel backs out; each clears an old notice', async () => {
  await seedFailure()
  opts.state = new Map<string, unknown>([['notice', 'old failure']])
  await press('forget-all')
  expect(state('notice')).toBeNull()
  expect(state('confirmAll')).toBe(true)
  expect((await render()).some((n) => n.props?.key === 'forget-all-confirm')).toBe(true)
  opts.state.set('notice', 'old failure')
  await press('forget-all-cancel')
  expect(state('notice')).toBeNull()
  expect(state('confirmAll')).toBe(false)
  expect(await remembered()).toHaveLength(1)
})

test('forget-all-confirm forgets every record and the fix notes', async () => {
  await seedFailure('bun test')
  await seedFailure('npm test')
  const paths = await pathsFor(io(), cwd)
  const { writeFix } = await import('../src/core/fixes.ts')
  const fixed = (await remembered())[0]!.hash
  await writeFix(io(), paths, fixed, { kind: 'elsewhere', at: '2026-10-09T00:00:00Z', files: [], more: 0 } as never)
  const { readFix: before } = await import('../src/core/fixes.ts')
  expect(await before(io(), paths, fixed)).not.toBeNull()
  await press('forget-all')
  await render()
  opts.statuses = []
  const rev = Number(state('rev') ?? 0)
  await press('forget-all-confirm')
  expect(await remembered()).toHaveLength(0)
  const { readFix } = await import('../src/core/fixes.ts')
  expect(await readFix(io(), paths, fixed)).toBeNull()
  expect(state('confirmAll')).toBe(false)
  expect(Number(state('rev'))).toBeGreaterThan(rev)
  expect(opts.statuses).toEqual([undefined])
})

test('a forget that fails sets the notice', async () => {
  await seedFailure()
  await render()
  wrap = (i) => ({ ...i, sha256: async () => { throw new Error('boom') } })
  await press('forget')
  expect(state('notice')).toBe('Could not forget the selected record.')
  expect(await remembered()).toHaveLength(1)
  wrap = (i) => i
  await render()
  await press('forget')
  expect(state('notice')).toBeNull()
})

test('a press whose state cannot be written is swallowed and still passes on', async () => {
  await seedFailure()
  opts.stateSetRejects = true
  for (const key of ['forget-all', 'forget-all-cancel', 'row:deadbeef', 'something-else', 'forget']) await press(key)
  await focus('row:deadbeef')
})

test('every status refresh bumps rev, so an open pane redraws by itself', async () => {
  await call('bun test', failed())
  const after = Number(state('rev'))
  expect(after).toBeGreaterThan(0)
  // The same call warns first (one bump for the Just warned card), then passes (one for the refresh).
  await call('bun test', ok())
  expect(Number(state('rev'))).toBe(after + 2)
  await start()
  expect(Number(state('rev'))).toBe(after + 3)
})

test('a single forget whose command answers a non-zero code sets the notice to its text', async () => {
  // A stored hash always forgets, so the shared command is made to refuse here.
  const real = (await import('../src/commands/forget.ts')).forget
  let refuse = true
  mock.module('../src/commands/forget.ts', () => ({
    forget: (...a: Parameters<typeof real>) => (refuse && !a[3] ? Promise.resolve({ code: 1, text: 'No record matching x.' }) : real(...a)),
  }))
  try {
    await seedFailure()
    await render()
    await press('forget')
    expect(state('notice')).toBe('No record matching x.')
    expect(await remembered()).toHaveLength(1)
  } finally {
    refuse = false
  }
  await render()
  await press('forget')
  expect(state('notice')).toBeNull()
  expect(await remembered()).toHaveLength(0)
})

test('a drawing that throws falls back to what lies beneath, and the hook does not reject', async () => {
  await seedFailure()
  const beneath = { type: 'engine', ref: 'pane' }
  host = { ...host, ui: { ...host.ui, resolve: () => { throw new Error('no table') } } }
  const r = await paneHook('ui.render')(host, { ...PANE, surface: 'terminal', props: { bodyColumns: 80 } }, async () => beneath)
  expect(r).toBe(beneath)
})

test('a press or a focus move that fails beneath never rejects', async () => {
  await seedFailure()
  const boom = async () => { throw new Error('beneath') }
  const pressed = await paneHook('ui.press')(host, { ...PANE, plugin: 'cassandra', element: 'forget-all', surface: 'terminal' }, boom)
  expect(pressed).toEqual({ element: 'forget-all' })
  expect(state('confirmAll')).toBe(true)
  const keys = await rowKeys()
  const moved = await paneHook('ui.focus')(host, { ...PANE, element: keys[0], origin: { kind: 'person' } }, boom)
  expect(moved).toEqual({ deny: 'cassandra: the focus could not move.' })
})

// ---- final fix wave ----

const sized = (bodyRows: number, bodyColumns = 100) => render({ bodyColumns, scroll: { offset: 0, bodyRows } })
const shownRows = (drawn: Drawn[]) => drawn.filter((n) => n.type === 'Button' && String(n.props.key).startsWith('row:')).map((n) => String(n.props.key))
/** The lines the pane drew: its root's children, or the one line of a pane that draws only that. */
const drawnLines = (drawn: Drawn[]) => drawn.find((n) => n.props?.key === 'cassandra-pane')?.children.length ?? 1
/** Header, tabs, the History title and the key bar: the rows a short pane spends besides its list. */
const CHROME = 4

test('the window follows the selection: newer records push it down, and forget still acts on it', async () => {
  await seedFailure('bun test')
  await seedFailure('npm test')
  // The chrome, a day label and two rows.
  const two = CHROME + 3
  const before = shownRows(await sized(two))
  expect(before).toHaveLength(2)
  await press(before[1]!)
  await seedFailure('make')
  // The newest record goes above the window; the selected row stays in it.
  expect(shownRows(await sized(two))).toEqual(before)
  await press('forget')
  const left = (await remembered()).map((r) => `row:${r.hash.slice(0, 8)}`)
  expect(left).not.toContain(before[1])
  expect(left).toHaveLength(2)
})

test('/cassandra pane opens only for the person\'s own origins', async () => {
  for (const kind of ['plugin', 'scheduled-trigger']) {
    expect(await command('pane', { kind })).toEqual({ text: 'The pane opens only from your own /cassandra command.', exitCode: 1 })
  }
  expect(await command('pane', undefined)).toEqual({ text: 'The pane opens only from your own /cassandra command.', exitCode: 1 })
  expect(opts.opened).toBeUndefined()
  for (const kind of ['composer', 'bridge', 'sdk']) expect((await command('pane', { kind })).exitCode).toBe(0)
  expect(opts.opened).toHaveLength(3)
})

test('with hundreds of records and a fix note, the rows and the action row fit the body', async () => {
  const paths = await pathsFor(io(), cwd)
  for (let i = 0; i < 200; i++) await seedFailure(`false ${i}`)
  const { writeFix } = await import('../src/core/fixes.ts')
  const newest = (await remembered()).map((r) => r.hash)
  for (const h of newest) await writeFix(io(), paths, h, { kind: 'elsewhere', at: '2026-10-09T00:00:00Z', files: [], more: 0 } as never)
  await press('forget')
  // A failed action leaves a notice line too.
  opts.state!.set('notice', 'Could not forget the selected record.')
  for (const bodyRows of [12, 20, 40]) {
    const drawn = await sized(bodyRows)
    expect(drawnLines(drawn)).toBeLessThanOrEqual(bodyRows)
    expect(drawn.some((n) => n.props?.key === 'action-row')).toBe(true)
    expect(drawn.some((n) => n.props?.key === 'forget')).toBe(true)
  }
}, 30_000)

test('a focus move and a forget right after it act in order: the forget takes the newly focused row', async () => {
  await seedFailure('bun test')
  await seedFailure('npm test')
  const keys = await rowKeys()
  await Promise.all([focus(keys[1]!), press('forget')])
  expect((await remembered()).map((r) => `row:${r.hash.slice(0, 8)}`)).toEqual([keys[0]!])
})

test('forget-all on an empty store asks nothing, and a confirmation the store emptied under is dropped', async () => {
  await press('forget-all')
  expect(state('confirmAll')).not.toBe(true)
  await seedFailure()
  await press('forget-all')
  expect(state('confirmAll')).toBe(true)
  // The store empties another way while the confirmation shows.
  expect((await command('forget --all')).exitCode).toBe(0)
  expect(state('confirmAll')).toBe(false)
  await seedFailure()
  expect((await render()).some((n) => n.props?.key === 'confirm-row')).toBe(false)
})

// ---- Ruling 14: Forget acts only on what this surface drew ----

const idsLeft = async () => (await remembered()).map((r) => `row:${r.hash.slice(0, 8)}`).sort()

test('a newer record recorded between the draw and the press is not forgotten: the drawn row is', async () => {
  await seedFailure('bun test')
  await seedFailure('npm test')
  const drawnSel = await selectedKey()
  const keys = await rowKeys()
  await seedFailure('make')
  const newest = (await remembered()).map((r) => `row:${r.hash.slice(0, 8)}`).find((k) => !keys.includes(k))!
  await press('forget')
  expect(await idsLeft()).toEqual([...keys.filter((k) => k !== drawnSel), newest].sort())
})

test('two surfaces with different windows each keep the selection in view; a forget on one takes no other row on the other', async () => {
  await seedFailure('bun test')
  await seedFailure('npm test')
  await seedFailure('make')
  const all = await rowKeys()
  const oldest = all[2]!
  await press(oldest)
  const terminal = shownRows(await render({ bodyColumns: 100, scroll: { offset: 0, bodyRows: 30 } }, 'terminal'))
  const desktop = shownRows(await render({ bodyColumns: 100, scroll: { offset: 0, bodyRows: CHROME + 2 } }, 'desktop'))
  expect(terminal).toEqual(all)
  expect(desktop).toEqual([oldest])
  await press('forget', 'desktop')
  expect(await idsLeft()).toEqual([all[0]!, all[1]!].sort())
  // The row the terminal drew as selected is gone: its forget takes nothing else.
  await press('forget', 'terminal')
  expect(await idsLeft()).toEqual([all[0]!, all[1]!].sort())
})

test('focus a drawn row, then f with no redraw between: the focused row is forgotten', async () => {
  await seedFailure('bun test')
  await seedFailure('npm test')
  const keys = await rowKeys()
  expect(await selectedKey()).toBe(keys[0])
  await focus(keys[1]!)
  await press('forget')
  expect(await idsLeft()).toEqual([keys[0]!])
})

test('a press before any draw forgets nothing and asks for a redraw', async () => {
  await seedFailure()
  const rev = Number(state('rev') ?? 0)
  await press('forget')
  expect(await remembered()).toHaveLength(1)
  expect(Number(state('rev'))).toBe(rev + 1)
  await press('forget', 'desktop')
  expect(await remembered()).toHaveLength(1)
})

test('a forget that finds nothing to forget clears an old notice as it asks for a redraw', async () => {
  await seedFailure()
  opts.state = new Map<string, unknown>([['notice', 'Could not forget the selected record.']])
  // Nothing drawn on this surface yet.
  await press('forget')
  expect(state('notice')).toBeNull()
  expect(await remembered()).toHaveLength(1)
  // The drawn row is gone by the press.
  await render()
  opts.state.set('notice', 'Could not forget the selected record.')
  expect((await command('forget --all')).exitCode).toBe(0)
  const rev = Number(state('rev') ?? 0)
  await press('forget')
  expect(state('notice')).toBeNull()
  expect(Number(state('rev'))).toBe(rev + 1)
})

// ---- the confirm forgets exactly the records it counted ----

test('confirm with the count unchanged since the draw forgets every record', async () => {
  await seedFailure('bun test')
  await seedFailure('npm test')
  await press('forget-all')
  await render()
  await press('forget-all-confirm')
  expect(await remembered()).toHaveLength(0)
  expect(state('confirmAll')).toBe(false)
  expect(state('notice')).toBeNull()
})

test('a record added after the draw is kept; the notice names the counts', async () => {
  await seedFailure('bun test')
  await seedFailure('npm test')
  await press('forget-all')
  await render()
  await seedFailure('make')
  const rev = Number(state('rev') ?? 0)
  await press('forget-all-confirm')
  const left = await remembered()
  expect(left.map((r) => r.record.display)).toEqual(['make'])
  expect(state('confirmAll')).toBe(false)
  expect(state('notice')).toBe('Forgot 2 records; 1 newer record was kept.')
  expect(Number(state('rev'))).toBeGreaterThan(rev)
  // Two newer records are counted in the plural.
  await seedFailure('cargo test')
  await seedFailure('go test')
  await press('forget-all')
  await render()
  await seedFailure('a')
  await seedFailure('b')
  await press('forget-all-confirm')
  expect(state('notice')).toBe('Forgot 3 records; 2 newer records were kept.')
})

test('a same-count swap between the draw and the confirm keeps the unseen record and forgets the seen one', async () => {
  await seedFailure('bun test')
  await seedFailure('npm test')
  await press('forget-all')
  await render()
  const { deleteRecord } = await import('../src/core/record.ts')
  const paths = await pathsFor(io(), cwd)
  const [gone] = (await remembered()).filter((r) => r.record.display === 'bun test')
  await deleteRecord(io(), paths, gone!.hash)
  await seedFailure('make')
  await press('forget-all-confirm')
  expect((await remembered()).map((r) => r.record.display)).toEqual(['make'])
  expect(state('notice')).toBe('Forgot 1 record; 1 newer record was kept.')
})

test('a record hidden under the more line is forgotten by the confirm', async () => {
  for (const c of ['one', 'two', 'three', 'four']) await seedFailure(c)
  await press('forget-all')
  const drawn = await sized(6)
  expect(drawn.some((n) => n.type === 'Text' && /^ *\d+ more ↓ *$/.test(textOf(n)))).toBe(true)
  await press('forget-all-confirm')
  expect(await remembered()).toHaveLength(0)
  expect(state('notice')).toBeNull()
})

test('a counted record deleted elsewhere before the confirm: the rest are forgotten without an error', async () => {
  await seedFailure('bun test')
  await seedFailure('npm test')
  await press('forget-all')
  await render()
  const { deleteRecord } = await import('../src/core/record.ts')
  const [first] = await remembered()
  await deleteRecord(io(), await pathsFor(io(), cwd), first!.hash)
  await press('forget-all-confirm')
  expect(await remembered()).toHaveLength(0)
  expect(state('notice')).toBeNull()
})

test('a fix note that cannot be removed gives the could-not-forget notice and still forgets the records', async () => {
  await seedFailure('bun test')
  await seedFailure('npm test')
  const { writeFix } = await import('../src/core/fixes.ts')
  const first = (await remembered())[0]!.hash
  await writeFix(io(), await pathsFor(io(), cwd), first, { kind: 'elsewhere', at: '2026-10-09T00:00:00Z', files: [], more: 0 } as never)
  await press('forget-all')
  await render()
  wrap = (i) => ({ ...i, remove: async (p) => { if (p.includes('fixes')) throw new Error('boom'); return i.remove(p) } })
  await press('forget-all-confirm')
  wrap = (i) => i
  expect(state('notice')).toBe('Could not forget every record.')
  expect(state('confirmAll')).toBe(false)
  expect(await remembered()).toHaveLength(0)
})

test('a record delete that fails quietly gives the could-not-forget notice', async () => {
  await seedFailure('bun test')
  await seedFailure('npm test')
  await press('forget-all')
  await render()
  wrap = (i) => ({ ...i, remove: async (p) => { if (p.includes('records')) throw new Error('boom'); return i.remove(p) } })
  await press('forget-all-confirm')
  wrap = (i) => i
  expect(state('notice')).toBe('Could not forget every record.')
  expect(await remembered()).toHaveLength(2)
})

test('a body under four lines draws the single too-short line', async () => {
  await seedFailure()
  for (const bodyRows of [1, 2, 3]) {
    const drawn = await sized(bodyRows)
    expect(drawn.filter((n) => n.type === 'Text').map(textOf)).toEqual(['Pane too short; make the window taller.'])
    expect(drawn.some((n) => n.type === 'Button')).toBe(false)
  }
})

test('a confirm on a surface that drew nothing deletes nothing and redraws', async () => {
  await seedFailure()
  await press('forget-all')
  await render({ bodyColumns: 100, scroll: { offset: 0, bodyRows: 30 } }, 'desktop')
  opts.state!.set('notice', 'old')
  const rev = Number(state('rev') ?? 0)
  await press('forget-all-confirm', 'terminal')
  expect(await remembered()).toHaveLength(1)
  expect(state('confirmAll')).toBe(false)
  expect(state('notice')).toBeNull()
  expect(Number(state('rev'))).toBe(rev + 1)
})

test('a confirm whose store cannot be counted deletes nothing and says so; on an empty store it drops the row', async () => {
  await seedFailure()
  await press('forget-all')
  await render()
  wrap = (i) => ({ ...i, list: async () => { throw new Error('boom') } })
  await press('forget-all-confirm')
  expect(state('notice')).toBe('Could not forget every record.')
  wrap = (i) => i
  expect(await remembered()).toHaveLength(1)
  expect((await command('forget --all')).exitCode).toBe(0)
  // The store emptied another way; the confirm row was already up.
  opts.state!.set('confirmAll', true)
  const rev = Number(state('rev') ?? 0)
  await press('forget-all-confirm')
  expect(state('confirmAll')).toBe(false)
  expect(state('notice')).toBeNull()
  expect(Number(state('rev'))).toBe(rev + 1)
})

// ---- short panes: the list gives way, the key bar stays ----

test('a short pane keeps a row and the key bar, never outgrows its body, and keeps the confirm row', async () => {
  for (let i = 0; i < 12; i++) await seedFailure(`false ${i}`)
  opts.state = new Map<string, unknown>([['notice', 'Could not forget the selected record.']])
  const shown: Record<number, number> = {}
  for (const bodyRows of [4, 5, 6, 8, 10]) {
    const drawn = await sized(bodyRows)
    expect(drawn.some((n) => n.props?.key === 'action-row')).toBe(true)
    expect(shownRows(drawn).length).toBeGreaterThanOrEqual(1)
    expect(drawnLines(drawn)).toBeLessThanOrEqual(bodyRows)
    shown[bodyRows] = shownRows(drawn).length
  }
  // Each row past the chrome and the notice goes to the list: a day label, then rows, the last one to `n more ↓`.
  expect(shown).toEqual({ 4: 1, 5: 1, 6: 1, 8: 1, 10: 3 })
  // The notice has its own row once one list row is left beside it.
  expect((await sized(6)).some((n) => n.props?.key === 'notice')).toBe(true)
  expect((await sized(5)).some((n) => n.props?.key === 'notice')).toBe(false)
  opts.state.set('confirmAll', true)
  const confirming = await sized(4)
  expect(confirming.some((n) => n.props?.key === 'confirm-row')).toBe(true)
  expect(drawnLines(confirming)).toBeLessThanOrEqual(4)
})

// ---- Forget all, Cancel, Forget; and a hot reload ----

test('forget all, cancel, then forget: the forget takes the selected drawn row and the confirmation is gone', async () => {
  await seedFailure('bun test')
  await seedFailure('npm test')
  const keys = await rowKeys()
  await press(keys[1]!)
  await press('forget-all')
  expect((await render()).some((n) => n.props?.key === 'confirm-row')).toBe(true)
  await press('forget-all-cancel')
  expect(state('confirmAll')).toBe(false)
  const drawn = await render()
  expect(drawn.some((n) => n.props?.key === 'action-row')).toBe(true)
  await press('forget')
  expect(await idsLeft()).toEqual([keys[0]!])
  expect(state('confirmAll')).toBe(false)
})

test('after a hot reload, a forget before any redraw does nothing; after a render it works', async () => {
  await seedFailure('bun test')
  await seedFailure('npm test')
  const keys = await rowKeys()
  await press(keys[1]!)
  // A hot reload: the module runs again with fresh module state; `$.state` is kept.
  const reloaded = new Map<string, Hook>()
  install(((event: string, a: unknown, b?: unknown) => {
    const own = event === 'tool.call' && (a as { tool: RegExp }).tool.source.startsWith('^mcp__cassandra__')
    reloaded.set(own ? 'tool.call:cassandra' : event, (b ?? a) as Hook)
  }) as unknown as Parameters<typeof install>[0], (i) => wrap(i))
  hooks = reloaded
  expect(String(state('selected'))).toStartWith(keys[1]!.slice('row:'.length))
  await press('forget')
  expect(await remembered()).toHaveLength(2)
  await render()
  await press('forget')
  expect(await idsLeft()).toEqual([keys[0]!])
})

// ---- view state, keys and the Just warned feed ----

/** The full hash of the row a key names. */
const hashOf = async (key: string) => (await remembered()).find((r) => r.hash.startsWith(key.slice('row:'.length)))!.hash
/** Type into, or press Enter in, one of the pane's Inputs. */
const input = async (element: string, value: string, kind: 'change' | 'submit' = 'submit') => {
  let passed = 0
  const r = await paneHook('ui.input')(host, { ...PANE, plugin: 'cassandra', element, kind, value, surface: 'terminal' }, async (e) => { passed += 1; return { element: e.element, value: e.value } })
  expect(passed).toBe(1)
  return r
}
/** A focus move through the hook, answering what the hook did with it. */
const moveRing = async (element: string, surface?: string) => {
  const landed: Array<string | undefined> = []
  const r = await paneHook('ui.focus')(host, { ...PANE, element, surface, origin: { kind: 'person' } }, async (e) => { landed.push(e.element); return {} })
  return { r, landed }
}

test('a warned call keeps its hash and time as the last warning, and redraws the pane', async () => {
  await call('bun test', failed())
  const rev = Number(state('rev'))
  const { r } = await call('bun test', failed())
  expect(r.context).toHaveLength(1)
  const { hash, record } = (await remembered())[0]!
  // The record as it stood when warned, before this call failed again and bumped it.
  expect(record.count).toBe(2)
  expect(state('lastWarning')).toEqual({ hash, at: expect.any(String), count: 1, lastSeen: expect.any(String), evidence: 'No file under this directory tree has changed since.' })
  expect(Number.isNaN(Date.parse((state('lastWarning') as { at: string }).at))).toBe(false)
  expect(Number(state('rev'))).toBeGreaterThan(rev)
})

test('a surface list that cannot be read still warns; a last warning that cannot be kept still warns', async () => {
  await call('bun test', failed())
  host = { ...host, session: { ...host.session, surfaces: async () => { throw new Error('no surfaces') } } }
  expect((await call('bun test', failed())).r.context).toHaveLength(1)
  opts.stateSetRejects = true
  expect((await call('bun test', failed())).r.context).toHaveLength(1)
})

test('dismiss clears the last warning; o and h toggle the full output and the key list', async () => {
  await call('bun test', failed())
  await call('bun test', failed())
  expect(state('lastWarning')).not.toBeNull()
  await press('dismiss')
  expect(state('lastWarning')).toBeNull()
  await press('full')
  expect(state('showFull')).toBe(true)
  await press('full')
  expect(state('showFull')).toBe(false)
  await press('help')
  expect(state('showKeys')).toBe(true)
  expect((await render()).some((n) => n.props?.key === 'keys-title')).toBe(true)
  // A bar key's hidden twin acts as the key itself.
  await press('twin:help')
  expect(state('showKeys')).toBe(false)
})

test('n and p page through the full output this surface drew, clamped to its first and last page', async () => {
  const long = Array.from({ length: 80 }, (_, i) => `out ${i}`).join('\n')
  await call('bun test', failed(`Exit code 1\n${long}`))
  // Nothing drawn here yet: nothing to page.
  await press('next-page')
  expect(state('fullPage')).toBeUndefined()
  await press('full')
  await render()
  await press('prev-page')
  expect(state('fullPage')).toBe(0)
  await press('next-page')
  expect(state('fullPage')).toBe(1)
  await render()
  await press('twin:prev-page')
  expect(state('fullPage')).toBe(0)
  for (let i = 0; i < 40; i++) {
    await render()
    await press('next-page')
  }
  const last = state('fullPage') as number
  expect(last).toBeGreaterThan(1)
  await render()
  await press('next-page')
  expect(state('fullPage')).toBe(last)
  // A page left past the end, as from a drawing of a longer output, steps back from the last.
  opts.state!.set('fullPage', last + 5)
  await press('prev-page')
  expect(state('fullPage')).toBe(last - 1)
})

test('the full output goes back to its first page when the marker moves, the tab switches, the row closes, o toggles or the pane opens', async () => {
  await seedFailure('bun test')
  await seedFailure('npm test')
  const keys = await rowKeys()
  const paged = () => opts.state!.set('fullPage', 3)
  paged()
  await press('down')
  expect(state('fullPage')).toBe(0)
  paged()
  await press('up')
  expect(state('fullPage')).toBe(0)
  paged()
  await press('tabkey:warnings')
  expect(state('fullPage')).toBe(0)
  paged()
  await press('full')
  expect(state('fullPage')).toBe(0)
  paged()
  await render()
  const marked = (await selectedKey())!
  await press(marked)
  expect(state('fullPage')).toBe(0)
  paged()
  await press(keys.find((k) => k !== marked)!)
  expect(state('fullPage')).toBe(0)
  // The focus marking another row is the marker moving; landing on the marked one is not.
  paged()
  await focus(marked)
  expect(state('fullPage')).toBe(0)
  paged()
  await focus(marked)
  expect(state('fullPage')).toBe(3)
  await command('pane')
  expect(state('fullPage')).toBe(0)
})

test('r marks the selected record as waiting for its retest confirm, and only a retestable one', async () => {
  await seedFailure('bun test')
  await press('retest')
  // Nothing drawn here yet: nothing to retest.
  expect(state('confirmRetest')).toBeUndefined()
  const [key] = await rowKeys()
  await press('retest')
  expect(state('confirmRetest')).toBe(await hashOf(key!))
  opts.state!.set('confirmRetest', null)
  await call('echo nope', { deny: 'blocked' })
  await press(`${(await rowKeys()).find((k) => k !== key)!}`)
  await render()
  await press('retest')
  expect(state('confirmRetest')).toBeNull()
})

test('j and k move the marker along the drawn list, stop at its ends, and take the ring with it', async () => {
  await seedFailure('bun test')
  await seedFailure('npm test')
  await seedFailure('cargo test')
  const keys = await rowKeys()
  await press('down')
  expect(state('selected')).toBe(await hashOf(keys[1]!))
  expect(opts.focused).toEqual([keys[1]])
  await press('down')
  await press('down')
  expect(state('selected')).toBe(await hashOf(keys[2]!))
  await press('up')
  expect(state('selected')).toBe(await hashOf(keys[1]!))
  for (let i = 0; i < 3; i++) await press('up')
  expect(state('selected')).toBe(await hashOf(keys[0]!))
  expect(opts.focused?.at(-1)).toBe(keys[0])
})

test('j on a surface that drew nothing, or drew no rows, moves nothing', async () => {
  await press('down')
  expect(state('selected')).toBeUndefined()
  await render()
  await press('down')
  expect(state('selected')).toBeUndefined()
  expect(opts.focused).toBeUndefined()
})

test('Enter on the marked row opens it in place and again closes it; Enter on another row marks it', async () => {
  await seedFailure('bun test')
  await seedFailure('npm test')
  const keys = await rowKeys()
  await press(keys[0]!)
  expect(state('expanded')).toBe(true)
  expect((await render()).some((n) => n.props?.key === 'detail-why')).toBe(true)
  await press(keys[0]!)
  expect(state('expanded')).toBe(false)
  await press(keys[1]!)
  expect(state('selected')).toBe(await hashOf(keys[1]!))
  expect(state('expanded')).toBe(false)
})

test('switching tab keeps the marked row when the tab lists it, else marks the tab\'s first row, closed', async () => {
  await seedFailure('bun test')
  await call('echo nope', { deny: 'blocked' })
  const denied = (await remembered()).find((r) => r.record.kind === 'denial')!.hash
  const failed = (await remembered()).find((r) => r.record.kind !== 'denial')!.hash
  await render()
  await press(`row:${failed.slice(0, 8)}`)
  await press(`row:${failed.slice(0, 8)}`)
  expect(state('expanded')).toBe(true)
  await press('tabkey:warnings')
  expect(state('tab')).toBe('warnings')
  expect(state('selected')).toBe(failed)
  expect(state('expanded')).toBe(true)
  await press('tab:denied')
  expect(state('tab')).toBe('denied')
  expect(state('selected')).toBe(denied)
  expect(state('expanded')).toBe(false)
  expect(await rowKeys()).toEqual([`row:${denied.slice(0, 8)}`])
})

test('a tab the state holds that is no tab reads as History', async () => {
  await seedFailure('bun test')
  opts.state = new Map<string, unknown>([['tab', 'bogus']])
  expect(await rowKeys()).toHaveLength(1)
  expect((await render()).some((n) => n.props?.key === 'tab:history' && walk(n).some((t) => t.props?.backgroundColor === 'suggestion'))).toBe(true)
})

test('s opens the search and moves the ring into it; typing applies nothing, Enter applies one trimmed line, x clears', async () => {
  await seedFailure('bun test')
  await seedFailure('npm test')
  await press('search')
  expect(state('searching')).toBe(true)
  expect(opts.focused).toEqual(['search-field'])
  // This host's table has no Input, as mobile's: the field's cells show what it holds as text.
  expect((await render()).some((n) => n.props?.key === 'search-field-box')).toBe(true)
  await input('search-field', 'npm', 'change')
  expect(state('query')).toBeUndefined()
  await input('other-field', 'npm')
  expect(state('query')).toBeUndefined()
  expect(await input('search-field', '  npm\n test ')).toEqual({ element: 'search-field', value: '  npm\n test ' })
  expect(state('query')).toBe('npm test')
  expect(state('searching')).toBe(false)
  expect(await rowKeys()).toHaveLength(1)
  expect((await render()).some((n) => n.props?.key === 'search-field-box')).toBe(false)
  expect((await render()).some((n) => n.props?.key === 'search-clear')).toBe(true)
  await press('search-clear')
  expect(state('query')).toBe('')
  expect(await rowKeys()).toHaveLength(2)
})

test('Enter in the search whose state cannot be written changes nothing and still passes on', async () => {
  opts.stateSetRejects = true
  await input('search-field', 'npm')
  expect(state('query')).toBeUndefined()
  const r = await paneHook('ui.input')(host, { ...PANE, plugin: 'cassandra', element: 'search-field', kind: 'submit', value: 'x', surface: 'terminal' }, async () => { throw new Error('beneath') })
  expect(r).toEqual({ element: 'search-field', value: 'x' })
})

test('the ring never rests on a hidden twin: it goes to the tab after it, back past it, or stays', async () => {
  // Forward from outside the tabs onto j's twin: the first tab.
  expect((await moveRing('down')).landed).toEqual(['tab:history'])
  // Forward onto the second tab's twin: the second tab.
  expect((await moveRing('tabkey:warnings')).landed).toEqual(['tab:warnings'])
  // Back from the second tab onto its own twin: the tab before.
  expect((await moveRing('tabkey:warnings')).landed).toEqual(['tab:history'])
  // Back from the first tab onto its twin: nothing before it, the ring stays.
  expect(await moveRing('tabkey:history')).toEqual({ r: {}, landed: [] })
  expect(await moveRing('up')).toEqual({ r: {}, landed: [] })
  // A bar key's twin is never a stop.
  expect(await moveRing('twin:help')).toEqual({ r: {}, landed: [] })
  // Any other element lands where it was headed.
  expect((await moveRing('forget')).landed).toEqual(['forget'])
})

test('the ring a surface rests on is its own: another surface walking back onto a twin goes forward', async () => {
  expect((await moveRing('tab:warnings', 'terminal')).landed).toEqual(['tab:warnings'])
  // The desktop never rested on that tab, so its walk onto the twin is a forward one.
  expect((await moveRing('tabkey:warnings', 'desktop')).landed).toEqual(['tab:warnings'])
  // The terminal did, so its walk onto the twin is a backward one.
  expect((await moveRing('tabkey:warnings', 'terminal')).landed).toEqual(['tab:history'])
})

test('a ring move that fails beneath is not remembered as where the ring rests', async () => {
  const r = await paneHook('ui.focus')(host, { ...PANE, element: 'tab:warnings', surface: 'terminal', origin: { kind: 'person' } }, async () => { throw new Error('beneath') })
  expect(r).toEqual({ deny: 'cassandra: the focus could not move.' })
  expect((await moveRing('tabkey:warnings', 'terminal')).landed).toEqual(['tab:warnings'])
})

test('opening the pane drops a waiting retest confirm', async () => {
  opts.state = new Map<string, unknown>([['confirmRetest', 'abc']])
  await command('pane')
  expect(state('confirmRetest')).toBeNull()
})

test('opening the pane closes an open search field', async () => {
  opts.state = new Map<string, unknown>([['searching', true]])
  await command('pane')
  expect(state('searching')).toBe(false)
})

/**
 * Route the mod's own `$.tool.call` back through its tracked hook, as the engine does, with
 * the engine beneath answering `answer`; `aborted` marks the dispatch interrupted.
 */
function retestsThrough(answer: () => ToolCallOutcome, aborted = false, before: () => Promise<void> = async () => undefined): void {
  opts.toolCall = async (args) => {
    await before()
    const next = Object.assign(async () => { ran += 1; return answer() }, { signal: { aborted } as AbortSignal, origin: { plugin: 'cassandra' } })
    return (hooks.get('tool.call') as unknown as ($: ModEngine, e: ToolCallEvent, n: typeof next) => Promise<ToolCallOutcome>)(host, args as ToolCallEvent, next)
  }
}

/** How many retest calls reached the engine beneath. */
let ran = 0

/** Draw, press `r`, draw the confirm, and press Run. */
async function retestMarked(): Promise<void> {
  await render()
  await press('retest')
  await render()
  await press('retest-confirm')
}

test('a confirmed retest that passes forgets the record, toasts, and logs retest_cleared without a warning', async () => {
  await seedFailure('bun test # retest')
  retestsThrough(ok)
  await retestMarked()
  expect(opts.toolCalls).toEqual([{ command: 'bun test # retest', tool: 'Bash', consent: 'The user pressed "Run" on Cassandra\'s retest of this call.' }])
  expect(opts.toasts).toEqual(['Retest passed; forgotten.'])
  expect(await remembered()).toEqual([])
  const kinds = (await readStats(io(), await pathsFor(io(), cwd))).map((e) => e.kind)
  expect(kinds).toContain('retest_cleared')
  expect(kinds).not.toContain('warned')
  expect(kinds).not.toContain('false_positive')
  expect(state('notice')).toBeNull()
  expect(state('confirmRetest')).toBeNull()
})

test('a confirmed retest that fails updates the record and logs retest_failed', async () => {
  await seedFailure('bun test # still')
  retestsThrough(() => failed())
  await retestMarked()
  expect(opts.toasts).toEqual(['Retest failed again; record updated.'])
  const [r] = await remembered()
  expect(r!.record.count).toBe(2)
  expect((await readStats(io(), await pathsFor(io(), cwd))).map((e) => e.kind)).toEqual(['retest_failed'])
})

test('an interrupted retest changes nothing and says it did not run', async () => {
  await seedFailure('bun test # interrupted')
  retestsThrough(() => failed('Interrupted'), true)
  await retestMarked()
  expect(opts.toasts).toBeUndefined()
  expect(state('notice')).toBe('The retest did not run; nothing changed.')
  expect((await remembered())[0]!.record.count).toBe(1)
})

test('a deny verdict runs nothing; Run without a confirm drawn here runs nothing either', async () => {
  await seedFailure('bun test # deny')
  opts.verdict = 'deny'
  await retestMarked()
  expect(opts.toolCalls).toBeUndefined()
  expect(state('notice')).toBe('Your permission settings deny this call; nothing ran.')
  opts.verdict = 'allow'
  // A confirm another surface drew: this one never showed the call.
  await press('retest')
  await press('retest-confirm', 'desktop')
  expect(opts.toolCalls).toBeUndefined()
  expect(state('confirmRetest')).toBeNull()
})

test('a retest whose call the engine never lets reach the hook says its outcome was not recorded', async () => {
  await seedFailure('bun test # unhooked')
  await retestMarked()
  expect(opts.toolCalls).toHaveLength(1)
  expect(state('notice')).toBe('The retest ran, but Cassandra could not record its outcome.')
})

test('j and tab switches drop a waiting retest; Cancel drops it too', async () => {
  await seedFailure('bun test # one')
  await seedFailure('bun test # two')
  await render()
  await press('retest')
  expect(state('confirmRetest')).not.toBeNull()
  await press('down')
  expect(state('confirmRetest')).toBeNull()
  await render()
  await press('retest')
  await press('tab:warnings')
  expect(state('confirmRetest')).toBeNull()
  await render()
  await press('retest')
  await press('retest-cancel')
  expect(state('confirmRetest')).toBeNull()
})

test('a retest whose shell moved before the call reaches the hook is refused, and nothing runs', async () => {
  await seedFailure('bun test # moved')
  ran = 0
  retestsThrough(ok, false, async () => { opts.cwd = join(tmp, 'elsewhere') })
  await render()
  await press('retest')
  await render()
  await press('retest-confirm')
  expect(ran).toBe(0)
  opts.cwd = cwd
  expect(state('notice')).toBe(`Retest refused: the shell is now in ${join(tmp, 'elsewhere')}, not ${cwd}.`)
  expect((await remembered())[0]!.record.count).toBe(1)
})

test('the refusal names both directories', async () => {
  await seedFailure('bun test # moved again')
  const elsewhere = join(tmp, 'elsewhere')
  let r: unknown
  opts.toolCall = async (args) => {
    opts.cwd = elsewhere
    const next = Object.assign(async () => ok(), { signal: { aborted: false } as AbortSignal, origin: { plugin: 'cassandra' } })
    r = await (hooks.get('tool.call') as unknown as ($: ModEngine, e: ToolCallEvent, n: typeof next) => Promise<ToolCallOutcome>)(host, args as ToolCallEvent, next)
    return r
  }
  await retestMarked()
  opts.cwd = cwd
  expect(r).toEqual({ deny: `Retest refused: the shell is now in ${elsewhere}, not ${cwd}.` })
})

test('a model call with the same fingerprint while a retest is pending is warned as usual and leaves the retest its own', async () => {
  await seedFailure('bun test # twin')
  let model: ToolCallOutcome | undefined
  ran = 0
  // The model repeats the call while the pane's retest waits: it is the engine's, not the plugin's.
  retestsThrough(ok, false, async () => { model = (await call('bun test # twin', failed())).r })
  await retestMarked()
  expect(model!.context?.join('\n')).toContain('cassandra')
  expect(ran).toBe(1)
  expect(opts.toasts).toEqual(['Retest passed; forgotten.'])
  const kinds = (await readStats(io(), await pathsFor(io(), cwd))).map((e) => e.kind)
  expect(kinds.filter((k) => k === 'warned')).toHaveLength(1)
  expect(kinds).toContain('retest_cleared')
})

test('j moves on from a selection outside the window, as long as the drawing lists it', async () => {
  for (let i = 0; i < 8; i++) await seedFailure(`false # m${i}`)
  const all = (await render()).filter((n) => n.type === 'Button' && String(n.props.key).startsWith('row:')).map((n) => String(n.props.key))
  expect(all).toHaveLength(8)
  const short = { bodyColumns: 70, scroll: { offset: 0, bodyRows: 8 } }
  const window = (await render(short)).filter((n) => n.type === 'Button' && String(n.props.key).startsWith('row:')).map((n) => String(n.props.key))
  expect(window.length).toBeLessThan(6)
  // The selection sits below the window this surface drew, without a redraw since.
  const records = await remembered()
  const hashOf = (key: string) => records.find((r) => r.hash.startsWith(key.slice(4)))!.hash
  opts.state!.set('selected', hashOf(all[6]!))
  await press('down')
  expect(state('selected')).toBe(hashOf(all[7]!))
})

test('the Just warned card draws the record as it was when warned; an older last warning reads the live record', async () => {
  await call('bun test', failed())
  await call('bun test', failed())
  // The record is now at two tries; the warning was raised at one.
  const card = async () => (await render()).filter((n) => n.type === 'Box' && n.props.key === 'warned-matched').map(textOf)[0]
  expect(await card()).toContain('the same call, 1× before')
  const { hash } = (await remembered())[0]!
  opts.state!.set('lastWarning', { hash, at: new Date().toISOString() })
  expect(await card()).toContain('the same call, 2× before')
})
