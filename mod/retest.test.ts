import { expect, test } from 'claude-code/testing'
import { CWD, PANE, failing, memoryHost, paneLines, rowKeys, sized, viewport, type MemoryHost, type On } from './memory-host.kit.ts'

// Retest through the real engine: the pane's Run raises a real `$.tool.call`, which passes
// the mod's own tracked hook and is answered by the test's hook beneath; `tool.check` is
// answered by the test's hook as well.

const FAIL = { isError: true, result: 'Exit code 1', text: 'Exit code 1\nboom' }
const CONSENT = 'The user pressed "Run" on Cassandra\'s retest of this call.'

/** A loosely typed `on`, for the events the kit's types do not narrow here. */
const loose = (on: On) => on as unknown as (event: string, a: unknown, b?: unknown) => void

/** Answer `tool.check` with `decision` (changeable later), counting the questions. */
function verdict(on: On, decision: 'allow' | 'ask' | 'deny'): { asked: number; decision: 'allow' | 'ask' | 'deny' } {
  const seen = { asked: 0, decision }
  loose(on)('tool.check', async () => {
    seen.asked += 1
    return { decision: seen.decision }
  })
  return seen
}

/** Open the marked row, unless it is open already (the state outlives a mount). */
async function openRow(ui: { drawn(): Promise<unknown>; press(t: { key: string }): Promise<unknown> }, key: string): Promise<void> {
  if (!(await paneLines(ui)).join('\n').includes('why it failed')) await ui.press({ key })
}

/** Collect every toast the plugin raises. */
function toasts(on: On): string[] {
  const said: string[] = []
  loose(on)('ui.toast', async (_$: unknown, e: { text: string }) => {
    said.push(e.text)
    return { value: undefined }
  })
  return said
}

/** The one stored record, parsed, and the path it is stored at. */
function stored(host: MemoryHost): { path: string; record: Record<string, unknown> } {
  const [path, text] = [...host.files].find(([p]) => /\/records\/[^/]+\/[0-9a-f]+\.json$/.test(p))!
  return { path, record: JSON.parse(text) as Record<string, unknown> }
}

/** Rewrite the one stored record. */
function restore(host: MemoryHost, change: (r: Record<string, unknown>) => Record<string, unknown>): void {
  const { path, record } = stored(host)
  host.files.set(path, JSON.stringify(change(record)))
}

/** The kinds the stats log holds, in order. */
function statKinds(host: MemoryHost): string[] {
  const [, text] = [...host.files].find(([p]) => p.endsWith('/stats.jsonl')) ?? ['', '']
  return text.split('\n').filter(Boolean).map((l) => (JSON.parse(l) as { kind: string }).kind)
}

/** The keys of every Button drawn, hidden twins included. */
async function buttonKeys(ui: { findAll(q: { type: string }): Promise<Array<{ key: string | undefined }>> }): Promise<string[]> {
  return (await ui.findAll({ type: 'Button' })).map((b) => String(b.key))
}

test('a denied call offers no retest, and a record without its input says so', async ($, on) => {
  const host = memoryHost(on)
  failing(on)
  await $.tool.call({ tool: 'Bash', command: 'echo denied' })
  let ui = await $.ui.mount({ ...PANE, surface: 'terminal', viewport })
  const [denied] = await rowKeys(ui)
  await openRow(ui, denied!)
  expect((await paneLines(ui)).find((l) => l.includes('retest'))).toContain('not offered for a denied call')
  expect((await buttonKeys(ui)).filter((k) => k.includes('retest'))).toEqual([])
  await ui.unmount()

  // An old record kept no input: the row says why, and nothing offers to run it.
  restore(host, ({ input: _input, ...r }) => ({ ...r, kind: 'failure' }))
  ui = await $.ui.mount({ ...PANE, surface: 'terminal', viewport })
  await openRow(ui, (await rowKeys(ui))[0]!)
  expect((await paneLines(ui)).find((l) => l.includes('retest'))).toContain("not possible: the call's input was not kept")
  expect((await buttonKeys(ui)).filter((k) => k.includes('retest'))).toEqual([])
  await ui.unmount()
})

test('a call that looked like it held a secret says why it cannot be retested, and offers no r', async ($, on) => {
  const host = memoryHost(on)
  failing(on)
  await $.tool.call({ tool: 'Bash', command: 'curl -H "Authorization: Bearer abc123def" https://api.example.com' })
  expect(stored(host).record.inputSecret).toBe(true)
  const ui = await $.ui.mount({ ...PANE, props: sized(140, 40), surface: 'terminal', viewport })
  await openRow(ui, (await rowKeys(ui))[0]!)
  expect((await paneLines(ui)).find((l) => l.trimStart().startsWith('retest'))).toContain('the call looked like it held a secret, so its input was not kept')
  expect((await buttonKeys(ui)).filter((k) => k.includes('retest'))).toEqual([])
  await ui.unmount()
})

