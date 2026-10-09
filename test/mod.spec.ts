import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { install, type ModEngine, type Next, type ToolCallEvent, type ToolCallOutcome } from '../mod/install.ts'
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
  expect(r.context?.[0]).toStartWith('cassandra: `bun test` failed once before')
})

test('the warning is appended to context another plugin already set', async () => {
  await call('bun test', failed())
  const { r } = await call('bun test', { ...failed(), context: ['from another plugin'] })
  expect(r.context).toEqual(['from another plugin', expect.stringContaining('cassandra:')])
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
  const { toolInput } = await import('../mod/install.ts')
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
  const { TRACKED } = await import('../mod/install.ts')
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
  expect(opts.statuses.at(-1)).toBe('cassandra: 1 live failure')
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
  expect(opts.statuses).toStrictEqual(['cassandra: 1 live failure'])
  await call('bun test', ok())
  expect(opts.statuses).toStrictEqual(['cassandra: 1 live failure', undefined])
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
const render = async (props: Record<string, unknown> = { bodyColumns: 100, scroll: { offset: 0, bodyRows: 30 } }) =>
  walk(await paneHook('ui.render')(host, { ...PANE, surface: 'terminal', props, viewport: { columns: 120, rows: 40 } }, async () => ({})))
const rowKeys = async () => (await render()).filter((n) => n.type === 'Button' && String(n.props.key).startsWith('row:')).map((n) => String(n.props.key))
const selectedKey = async () => (await render()).filter((n) => n.type === 'Button' && textOf(n).startsWith('▸')).map((n) => String(n.props.key))[0]
const press = async (element: string) => {
  let passed = 0
  const r = await paneHook('ui.press')(host, { ...PANE, plugin: 'cassandra', element, surface: 'terminal' }, async (e) => { passed += 1; return { element: e.element } })
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
  expect(opts.statuses).toEqual(['cassandra: 1 live failure'])
  expect(state('notice')).toBeNull()
})

test('two quick presses of forget forget two different records (Review Focus 5)', async () => {
  await seedFailure('bun test')
  await seedFailure('npm test')
  await seedFailure('make')
  await Promise.all([press('forget'), press('forget')])
  expect(await remembered()).toHaveLength(1)
  await press('forget')
  expect(await remembered()).toHaveLength(0)
  expect(state('notice')).toBeNull()
  // Nothing left to forget: nothing happens.
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
  wrap = (i) => ({ ...i, sha256: async () => { throw new Error('boom') } })
  await press('forget')
  expect(state('notice')).toBe('Could not forget the selected record.')
  expect(await remembered()).toHaveLength(1)
  wrap = (i) => i
  await press('forget')
  expect(state('notice')).toBeNull()
})

test('a forget-all whose fix notes cannot all be removed sets the notice to its text', async () => {
  await seedFailure()
  const paths = await pathsFor(io(), cwd)
  const { writeFix } = await import('../src/core/fixes.ts')
  await writeFix(io(), paths, (await remembered())[0]!.hash, { kind: 'elsewhere', at: '2026-10-09T00:00:00Z', files: [], more: 0 } as never)
  wrap = (i) => ({ ...i, remove: async (p) => { if (p.includes('fixes')) throw new Error('boom'); return i.remove(p) } })
  await press('forget-all-confirm')
  expect(String(state('notice'))).toContain('Could not remove some fix notes')
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
  await call('bun test', ok())
  expect(Number(state('rev'))).toBe(after + 1)
  await start()
  expect(Number(state('rev'))).toBe(after + 2)
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
    await press('forget')
    expect(state('notice')).toBe('No record matching x.')
    expect(await remembered()).toHaveLength(1)
  } finally {
    refuse = false
  }
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
