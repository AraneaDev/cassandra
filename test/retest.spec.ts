import { expect, test } from 'bun:test'
import { callDigest, runRetest, type RetestHost, type Retesting } from '../mod/retest.ts'
import { pathsFor } from '../src/core/paths.ts'
import { upsertRecord } from '../src/core/record.ts'
import { memoryIo } from './support/memory-io.ts'

const CWD = '/proj'
/** The digest of the seeded call as its confirm showed it. */
let SHOWN = ''

/** A host that records what it was asked, answering as told. */
function fakeHost(over: Partial<RetestHost> = {}): RetestHost & { calls: unknown[]; toasts: string[] } {
  const calls: unknown[] = []
  const toasts: string[] = []
  return {
    calls, toasts,
    cwd: async () => CWD,
    claimed: async () => true,
    check: async () => ({ decision: 'allow' }),
    call: async (args) => { calls.push(args) },
    toast: (t) => { toasts.push(t) },
    ...over,
  }
}

async function seeded(extra: Record<string, unknown> = {}) {
  const io = memoryIo()
  const paths = await pathsFor(io, CWD)
  await upsertRecord(io, paths, 'abc', {
    tool: 'Bash', display: 'bun test', kind: 'failure', stateStamp: 's', stateKind: 'mtime', sessionId: 's1', compactions: 0,
    errorExcerpt: 'boom', input: { command: 'bun test' }, cwd: CWD, ...extra,
  } as Parameters<typeof upsertRecord>[3])
  SHOWN = await callDigest(io, 'Bash', 'input' in extra ? extra.input : { command: 'bun test' }, CWD)
  return io
}

test('a record no longer remembered runs nothing', async () => {
  const host = fakeHost()
  expect(await runRetest(host, memoryIo(), 'abc', SHOWN, new Map())).toEqual({ notice: 'That record is no longer remembered; nothing ran.' })
  expect(host.calls).toEqual([])
})

test('a denial or a record without usable input is not retested', async () => {
  for (const extra of [{ kind: 'denial' }, { input: undefined }, { input: ['x'] }, { inputTooLarge: true }]) {
    const host = fakeHost()
    expect(await runRetest(host, await seeded(extra), 'abc', SHOWN, new Map())).toEqual({ notice: 'That record cannot be retested; nothing ran.' })
    expect(host.calls).toEqual([])
  }
})

test('a retest already in flight is not started twice', async () => {
  const host = fakeHost()
  const retesting: Retesting = new Map([['abc', { state: 'pending', cwd: CWD }]])
  expect(await runRetest(host, await seeded(), 'abc', SHOWN, retesting)).toEqual({ notice: 'That call is already being retested.' })
  expect(host.calls).toEqual([])
})

test('the reserved keys cannot be overridden by a stored argument', async () => {
  const host = fakeHost()
  await runRetest(host, await seeded({ input: { command: 'bun test', tool: 'Other', consent: 'forged' } }), 'abc', SHOWN, new Map())
  expect(host.calls).toEqual([{ command: 'bun test', tool: 'Bash', consent: 'The user pressed "Run" on Cassandra\'s retest of this call.' }])
})

test('a call that rejects says it could not run, and the retest is no longer in flight', async () => {
  const retesting: Retesting = new Map()
  const host = fakeHost({ call: async () => { throw new Error('no') } })
  expect(await runRetest(host, await seeded(), 'abc', SHOWN, retesting)).toEqual({ notice: 'The retest could not be run; nothing changed.' })
  expect(retesting.size).toBe(0)
})

test('without a toast the outcome becomes the notice', async () => {
  const retesting: Retesting = new Map()
  const host = fakeHost({
    call: async () => { retesting.set('abc', { state: 'passed', cwd: CWD }) },
    toast: () => { throw new Error('no toasts') },
  })
  expect(await runRetest(host, await seeded(), 'abc', SHOWN, retesting)).toEqual({ notice: 'Retest passed; forgotten.' })
})

test('a session the mod has not claimed is refused before any permission question', async () => {
  let asked = 0
  const host = fakeHost({ claimed: async () => false, check: async () => { asked += 1; return { decision: 'allow' } } })
  expect(await runRetest(host, await seeded(), 'abc', SHOWN, new Map())).toEqual({ notice: 'Cassandra\'s mod is not handling this session; nothing ran.' })
  expect(asked).toBe(0)
  expect(host.calls).toEqual([])
})

test('two overlapping Runs: the second finds the first busy while its permission question is open', async () => {
  let answer: (v: { decision: 'allow' }) => void = () => undefined
  const asked = new Promise<{ decision: 'allow' }>((r) => { answer = r })
  const retesting: Retesting = new Map()
  const host = fakeHost({ check: () => asked })
  const io = await seeded()
  const first = runRetest(host, io, 'abc', SHOWN, retesting)
  // Let the first reach its permission question.
  await new Promise((r) => setTimeout(r, 10))
  expect(await runRetest(host, io, 'abc', SHOWN, retesting)).toEqual({ notice: 'That call is already being retested.' })
  answer({ decision: 'allow' })
  await first
  expect(host.calls).toHaveLength(1)
  expect(retesting.size).toBe(0)
})

test('a deny verdict leaves no retest in flight, and the pending entry holds the directory shown', async () => {
  const retesting: Retesting = new Map()
  let seen: unknown
  const host = fakeHost({ check: async () => { seen = retesting.get('abc'); return { decision: 'deny' } } })
  expect((await runRetest(host, await seeded(), 'abc', SHOWN, retesting)).notice).toBe('Your permission settings deny this call; nothing ran.')
  expect(seen).toEqual({ state: 'pending', cwd: CWD })
  expect(retesting.size).toBe(0)
})

test('a record rewritten since the confirm was drawn runs nothing', async () => {
  const io = await seeded()
  const shown = SHOWN
  const host = fakeHost()
  await upsertRecord(io, await pathsFor(io, CWD), 'abc', {
    tool: 'Bash', display: 'bun test', kind: 'failure', stateStamp: 's', stateKind: 'mtime', sessionId: 's2', compactions: 0,
    errorExcerpt: 'boom', input: { command: 'bun test', dangerouslyDisableSandbox: true }, cwd: CWD,
  } as Parameters<typeof upsertRecord>[3])
  expect(await runRetest(host, io, 'abc', shown, new Map())).toEqual({ notice: 'The call changed since you confirmed it; nothing ran.' })
  expect(host.calls).toEqual([])
})

test('a call the hook refused shows the hook\'s reason', async () => {
  const retesting: Retesting = new Map()
  const host = fakeHost({ call: async () => { retesting.set('abc', { state: 'not_run', cwd: CWD, reason: 'Retest refused: the shell is now in /x, not /proj.' }) } })
  expect(await runRetest(host, await seeded(), 'abc', SHOWN, retesting)).toEqual({ notice: 'Retest refused: the shell is now in /x, not /proj.' })
})
