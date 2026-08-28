/**
 * Freshness probe false-positive harness. Tracked risk.
 *
 * A false positive is the probe reporting "unchanged" after something really did
 * change, because that is what makes Cassandra warn about a command that has
 * already been fixed. This harness applies a catalogue of real mutation shapes and
 * asserts the stamp moved for every one.
 *
 * Re-run unchanged at checkpoints FP-2 and FP-3. Any regression is a stop.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { stateStamp } from '../src/freshness'

interface Mutation {
  name: string
  apply: (dir: string) => void
}

const MUTATIONS: Mutation[] = [
  { name: 'edit a tracked file', apply: (d) => writeFileSync(join(d, 'a.txt'), 'changed') },
  { name: 'create a new file', apply: (d) => writeFileSync(join(d, 'new.txt'), 'x') },
  { name: 'delete a file', apply: (d) => rmSync(join(d, 'a.txt'), { force: true }) },
  { name: 'sed -i rewrite', apply: (d) => { Bun.spawnSync(['sed', '-i', 's/one/two/', join(d, 'a.txt')]) } },
  { name: 'heredoc write', apply: (d) => writeFileSync(join(d, 'a.txt'), 'line one\nline two\n') },
  { name: 'same-length rewrite', apply: (d) => writeFileSync(join(d, 'a.txt'), 'ONE') },
  {
    name: 'rewrite with mtime restored',
    apply: (d) => {
      const p = join(d, 'a.txt')
      writeFileSync(p, 'xyz')
      utimesSync(p, new Date(1000000), new Date(1000000))
    },
  },
  {
    name: 'create a nested file',
    apply: (d) => { mkdirSync(join(d, 'sub'), { recursive: true }); writeFileSync(join(d, 'sub', 'c.txt'), 'y') },
  },
  {
    name: 'rename a file',
    apply: (d) => { writeFileSync(join(d, 'renamed.txt'), 'one'); rmSync(join(d, 'a.txt'), { force: true }) },
  },
]

function seed(dir: string, asRepo: boolean): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'a.txt'), 'one')
  if (!asRepo) return
  const run = (...args: string[]): void => {
    Bun.spawnSync(['git', '-C', dir, ...args], { stdout: 'ignore', stderr: 'ignore' })
  }
  run('init', '-q')
  run('config', 'user.email', 't@example.com')
  run('config', 'user.name', 'T')
  run('add', '-A')
  run('commit', '-qm', 'init')
}

function runSynthetic(): number {
  const root = mkdtempSync(join(tmpdir(), 'cass-fp-'))
  let failures = 0
  let total = 0

  for (const asRepo of [true, false]) {
    const mode = asRepo ? 'git  ' : 'mtime'
    for (const m of MUTATIONS) {
      const dir = join(root, `${asRepo ? 'g' : 'm'}-${m.name.replace(/\W+/g, '-')}`)
      seed(dir, asRepo)
      const before = stateStamp(dir)
      m.apply(dir)
      const after = stateStamp(dir)
      total += 1
      const moved = before.value !== after.value && after.kind !== 'none'
      if (!moved) {
        failures += 1
        console.error(`FALSE POSITIVE  [${mode}] ${m.name}: stamp did not move (kind=${after.kind})`)
      }
    }
  }

  rmSync(root, { recursive: true, force: true })
  const rate = ((failures / total) * 100).toFixed(1)
  console.error(`\nfreshness FP harness: ${total - failures}/${total} mutations detected, false-positive rate ${rate}%`)
  return failures === 0 ? 0 : 1
}

/**
 * Real-repository mode. The synthetic harness proves the probe reacts to mutations
 * in a directory built for the purpose. This proves two further things against real
 * trees: that a stamp is stable when genuinely nothing changed, which is what stops
 * Cassandra going silent when it should speak, and that the probe returns in a time
 * the hot path can afford.
 */
function runReal(): number {
  const roots = (process.env.CASSANDRA_FP_ROOTS ?? '/root/talanton,/root/kanon,/root/claude-timestamp,/root/aranea')
    .split(',').map((s) => s.trim()).filter((s) => s.length > 0 && existsSync(s))

  if (roots.length === 0) {
    console.error('fp:real: no candidate repositories found, set CASSANDRA_FP_ROOTS')
    return 0
  }

  let unstable = 0
  let slow = 0
  console.error('fp:real: probing real repositories\n')

  for (const root of roots) {
    const t0 = performance.now()
    const a = stateStamp(root)
    const elapsed = performance.now() - t0
    const b = stateStamp(root)

    const stable = a.value === b.value && a.kind !== 'none'
    if (!stable) unstable += 1
    if (elapsed > 200) slow += 1

    console.error(`  ${stable ? 'stable  ' : 'UNSTABLE'}  ${a.kind.padEnd(5)}  ${elapsed.toFixed(0).padStart(4)}ms  ${root}`)
  }

  console.error(`\nfp:real: ${roots.length - unstable}/${roots.length} stable, ${slow} over the 200ms budget`)
  return unstable === 0 && slow === 0 ? 0 : 1
}

process.exit(process.argv.includes('--real') ? runReal() : runSynthetic())
