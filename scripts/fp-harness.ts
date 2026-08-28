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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
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
    name: 'rewrite with backdated mtime',
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

function seed(dir: string, asRepo: boolean, opts: { headless?: boolean } = {}): void {
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
  if (opts.headless) return
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

  const rate = ((failures / total) * 100).toFixed(1)
  console.error(`\nfreshness FP harness: ${total - failures}/${total} mutations detected, false-positive rate ${rate}%`)

  // Known blind spot, reported for the record rather than folded into the total
  // above. A same-length rewrite that also restores the file's original atime and
  // mtime exactly is the one case a metadata-only probe cannot see by
  // construction: name, size and mtime are all identical to before. It is run and
  // reported here so the limitation is documented in the instrument itself, but it
  // must never move the pass/fail total or the exit code.
  {
    const dir = join(root, 'blind-spot-same-size-same-mtime')
    seed(dir, false)
    const p = join(dir, 'a.txt')
    const original = statSync(p)
    const before = stateStamp(dir)
    writeFileSync(p, 'ONE')
    // utimesSync accepts Date objects or numeric seconds-since-epoch. A Date only
    // carries whole-millisecond precision, but this filesystem stores mtimes with
    // a sub-millisecond fraction (confirmed: statSync().mtimeMs has a non-zero
    // fractional part), so restoring via Date would silently fail to reproduce the
    // original mtime and this case would falsely appear detected. Passing the
    // fraction through as seconds restores the exact original mtimeMs.
    utimesSync(p, original.mtimeMs / 1000, original.mtimeMs / 1000)
    const after = stateStamp(dir)
    const detected = before.value !== after.value && after.kind !== 'none'
    console.error(
      `known blind spot [mtime] same size, same mtime, different content: ${detected ? 'DETECTED (unexpected)' : 'NOT DETECTED (expected)'}`,
    )
  }

  // Zero-commit git repo (initialized and staged, never committed). gitStamp must
  // still produce a usable, moving stamp here, which is what the explicit
  // head.exitCode check exists to guarantee. Exercised as its own check rather
  // than folded into the catalogue above, since it verifies a fix to gitStamp's
  // HEAD handling rather than adding new mutation coverage to the primary count.
  let headlessFailures = 0
  let headlessTotal = 0
  for (const m of MUTATIONS) {
    const dir = join(root, `headless-${m.name.replace(/\W+/g, '-')}`)
    seed(dir, true, { headless: true })
    const before = stateStamp(dir)
    m.apply(dir)
    const after = stateStamp(dir)
    headlessTotal += 1
    const moved = before.value !== after.value && after.kind !== 'none'
    if (!moved) {
      headlessFailures += 1
      console.error(`FALSE POSITIVE  [headless git] ${m.name}: stamp did not move (kind=${after.kind})`)
    }
  }
  console.error(
    `headless-repo check: ${headlessTotal - headlessFailures}/${headlessTotal} mutations detected in a zero-commit repo`,
  )

  rmSync(root, { recursive: true, force: true })
  return failures === 0 && headlessFailures === 0 ? 0 : 1
}

/**
 * `mtimeStamp`'s bounds, duplicated here for reporting only. They are private
 * constants in src/freshness.ts, and this task is barred from touching that file,
 * so this walker cannot import them; it mirrors the SKIP set and the MAX_DEPTH /
 * MAX_ENTRIES cutoffs by hand instead. This function never feeds a stamp: it exists
 * solely to answer, for the parked residual in Task 5, whether a real tree's walk
 * would be truncated by either bound, and if so how large the tree actually is.
 */
const BOUNDS_SKIP = new Set(['node_modules', 'dist', 'build', 'target', 'coverage', 'vendor', '__pycache__'])
const BOUNDS_MAX_DEPTH = 6
const BOUNDS_MAX_ENTRIES = 5000

interface BoundsReport {
  /** Files counted before either bound stopped the walk (mirrors mtimeStamp's `seen`). */
  entriesWalked: number
  /** True only if content existed past MAX_DEPTH that the walk never reached. */
  hitMaxDepth: boolean
  /** True only if the walk stopped early because MAX_ENTRIES was reached. */
  hitMaxEntries: boolean
}

function probeMtimeBounds(root: string): BoundsReport {
  let entriesWalked = 0
  let hitMaxDepth = false
  let hitMaxEntries = false

  const walk = (dir: string, depth: number): void => {
    if (hitMaxEntries) return
    if (depth > BOUNDS_MAX_DEPTH) {
      try {
        const rest = readdirSync(dir, { withFileTypes: true })
          .filter((e) => !e.name.startsWith('.') && !BOUNDS_SKIP.has(e.name))
        if (rest.length > 0) hitMaxDepth = true
      } catch {
        // Unreadable past the depth bound tells us nothing usable for this report.
      }
      return
    }
    if (entriesWalked >= BOUNDS_MAX_ENTRIES) { hitMaxEntries = true; return }
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.') || BOUNDS_SKIP.has(entry.name)) continue
      if (entriesWalked >= BOUNDS_MAX_ENTRIES) { hitMaxEntries = true; return }
      const full = join(dir, entry.name)
      if (entry.isDirectory()) { walk(full, depth + 1); continue }
      if (!entry.isFile()) continue
      entriesWalked += 1
    }
  }

  try {
    walk(root, 0)
  } catch {
    // Best-effort report; an unreadable root just yields whatever was counted so far.
  }

  return { entriesWalked, hitMaxDepth, hitMaxEntries }
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
  let boundsHit = 0
  console.error('fp:real: probing real repositories\n')

  for (const root of roots) {
    const t0 = performance.now()
    const a = stateStamp(root)
    const elapsed = performance.now() - t0
    const b = stateStamp(root)

    const stable = a.value === b.value && a.kind !== 'none'
    if (!stable) unstable += 1
    if (elapsed > 200) slow += 1

    const bounds = probeMtimeBounds(root)
    const boundFlags = [
      bounds.hitMaxDepth ? 'MAX_DEPTH HIT' : null,
      bounds.hitMaxEntries ? 'MAX_ENTRIES HIT' : null,
    ].filter((f): f is string => f !== null)
    if (boundFlags.length > 0) boundsHit += 1
    const boundsNote = boundFlags.length > 0 ? `  [${boundFlags.join(', ')}]` : ''

    console.error(
      `  ${stable ? 'stable  ' : 'UNSTABLE'}  ${a.kind.padEnd(5)}  ${elapsed.toFixed(0).padStart(4)}ms  ` +
      `entries=${bounds.entriesWalked}${boundsNote}  ${root}`,
    )
  }

  console.error(
    `\nfp:real: ${roots.length - unstable}/${roots.length} stable, ${slow} over the 200ms budget, ` +
    `${boundsHit} hit MAX_DEPTH or MAX_ENTRIES`,
  )
  return unstable === 0 && slow === 0 ? 0 : 1
}

process.exit(process.argv.includes('--real') ? runReal() : runSynthetic())
