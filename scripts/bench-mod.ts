/**
 * In-process cost of the mod's tool.call hook on the miss and hit paths, over a
 * node-backed `$`. This measures Cassandra's own work: the engine's `$` adds its own
 * dispatch cost on top, which `bun run test:mod` cannot time precisely, so the README
 * reports this number as a floor and says so.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { install, type ToolCallOutcome } from '../mod/install.ts'
import { nodeHost } from '../test/support/node-host.ts'

const N = 500
const tmp = mkdtempSync(join(tmpdir(), 'cass-bench-'))
const cwd = join(tmp, 'proj')
mkdirSync(cwd, { recursive: true })
writeFileSync(join(cwd, 'a.txt'), 'x')
Bun.spawnSync(['git', 'init', '-q', cwd])
const host = nodeHost({ cwd, env: { CASSANDRA_HOME: join(tmp, 'home'), HOME: tmp } })
const hooks = new Map<string, (...a: unknown[]) => Promise<ToolCallOutcome>>()
install(((event: string, a: unknown, b?: unknown) => {
  hooks.set(event, (b ?? a) as never)
}) as never)
const hook = hooks.get('tool.call')!
const answer: ToolCallOutcome = { isError: true, result: 'x', text: 'x' }
const next = Object.assign(async () => answer, { signal: { aborted: false } as AbortSignal })
const ok = Object.assign(async () => ({ result: {}, text: '' }), { signal: { aborted: false } as AbortSignal })

function call(id: string, command: string, n: typeof next | typeof ok): Promise<ToolCallOutcome> {
  return hook(host, { tool: 'Bash', tool_use_id: id, command }, n)
}

async function time(label: string, command: string, n: typeof next | typeof ok): Promise<void> {
  const samples: number[] = []
  for (let i = 0; i < N; i += 1) {
    const t0 = performance.now()
    await call(`t${i}`, command.replace('#', String(i)), n)
    samples.push(performance.now() - t0)
  }
  samples.sort((a, b) => a - b)
  const p = (q: number) => samples[Math.floor(q * (N - 1))]!.toFixed(2)
  console.log(`${label.padEnd(6)} p50 ${p(0.5)}ms  p95 ${p(0.95)}ms`)
}

try {
  await time('miss', 'echo miss #', ok)
  await call('seed', 'false', next)
  const probe = await call('probe', 'false', next)
  if (!probe.context?.length) throw new Error('the hit loop would miss: the seeded failure did not warn')
  await time('hit', 'false', next)
  const last = await call('last', 'false', next)
  if (!last.context?.length) throw new Error('the hit loop stopped warning during timing')
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
