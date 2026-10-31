/**
 * Regenerates the README's images in `docs/images/` from staged demo data.
 *
 * Nothing here reads a real session or a real store. A demo project, `acme-api` at
 * `/home/dev/acme-api`, is staged in an in-memory filesystem with git answered by a
 * script: six remembered calls, a fix note, and a stats log. The clock is fixed and the
 * time zone is UTC, so the same commit always draws the same images. Then the pane is
 * drawn by its own code (`scripts/pane-svg.ts`) and `cassandra stats` run by its own
 * command (`scripts/terminal-svg.ts` draws the card).
 *
 * Usage: bun run docs:images [--print]   (--print also prints every image's rows)
 */
process.env.TZ = 'UTC'

import { join } from 'node:path'
import { stats } from '../src/commands/stats.ts'
import { fingerprint, displayFor } from '../src/core/fingerprint.ts'
import { writeFix } from '../src/core/fixes.ts'
import { stateStamp } from '../src/core/freshness.ts'
import { paneModel, type PaneView } from '../src/core/pane.ts'
import { pathsFor, recordPath } from '../src/core/paths.ts'
import type { StatEvent } from '../src/core/stats.ts'
import type { FailureRecord } from '../src/core/types.ts'
import { memoryIo } from '../test/support/memory-io.ts'
import { paneSvg } from './pane-svg.ts'
import { terminalSvg } from './terminal-svg.ts'

const NOW = '2026-10-30T14:32:00.000Z'
const PROJECT = '/home/dev/acme-api'
const SESSION = 'demo-session'
const HEAD = 'a3f9c2e7d41b5f08c6e2a9d3b7f14e05c8a2d6b1'
const OLD_HEAD = '5d2e81c0f9a34b7e6c1d08a2f5b39e47c6d1a0e8'
const DIRTY = ['src/billing/invoice.ts']
const OUT = join(import.meta.dir, '..', 'docs', 'images')

const io = memoryIo()
io.clock.now = NOW
io.env = async (name) => (name === 'CASSANDRA_HOME' ? '/data' : name === 'HOME' ? '/home/dev' : undefined)
io.homeDir = async () => '/home/dev'
io.script = (argv) => {
  const cmd = argv.slice(3).join(' ')
  if (cmd === 'rev-parse HEAD') return { exitCode: 0, stdout: `${HEAD}\n` }
  if (cmd === 'status --porcelain') return { exitCode: 0, stdout: DIRTY.map((p) => ` M ${p}\n`).join('') }
  if (cmd === 'symbolic-ref --short -q HEAD') return { exitCode: 0, stdout: 'feat/invoice-pdf\n' }
  return null
}
await io.writeText(`${PROJECT}/.git/HEAD`, 'ref: refs/heads/feat/invoice-pdf\n')
await io.writeText(`${PROJECT}/package.json`, '{ "name": "acme-api" }\n')

const paths = await pathsFor(io, PROJECT)
const current = await stateStamp(io, PROJECT)

const at = (day: number, hhmm: string): string => `2026-10-${String(day).padStart(2, '0')}T${hhmm}:00.000Z`

interface Staged {
  tool: string; input: unknown; scope?: string; kind?: FailureRecord['kind']
  count: number; firstSeen: string; lastSeen: string; fresh: boolean; excerpt: string; full?: string
}

/** Every remembered call, newest first in the pane. `fresh` ones match the workspace now and would warn. */
const STAGED: Record<string, Staged> = {
  billing: {
    tool: 'Bash', input: { command: 'bun test test/billing.test.ts', description: 'Run the billing tests' },
    count: 3, firstSeen: at(30, '13:58'), lastSeen: at(30, '14:29'), fresh: true,
    excerpt: 'Exit code 1 (fail) invoice total > rounds half-cents up · Expected: 1999 Received: 2000',
    full: [
      'Exit code 1',
      'bun test v1.1.38',
      '',
      'test/billing.test.ts:',
      '(pass) invoice total > sums line items',
      '(fail) invoice total > rounds half-cents up',
      '  Expected: 1999',
      '  Received: 2000',
      '',
      ' 1 pass',
      ' 1 fail',
    ].join('\n'),
  },
  pr: {
    tool: 'Bash', input: { command: 'gh pr create --base main --fill' },
    count: 2, firstSeen: at(30, '10:47'), lastSeen: at(30, '11:05'), fresh: false,
    excerpt: 'Exit code 1 pull request create failed: GraphQL: No commits between main and feat/invoice-pdf',
  },
  query: {
    tool: 'mcp__db__query', input: { sql: "select id, total from invoices where status = 'void'" },
    count: 1, firstSeen: at(29, '16:40'), lastSeen: at(29, '16:40'), fresh: true,
    excerpt: 'error: column "status" does not exist (hint: perhaps you meant "state")',
  },
  lint: {
    tool: 'Bash', input: { command: 'bun run lint' }, scope: 'packages/web',
    count: 2, firstSeen: at(28, '09:12'), lastSeen: at(29, '09:40'), fresh: true,
    excerpt: 'Exit code 2 src/routes/invoices.tsx 41:7 error \'total\' is assigned a value but never used',
  },
  curl: {
    tool: 'Bash', input: { command: 'curl -fsSL https://staging.acme.test/healthz' }, kind: 'denial',
    count: 1, firstSeen: at(28, '15:03'), lastSeen: at(28, '15:03'), fresh: false,
    excerpt: 'Denied in auto mode: network access to a host outside the allowlist',
  },
  docker: {
    tool: 'Bash', input: { command: 'docker compose up -d db' },
    count: 1, firstSeen: at(21, '08:55'), lastSeen: at(21, '08:55'), fresh: false,
    excerpt: 'Exit code 1 Error response from daemon: port 5432 is already allocated',
  },
}

