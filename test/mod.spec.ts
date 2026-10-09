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
