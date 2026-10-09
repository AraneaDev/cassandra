import { history, reason, scopeOf } from './describe.ts'
import { digestText, liveRecords } from './digest.ts'
import { sanitiseExcerpt } from './engine.ts'
import { fingerprint } from './fingerprint.ts'
import { stateStamp, unchanged } from './freshness.ts'
import type { Io } from './io.ts'
import { OWN_TOOL_PREFIX } from './own-tools.ts'
import { pathsFor } from './paths.ts'
import { deleteRecord, readRecord } from './record.ts'
import { explainResolution, resolveHash } from './resolve.ts'
import { appendStat } from './stats.ts'

/** How the engine lists this plugin's tools to the model (confirmed by the tools spike). */
export const TOOL_PREFIX = OWN_TOOL_PREFIX

/** What the model reads about `query`. One sentence: tool descriptions ride every request. */
export const QUERY_TOOL = {
  name: 'query',
  description: 'Ask whether a command already failed in this project and nothing has changed since, or with no command, list the calls that are known dead ends right now.',
  inputSchema: { type: 'object', properties: { command: { type: 'string', description: 'a Bash command, exactly as it was run' } } },
}

/** What the model reads about `resolve`. */
export const RESOLVE_TOOL = {
  name: 'resolve',
  description: 'Tell Cassandra a remembered failure was fixed outside this repository, so it stops warning about it. If the call fails again it is remembered again.',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'a Bash command, exactly as it was run' },
      id: { type: 'string', description: 'the 8-character id that query lists' },
      reason: { type: 'string', description: 'what was fixed, and where' },
    },
    required: ['reason'],
  },
}

const say = (text: string): string => `cassandra: ${text}`

function fieldsOf(input: unknown): Record<string, unknown> {
  return input !== null && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {}
}

/**
 * The answer to `query`. With a command: that Bash command's record and whether the
 * workspace moved since. Without: the live dead ends, each with the id `resolve` takes.
 * Read-only, and never throws: anything that goes wrong is said in the answer.
 */
export async function queryText(io: Io, cwd: string, input: unknown): Promise<string> {
  try {
    const { command } = fieldsOf(input)
    if (command !== undefined && typeof command !== 'string') return say('`command` must be a string.')
    if (command === undefined || command.trim() === '') {
      const live = await liveRecords(io, cwd)
      if (!live) return say('No live failures are remembered in this project.')
      const lines = digestText(live.records, live.kind).split('\n')
      const withIds = [lines[0], ...live.records.map((r, i) => `${lines[i + 1]} [${r.hash.slice(0, 8)}]`)]
      const more = live.total - live.records.length
      if (more > 0) withIds.push(`…and ${more} more live ${more === 1 ? 'failure' : 'failures'}.`)
      return withIds.join('\n')
    }
    const hash = await fingerprint(io, 'Bash', { command })
    const record = hash ? await readRecord(io, await pathsFor(io, cwd), hash) : null
    if (!hash || !record) return say('No failure of this command is remembered in this project.')
    const stamp = await stateStamp(io, cwd)
    let verdict = 'Cassandra cannot tell whether anything has changed since.'
    if (record.stateKind !== 'none' && stamp.kind !== 'none') {
      const scope = scopeOf(record.stateKind)
      verdict = unchanged(record.stateStamp, record.stateKind, stamp)
        ? `Nothing in ${scope} has changed since.`
        : `Something in ${scope} has changed since, so a retry may be legitimate.`
    }
    return say(`${history(record)}, most recently ${record.lastSeen}.${reason(record)} ${verdict}`)
  } catch {
    return say('could not read what this project remembers.')
  }
}

/**
 * The answer to `resolve`: forget one record the agent says was fixed outside the
 * repository, and log the stated reason, sanitised like any tool output Cassandra keeps.
 * A wrong claim costs one more failure, which is remembered again. Never throws.
 */
export async function resolveFailure(io: Io, cwd: string, input: unknown): Promise<string> {
  try {
    const { command, id, reason: why } = fieldsOf(input)
    if ((command === undefined) === (id === undefined)) return say('Name the failure by exactly one of `command` or `id`.')
    if (command !== undefined && typeof command !== 'string') return say('`command` must be a string.')
    if (id !== undefined && typeof id !== 'string') return say('`id` must be a string.')
    const stated = typeof why === 'string' ? sanitiseExcerpt(why) : ''
    if (!stated) return say('Give a `reason`: what was fixed, and where.')

    const paths = await pathsFor(io, cwd)
    let hash: string | null
    if (typeof command === 'string') {
      hash = await fingerprint(io, 'Bash', { command })
      if (!hash || !(await readRecord(io, paths, hash))) return say(`No remembered failure matches \`${command}\`.`)
    } else {
      const r = await resolveHash(io, paths, id as string)
      if (!r.ok) return say(explainResolution(id as string, r))
      hash = r.hash
    }
    const record = await readRecord(io, paths, hash)
    if (!record) return say(`No remembered failure matches ${typeof command === 'string' ? `\`${command}\`` : id}.`)
    await deleteRecord(io, paths, hash)
    await appendStat(io, paths, { kind: 'resolved', hash, reason: stated })
    return say(`Forgot \`${record.display}\` [${hash.slice(0, 8)}]. If it fails again it will be remembered again.`)
  } catch {
    return say('could not change what this project remembers.')
  }
}