test('the confirm shows the whole command and its directory, wrapped, never cut', async ($, on) => {
  memoryHost(on)
  failing(on)
  const command = `bun test ${'packages/some-long-name/'.repeat(8)}spec.ts # the whole call`
  await $.tool.call({ tool: 'Bash', command })
  const ui = await $.ui.mount({ ...PANE, props: sized(60, 30), surface: 'terminal', viewport })
  await ui.press({ key: 'retest' })
  const lines = await paneLines(ui)
  const title = lines.findIndex((l) => l.includes('Retest'))
  expect(title).toBeGreaterThan(0)
  const at = lines.findIndex((l) => l.trimStart().startsWith('run '))
  const where = lines.findIndex((l) => l.trimStart().startsWith('in '))
  expect(at).toBeGreaterThan(title)
  expect(where).toBeGreaterThan(at + 1)
  // Every piece after its label, joined again, is the command exactly.
  const text = (l: string) => l.slice(2 + 8).trimEnd()
  expect(lines.slice(at, where).map(text).join('')).toBe(command)
  expect(text(lines[where]!)).toBe(CWD)
  for (const l of lines) expect([...l].length).toBe(60)
  expect(lines.slice(title, where + 1).join('')).not.toContain('…')
  expect((await ui.find({ key: 'retest-confirm' }))?.text).toBe('Run')
  expect(await ui.find({ key: 'retest-cancel' })).toBeDefined()
  await ui.press({ key: 'retest-cancel' })
  expect((await paneLines(ui)).some((l) => l.trimStart().startsWith('run '))).toBe(false)
  await ui.unmount()
})

test('the confirm of an MCP call shows the tool and its whole input, pretty-printed', async ($, on) => {
  memoryHost(on)
  loose(on)('tool.call', { tool: 'mcp__srv__deploy' }, async () => FAIL)
  await $.tool.call({ tool: 'mcp__srv__deploy', target: 'staging', options: { dry: true } })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', viewport })
  await ui.press({ key: 'retest' })
  const lines = (await paneLines(ui)).map((l) => l.trimEnd())
  expect(lines.some((l) => l.endsWith('tool    mcp__srv__deploy'))).toBe(true)
  const input = lines.findIndex((l) => l.trimStart().startsWith('input'))
  expect(lines.slice(input, input + 6).map((l) => l.slice(2 + 8)).join('\n')).toBe(JSON.stringify({ target: 'staging', options: { dry: true } }, null, 2))
  await ui.unmount()
})

test('a pane too short for the whole call says so and offers no Run', async ($, on) => {
  memoryHost(on)
  failing(on)
  await $.tool.call({ tool: 'Bash', command: `false ${'x'.repeat(400)}` })
  const ui = await $.ui.mount({ ...PANE, props: sized(60, 8), surface: 'terminal', viewport })
  await ui.press({ key: 'retest' })
  const lines = await paneLines(ui)
  expect(lines.join('\n')).toContain('Pane too small for the whole call; enlarge it.')
  expect(lines.length).toBeLessThanOrEqual(8)
  expect(await ui.find({ key: 'retest-confirm' })).toBeUndefined()
  expect(await ui.find({ key: 'retest-cancel' })).toBeDefined()
  await ui.unmount()
})

test('a deny verdict runs nothing and says so', async ($, on) => {
  memoryHost(on)
  let ran = 0
  on('tool.call', { tool: 'Bash' }, async () => {
    ran += 1
    return FAIL
  })
  const check = verdict(on, 'allow')
  await $.tool.call({ tool: 'Bash', command: 'bun test # denied by settings' })
  expect(ran).toBe(1)
  check.decision = 'deny'
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', viewport })
  await ui.press({ key: 'retest' })
  const asked = check.asked
  await ui.press({ key: 'retest-confirm' })
  expect(check.asked).toBe(asked + 1)
  expect(ran).toBe(1)
  expect((await paneLines(ui)).join('\n')).toContain('Your permission settings deny this call; nothing ran.')
  expect(await rowKeys(ui)).toHaveLength(1)
  await ui.unmount()
})

test('a record from another directory runs nothing and names both', async ($, on) => {
  const host = memoryHost(on)
  let ran = 0
  on('tool.call', { tool: 'Bash' }, async () => {
    ran += 1
    return FAIL
  })
  const check = verdict(on, 'allow')
  await $.tool.call({ tool: 'Bash', command: 'bun test # elsewhere' })
  restore(host, (r) => ({ ...r, cwd: '/mem/other' }))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', viewport })
  await ui.press({ key: 'retest' })
  // The confirm shows where the call ran.
  expect((await paneLines(ui)).some((l) => l.trim() === 'in      /mem/other')).toBe(true)
  const asked = check.asked
  await ui.press({ key: 'retest-confirm' })
  expect(ran).toBe(1)
  expect(check.asked).toBe(asked)
  expect((await paneLines(ui)).join('\n')).toContain(`Retest runs from /mem/other; this session is in ${CWD}.`)
  await ui.unmount()
})

