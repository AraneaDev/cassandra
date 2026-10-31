import type { Io } from '../src/core/io.ts'
import { pathsFor } from '../src/core/paths.ts'
import { readRecord } from '../src/core/record.ts'

/**
 * The calls a retest makes, spelled out by the mod (`retestHostOf` in install.ts), so the
 * flow can be driven without the engine. `check` asks the session's permission settings,
 * running nothing; `call` runs the tool as the engine runs any call, permission prompt
 * included.
 */
export interface RetestHost {
  cwd(): Promise<string>
  check(args: { tool: string; input: unknown }): Promise<{ decision: 'allow' | 'ask' | 'deny' }>
  call(args: { tool: string; consent: string; [key: string]: unknown }): Promise<unknown>
  toast(text: string): void
}

/**
 * Where a retest stands, by the record's hash: waiting for its call to reach the tracked
 * hook, being run by it, or what the hook found it came to.
 */
export type RetestState = 'pending' | 'running' | 'passed' | 'failed' | 'not_run'

/** The retests in flight, by the record's hash. The tracked `tool.call` hook settles them. */
export type Retesting = Map<string, RetestState>

/** The person's own words for the press that raised the call, as the engine reads `consent`. */
export const RETEST_CONSENT = 'The user pressed "Run" on Cassandra\'s retest of this call.'

const DENIED = 'Your permission settings deny this call; nothing ran.'
const PASSED = 'Retest passed; forgotten.'
const FAILED = 'Retest failed again; record updated.'
const GONE = 'That record is no longer remembered; nothing ran.'
const NOT_RETESTABLE = 'That record cannot be retested; nothing ran.'
const BUSY = 'That call is already being retested.'
const NOT_RUN = 'The retest did not run; nothing changed.'
const UNRECORDED = 'The retest ran, but Cassandra could not record its outcome.'
const FAILED_TO_RUN = 'The retest could not be run; nothing changed.'

/** A stored input a call can be spread from: a plain object. */
const isArgs = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * Run a remembered call again, after the person confirmed it in the pane. Refuses when the
 * record cannot be retested, when it ran from another directory than this session's, and
 * when the permission settings deny the call: then nothing runs. Otherwise the call goes
 * through `$.tool.call`, the engine's own path, carrying the person's consent; the tracked
 * hook settles it (a pass forgets the record, a failure updates it) without a warning, and
 * the outcome is toasted. Resolves to the notice the pane shows, null when the toast said
 * it all. Rejects only when the store or the session cannot be read.
 */
export async function runRetest(host: RetestHost, io: Io, hash: string, retesting: Retesting): Promise<{ notice: string | null }> {
  const cwd = await host.cwd()
  const record = await readRecord(io, await pathsFor(io, cwd), hash)
  if (record === null) return { notice: GONE }
  if (record.kind === 'denial' || record.inputTooLarge === true || !isArgs(record.input)) return { notice: NOT_RETESTABLE }
  // The directory the confirm showed: the record's, else this session's (as the pane draws it).
  const from = typeof record.cwd === 'string' && record.cwd ? record.cwd : cwd
  if (from !== cwd) return { notice: `Retest runs from ${from}; this session is in ${cwd}.` }
  if (retesting.has(hash)) return { notice: BUSY }
  if ((await host.check({ tool: record.tool, input: record.input })).decision === 'deny') return { notice: DENIED }
  retesting.set(hash, 'pending')
  try {
    // The reserved keys last, so no stored argument can stand in for them.
    await host.call({ ...record.input, tool: record.tool, consent: RETEST_CONSENT })
    const state = retesting.get(hash)
    if (state === 'passed' || state === 'failed') {
      const said = state === 'passed' ? PASSED : FAILED
      try {
        host.toast(said)
        return { notice: null }
      } catch {
        // No toast here: the pane says it instead.
        return { notice: said }
      }
    }
    return { notice: state === 'not_run' ? NOT_RUN : UNRECORDED }
  } catch {
    return { notice: FAILED_TO_RUN }
  } finally {
    retesting.delete(hash)
  }
}
