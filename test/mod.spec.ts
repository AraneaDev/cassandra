import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
  wrap = (i) => i
  const on = ((event: string, a: unknown, b?: unknown) => {
    hooks.set(event, (b ?? a) as Hook)
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