test('a passing retest forgets the record, logs retest_cleared and no false positive, and toasts', async ($, on) => {
  const host = memoryHost(on)
  let pass = false
  const seen: Array<Record<string, unknown>> = []
  on('tool.call', { tool: 'Bash' }, async (_$, e) => {
    seen.push(e as unknown as Record<string, unknown>)
    return pass ? { result: 'ok', text: 'ok' } : FAIL
  })
  verdict(on, 'allow')
  const said = toasts(on)
  await $.tool.call({ tool: 'Bash', command: 'bun test # passes now' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', viewport })
  await ui.press({ key: 'retest' })
  pass = true
  await ui.press({ key: 'retest-confirm' })
  expect(seen).toHaveLength(2)
  expect(seen[1]).toMatchObject({ tool: 'Bash', command: 'bun test # passes now' })
  expect(said).toEqual(['Retest passed; forgotten.'])
  expect(await rowKeys(ui)).toEqual([])
  const kinds = statKinds(host)
  expect(kinds).toContain('retest_cleared')
  expect(kinds).not.toContain('false_positive')
  expect(kinds).not.toContain('warned')
  // The counter of today's clears shows it.
  expect((await paneLines(ui)).join('\n')).toMatch(/1 cleared/)
  await ui.unmount()
})

test('a failing retest bumps the count, logs retest_failed, keeps the record, and adds no warning', async ($, on) => {
  const host = memoryHost(on)
  let ran = 0
  on('tool.call', { tool: 'Bash' }, async () => {
    ran += 1
    return FAIL
  })
  verdict(on, 'allow')
  const said = toasts(on)
  await $.tool.call({ tool: 'Bash', command: 'bun test # still broken' })
  expect(stored(host).record.count).toBe(1)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', viewport })
  await ui.press({ key: 'retest' })
  await ui.press({ key: 'retest-confirm' })
  expect(ran).toBe(2)
  expect(stored(host).record.count).toBe(2)
  expect(said).toEqual(['Retest failed again; record updated.'])
  const kinds = statKinds(host)
  expect(kinds).toContain('retest_failed')
  expect(kinds).not.toContain('warned')
  expect(kinds).not.toContain('confirmed')
  const lines = await paneLines(ui)
  expect(lines.join('\n')).not.toContain('Just warned')
  expect(await rowKeys(ui)).toHaveLength(1)
  await ui.unmount()
})

test('a failing retest whose outcome could not be recorded logs no retest_failed and says so', async ($, on) => {
  const host = memoryHost(on)
  on('tool.call', { tool: 'Bash' }, async () => FAIL)
  verdict(on, 'allow')
  const said = toasts(on)
  await $.tool.call({ tool: 'Bash', command: 'bun test # still broken' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', viewport })
  await ui.press({ key: 'retest' })
  // The directory is gone by the time it runs: no state stamp, so settle records nothing.
  host.files.delete(`${CWD}/a.txt`)
  await ui.press({ key: 'retest-confirm' })
  expect(stored(host).record.count).toBe(1)
  expect(statKinds(host)).not.toContain('retest_failed')
  expect(said).toEqual([])
  expect((await paneLines(ui)).join('\n')).toContain('The retest ran, but Cassandra could not record its outcome.')
  await ui.unmount()
})

test('the retest carries the consent of the press and raises no Just warned card', async ($, on) => {
  memoryHost(on)
  const seen: Array<Record<string, unknown>> = []
  on('tool.call', { tool: 'Bash' }, async (_$, e) => {
    seen.push(e as unknown as Record<string, unknown>)
    return FAIL
  })
  verdict(on, 'allow')
  await $.tool.call({ tool: 'Bash', command: 'bun test # consent' })
  // The model's own repeat of the call is warned about.
  const warned = await $.tool.call({ tool: 'Bash', command: 'bun test # consent' })
  expect(JSON.stringify(warned.context ?? [])).toContain('cassandra')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', viewport })
  await ui.press({ key: 'dismiss' })
  await ui.press({ key: 'retest' })
  await ui.press({ key: 'retest-confirm' })
  expect(seen).toHaveLength(3)
  expect(seen[2]!.consent).toBe(CONSENT)
  expect((await paneLines(ui)).join('\n')).not.toContain('Just warned')
  await ui.unmount()
})

test('o shows the full output in the open row, wrapped and windowed; a record without it says so', async ($, on) => {
  const host = memoryHost(on)
  const output = Array.from({ length: 40 }, (_, i) => `line ${i + 1} ${'y'.repeat(i % 3 === 0 ? 90 : 10)}`).join('\n')
  on('tool.call', { tool: 'Bash' }, async () => ({ isError: true, result: 'Exit code 1', text: `Exit code 1\n${output}` }))
  await $.tool.call({ tool: 'Bash', command: 'bun test # long output' })
  let ui = await $.ui.mount({ ...PANE, surface: 'terminal', viewport })
  await ui.press({ key: 'full' })
  let lines = await paneLines(ui)
  expect(lines.length).toBeLessThanOrEqual(30)
  for (const l of lines) expect([...l].length).toBe(80)
  const title = lines.findIndex((l) => l.trim() === 'full output')
  expect(title).toBeGreaterThan(0)
  expect(lines[title + 1]).toContain('Exit code 1')
  expect(lines[title + 2]).toContain('line 1 ')
  expect(lines.join('\n')).toMatch(/lines 1–\d+ of \d+/)
  expect(lines.slice(title).join('\n')).not.toContain('…')
  await ui.press({ key: 'full' })
  expect((await paneLines(ui)).join('\n')).not.toContain('full output')
  await ui.unmount()

  restore(host, ({ errorFull: _full, ...r }) => r)
  ui = await $.ui.mount({ ...PANE, surface: 'terminal', viewport })
  await ui.press({ key: 'full' })
  lines = await paneLines(ui)
  expect(lines.join('\n')).toContain('The full output was not kept for this record.')
  await ui.unmount()
})

test('j walks past the window edge on a short pane, and f forgets the row it marked', async ($, on) => {
  memoryHost(on)
  failing(on)
  for (let i = 0; i < 8; i++) await $.tool.call({ tool: 'Bash', command: `false # walk ${i}` })
  const tall = await $.ui.mount({ ...PANE, surface: 'terminal', viewport })
  const order = await rowKeys(tall)
  expect(order).toHaveLength(8)
  await tall.unmount()

  const ui = await $.ui.mount({ ...PANE, props: sized(70, 8), surface: 'terminal', viewport })
  const window = await rowKeys(ui)
  expect(window.length).toBeLessThan(8)
  for (let i = 0; i < window.length + 1; i++) await ui.press({ key: 'down' })
  const marked = order[window.length + 1]!
  expect(await rowKeys(ui)).toContain(marked)
  await ui.press({ key: 'forget' })
  await ui.unmount()
  const after = await $.ui.mount({ ...PANE, surface: 'terminal', viewport })
  expect(await rowKeys(after)).toEqual(order.filter((k) => k !== marked))
  await after.unmount()
})

test('a search applied on a pane too short for its row still shows and clears with x', async ($, on) => {
  memoryHost(on)
  failing(on)
  for (const c of ['bun test # a', 'bun run lint # b', 'npm test # c']) await $.tool.call({ tool: 'Bash', command: c })
  const tall = await $.ui.mount({ ...PANE, surface: 'terminal', viewport })
  await tall.press({ key: 'search' })
  await tall.input({ key: 'search-field', text: 'bun' })
  expect(await rowKeys(tall)).toHaveLength(2)
  await tall.unmount()

  const ui = await $.ui.mount({ ...PANE, props: sized(70, 5), surface: 'terminal', viewport })
  expect(await ui.find({ key: 'search' })).toBeUndefined()
  expect((await paneLines(ui)).join('\n')).toContain('matching bun')
  const clear = (await ui.find({ key: 'search-clear' })) ?? (await ui.find({ key: 'twin:search-clear' }))
  expect(clear?.props.hotkey).toBe('x')
  await ui.press({ key: String(clear!.key) })
  expect((await paneLines(ui)).join('\n')).not.toContain('matching')
  await ui.unmount()
})

test('a record rewritten under the same fingerprint after the confirm was drawn runs nothing', async ($, on) => {
  const host = memoryHost(on)
  let ran = 0
  on('tool.call', { tool: 'Bash' }, async () => {
    ran += 1
    return FAIL
  })
  verdict(on, 'allow')
  await $.tool.call({ tool: 'Bash', command: 'bun test # swapped' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', viewport })
  await ui.press({ key: 'retest' })
  expect((await paneLines(ui)).some((l) => l.includes('run     bun test # swapped'))).toBe(true)
  // A later failure of the same command with another argument rewrites the record behind the confirm.
  restore(host, (r) => ({ ...r, input: { ...(r.input as object), dangerouslyDisableSandbox: true } }))
  await ui.press({ key: 'retest-confirm' })
  expect(ran).toBe(1)
  expect((await paneLines(ui)).join('\n')).toContain('The call changed since you confirmed it; nothing ran.')
  await ui.unmount()
})