const hashes: Record<string, string> = {}
for (const [name, s] of Object.entries(STAGED)) {
  const hash = await fingerprint(io, s.tool, s.input, s.scope ?? '')
  if (hash === null) throw new Error(`no fingerprint for ${name}`)
  hashes[name] = hash
  const record: FailureRecord = {
    tool: s.tool, display: displayFor(s.tool, s.input), ...(s.scope === undefined ? {} : { scope: s.scope }),
    kind: s.kind ?? 'failure', count: s.count,
    stateStamp: s.fresh ? current.value : 'f00dfeedc0ffee00', stateKind: 'git',
    sessionId: SESSION, compactions: 0, firstSeen: s.firstSeen, lastSeen: s.lastSeen,
    errorExcerpt: s.excerpt, ...(s.full === undefined ? {} : { errorFull: s.full }),
    input: s.input, cwd: s.scope === undefined ? PROJECT : `${PROJECT}/${s.scope}`,
    gitHead: s.fresh ? HEAD : OLD_HEAD, dirty: s.fresh ? DIRTY : [],
  }
  await io.writeText(recordPath(paths, hash), JSON.stringify(record))
}
await writeFix(io, paths, hashes.billing!, { kind: 'changed', files: ['src/billing/rounding.ts'], more: 0, at: at(27, '17:20') })
await writeFix(io, paths, hashes.lint!, { kind: 'changed', files: ['packages/web/eslint.config.js'], more: 0, at: at(26, '11:02') })

/** The stats log: warnings across each boundary, their outcomes, briefings, fixes and retests. */
const events: StatEvent[] = []
const add = (t: string, kind: StatEvent['kind'], over: Partial<StatEvent> = {}): void => {
  events.push({ t, kind, ...(kind === 'briefed' ? {} : { hash: over.hash ?? hashes.billing! }), ...over })
}
const boundaries: Array<[NonNullable<StatEvent['boundary']>, number]> = [['session', 7], ['subagent', 4], ['compaction', 3], ['same_context', 2]]
let minute = 0
for (const [boundary, n] of boundaries) {
  for (let i = 0; i < n; i++) add(at(20 + (minute++ % 9), '10:00'), 'warned', { boundary, hash: hashes.docker!, sessionId: 'earlier' })
}
for (let i = 0; i < 11; i++) add(at(22, '12:00'), 'confirmed', { hash: hashes.docker! })
add(at(24, '12:00'), 'false_positive', { hash: hashes.query! })
add(at(25, '09:00'), 'briefed', { boundary: 'subagent', hashes: [hashes.lint!, hashes.query!] })
add(at(26, '09:00'), 'briefed', { boundary: 'subagent', hashes: [hashes.lint!] })
add(at(27, '09:00'), 'briefed', { boundary: 'compaction', hashes: [hashes.docker!, hashes.lint!] })
add(at(26, '11:02'), 'fixed', { hash: hashes.lint!, files: 1 })
add(at(27, '17:20'), 'fixed', { hash: hashes.billing!, files: 1 })
add(at(30, '14:12'), 'warned', { boundary: 'compaction', hash: hashes.query!, sessionId: SESSION })
add(at(30, '14:31'), 'warned', { boundary: 'session', hash: hashes.billing!, sessionId: SESSION, fixNote: true })
add(at(30, '13:40'), 'retest_cleared', { hash: hashes.docker! })
await io.writeText(paths.stats, events.map((e) => JSON.stringify(e)).join('\n') + '\n')

const VIEW: PaneView = {
  tab: 'history', selected: null, expanded: false, confirmAll: false, confirmRetest: null,
  showFull: false, query: '', notice: null, lastWarning: null,
}
const warned: PaneView['lastWarning'] = { hash: hashes.billing!, at: at(30, '14:31') }

const print = process.argv.includes('--print')
async function write(name: string, svg: string, text: string[]): Promise<void> {
  await Bun.write(join(OUT, name), svg)
  console.log(`docs/images/${name}  ${text.length} lines`)
  if (print) console.log(text.map((l) => `  |${l}|`).join('\n'))
}

// The hero: a wide pane, the warning it just raised, the lint record opened with its fix note.
const hero = await paneModel(io, PROJECT, { ...VIEW, selected: hashes.lint!, expanded: true, lastWarning: warned }, SESSION)
const wide = paneSvg(hero, 120, 35)
await write('pane.svg', wide.svg, wide.text)

// The same pane at phone width, where the tabs fall back to digits and the counters to one line.
const narrow = paneSvg(hero, 44, 33)
await write('narrow.svg', narrow.svg, narrow.text)

// The retest confirm for the billing test: the exact command and where it runs.
const retest = await paneModel(io, PROJECT, { ...VIEW, selected: hashes.billing!, confirmRetest: hashes.billing! }, SESSION)
const confirm = paneSvg(retest, 84, 22)
await write('retest.svg', confirm.svg, confirm.text)

const report = await stats(io, paths)
await write('stats.svg', terminalSvg('cassandra stats', report.text), report.text.split('\n'))
