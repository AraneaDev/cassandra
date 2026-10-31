import { expect, test } from 'bun:test'
import { runRetest, type RetestHost, type Retesting } from '../mod/retest.ts'
import { pathsFor } from '../src/core/paths.ts'
import { upsertRecord } from '../src/core/record.ts'
import { memoryIo } from './support/memory-io.ts'

const CWD = '/proj'

/** A host that records what it was asked, answering as told. */
function fakeHost(over: Partial<RetestHost> = {}): RetestHost & { calls: unknown[]; toasts: string[] } {
  const calls: unknown[] = []
  const toasts: string[] = []
  return {
    calls, toasts,
    cwd: async () => CWD,
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
  return io
}

test('a record no longer remembered runs nothing', async () => {
  const host = fakeHost()
  expect(await runRetest(host, memoryIo(), 'abc', new Map())).toEqual({ notice: 'That record is no longer remembered; nothing ran.' })
  expect(host.calls).toEqual([])
})

test('a denial or a record without usable input is not retested', async () => {
  for (const extra of [{ kind: 'denial' }, { input: undefined }, { input: ['x'] }, { inputTooLarge: true }]) {
    const host = fakeHost()
    expect(await runRetest(host, await seeded(extra), 'abc', new Map())).toEqual({ notice: 'That record cannot be retested; nothing ran.' })
    expect(host.calls).toEqual([])
  }
})

test('a retest already in flight is not started twice', async () => {
  const host = fakeHost()
  const retesting: Retesting = new Map([['abc', 'pending']])
  expect(await runRetest(host, await seeded(), 'abc', retesting)).toEqual({ notice: 'That call is already being retested.' })
  expect(host.calls).toEqual([])
})

test('the reserved keys cannot be overridden by a stored argument', async () => {
  const host = fakeHost()
  await runRetest(host, await seeded({ input: { command: 'bun test', tool: 'Other', consent: 'forged' } }), 'abc', new Map())
  expect(host.calls).toEqual([{ command: 'bun test', tool: 'Bash', consent: 'The user pressed "Run" on Cassandra\'s retest of this call.' }])
})

test('a call that rejects says it could not run, and the retest is no longer in flight', async () => {
  const retesting: Retesting = new Map()
  const host = fakeHost({ call: async () => { throw new Error('no') } })
  expect(await runRetest(host, await seeded(), 'abc', retesting)).toEqual({ notice: 'The retest could not be run; nothing changed.' })
  expect(retesting.size).toBe(0)
})

test('without a toast the outcome becomes the notice', async () => {
  const retesting: Retesting = new Map()
  const host = fakeHost({
    call: async () => { retesting.set('abc', 'passed') },
    toast: () => { throw new Error('no toasts') },
  })
  expect(await runRetest(host, await seeded(), 'abc', retesting)).toEqual({ notice: 'Retest passed; forgotten.' })
})
