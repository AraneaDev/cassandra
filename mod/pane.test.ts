import { expect, mock, test } from 'claude-code/testing'

// The kit's `$` has no fs or process, but the test's own hooks sit beneath the plugin and
// answer its `$.fs.*` and `$.process.run` calls (the pane spike's seam E). Here they keep
// a small filesystem in memory, so the real mod records a real failure and the real pane
// draws it from the store.

const SURFACES = ['terminal', 'desktop'] as const
const PROPS = {
  title: 'Cassandra',
  isFocused: true,
  bodyColumns: 80,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
} as const
const PANE = { plugin: 'cassandra', component: 'Pane', requestId: 'cassandra', props: PROPS } as const
const viewport = { columns: 160, rows: 40, isFullscreen: true }
const CWD = '/mem/proj'

type On = Parameters<Parameters<typeof test>[1]>[1]

/** The host calls answered here, as far as this test reads them. */
interface HostCall { path: string; text: string; argv: readonly string[]; init?: { stdin?: string } }

/** How many times the plugin asked to open a pane. */
let opened = 0

/**
 * Answer the plugin's host calls from an in-memory filesystem. With `git`, the project is a
 * checkout on branch `main` at a clean HEAD; without it, git answers nothing.
 */
function memoryHost(on: On, { git = false }: { git?: boolean } = {}): void {
  const files = new Map<string, string>([[`${CWD}/a.txt`, 'one']])
  if (git) files.set(`${CWD}/.git/HEAD`, 'ref: refs/heads/main')
  const isDir = (p: string): boolean => [...files.keys()].some((f) => f.startsWith(`${p}/`))
  const missing = (p: string): Error => new Error(`no such file: ${p}`)
  const h = on as unknown as (event: string, hook: (_$: unknown, e: HostCall) => Promise<unknown>) => void

  mock.env(on, { CASSANDRA_HOME: '/mem/home', HOME: '/mem' })
  h('session.cwd', async () => ({ value: CWD }))
  h('session.id', async () => ({ value: 's1' }))
  h('fs.read', async (_$, e) => {
    if (!files.has(e.path)) throw missing(e.path)
    return { value: files.get(e.path) }
  })
  h('fs.write', async (_$, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  h('fs.exists', async (_$, e) => ({ value: files.has(e.path) || isDir(e.path) }))
  h('fs.stat', async (_$, e) => {
    if (files.has(e.path)) return { value: { kind: 'file', size: files.get(e.path)!.length, mtimeMs: 0 } }
    if (isDir(e.path)) return { value: { kind: 'dir', size: 0, mtimeMs: 0 } }
    throw missing(e.path)
  })
  h('fs.list', async (_$, e) => {
    if (!isDir(e.path)) throw missing(e.path)
    const seen = new Map<string, { name: string; kind: 'file' | 'dir'; size: number; mtimeMs: number }>()
    for (const [f, text] of files) {
      if (!f.startsWith(`${e.path}/`)) continue
      const [name, ...rest] = f.slice(e.path.length + 1).split('/')
      seen.set(name!, rest.length ? { name: name!, kind: 'dir', size: 0, mtimeMs: 0 } : { name: name!, kind: 'file', size: text.length, mtimeMs: 1 })
    }
    return { value: [...seen.values()] }
  })
  h('process.run', async (_$, e) => {
    const argv = e.argv
    const done = (exitCode: number) => ({ value: { exitCode, stdout: '' } })
    if (argv[0] === 'mv') {
      const [from, to] = argv.slice(-2) as [string, string]
      if (!files.has(from)) return done(1)
      files.set(to, files.get(from)!)
      files.delete(from)
      return done(0)
    }
    if (argv[0] === 'rm') {
      files.delete(argv.at(-1)!)
      return done(0)
    }
    if (argv[0] === 'sh') {
      const path = argv.at(-1)!
      files.set(path, (files.get(path) ?? '') + String(e.init?.stdin ?? ''))
      return done(0)
    }
    if (git && argv[0] === 'git') {
      const said = (stdout: string) => ({ value: { exitCode: 0, stdout } })
      if (argv.includes('rev-parse')) return said('0cc107b2a9f1e0d3c4b5a6978877665544332211\n')
      if (argv.includes('status')) return said('')
      if (argv.includes('symbolic-ref')) return said('main\n')
    }
    // No git here: the freshness stamp falls back to the tree's mtimes.
    return done(128)
  })
  h('ui.open', async () => {
    opened += 1
    return { value: { isPlaced: true } }
  })
  h('ui.panes', async () => ({ value: [] }))
  h('session.surfaces', async () => ({ value: ['terminal'] }))
}

test('the pane refuses a plugin origin, draws the remembered failure, forgets it, and asks before forgetting everything', async ($, on) => {
  memoryHost(on)
  on('tool.call', { tool: 'Bash' }, async () => ({ isError: true, result: 'Exit code 1', text: 'Exit code 1\nboom' }))
  await $.tool.call({ tool: 'Bash', command: 'false # cassandra pane' })

  // A run from here carries a plugin origin, which may not open the pane; the person's
  // own origins are covered by test/mod.spec.ts. The test mounts the pane itself instead.
  opened = 0
  const r = await $.command.run({ command: 'cassandra', args: 'pane' })
  expect([r.text, r.exitCode]).toEqual(['The pane opens only from your own /cassandra command.', 1])
  expect(opened).toBe(0)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface, viewport })
    const keys = (await ui.findAll({ type: 'Button' })).map((b) => b.key)
    expect(keys.filter((k) => /^row:[0-9a-f]{8}$/.test(String(k)))).toHaveLength(1)
    expect(keys).toContain('forget')
    expect(keys).toContain('forget-all')

    await ui.press({ key: 'forget-all' })
    expect((await ui.find({ key: 'forget-all-confirm' }))?.text).toBe('Forget all 1 record')
    await ui.press({ key: 'forget-all-cancel' })
    expect((await ui.find({ key: 'forget-all' }))?.key).toBe('forget-all')
    await ui.unmount()
  }

  // Forget acts on the selected record, and the pane redraws without it.
  const one = await $.ui.mount({ ...PANE, surface: 'terminal', viewport })
  await one.press({ key: 'forget' })
  expect(await actionKeys(one)).toEqual([])
  await one.unmount()

  // The confirm is the person's own gesture: it forgets everything, and the pane redraws empty.
  await $.tool.call({ tool: 'Bash', command: 'false # cassandra pane, once more' })
  await $.tool.call({ tool: 'Bash', command: 'false # cassandra pane, and again' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', viewport })
  expect((await ui.findAll({ type: 'Button' })).filter((b) => String(b.key).startsWith('row:'))).toHaveLength(2)
  await ui.press({ key: 'forget-all' })
  expect((await ui.find({ key: 'forget-all-confirm' }))?.text).toBe('Forget all 2 records')
  await ui.press({ key: 'forget-all-confirm' })
  expect(await actionKeys(ui)).toEqual([])
  expect((await ui.find({ type: 'Text', text: /Nothing remembered/ }))?.text.trim()).toBe('Nothing remembered in this project.')
  await ui.unmount()
})

/** The Buttons that act on records: the rows, Forget and Forget all, and the confirm. */
async function actionKeys(ui: { findAll(q: { type: string }): Promise<Array<{ key: string | undefined }>> }): Promise<string[]> {
  return (await ui.findAll({ type: 'Button' })).map((b) => String(b.key)).filter((k) => k.startsWith('row:') || k.startsWith('forget'))
}

/** A drawn element, as the kit hands the tree back. */
interface Drawn { type: string; props?: Record<string, unknown>; children?: unknown[] }

/**
 * What one line draws: a Button's one string child comes back as its `label`, and a plain
 * Button with a hotkey draws `k: ` before it. A Box with `display="none"` draws nothing.
 */
function drawnText(n: unknown): string {
  if (typeof n === 'string') return n
  const e = n as Drawn
  if (e.type === 'Box' && e.props?.display === 'none') return ''
  const own = (e.children ?? []).map(drawnText).join('') || (e.type === 'Button' ? String(e.props?.label ?? '') : '')
  return e.type === 'Button' && e.props?.hotkey ? `${String(e.props.hotkey)}: ${own}` : own
}

/** The pane's lines: the children of its own root, each one row. */
async function paneLines(ui: { drawn(): Promise<unknown> }): Promise<string[]> {
  const find = (n: unknown): Drawn | undefined => {
    if (!n || typeof n !== 'object') return undefined
    const e = n as Drawn
    if (e.props?.key === 'cassandra-pane') return e
    for (const c of e.children ?? []) {
      const hit = find(c)
      if (hit) return hit
    }
    return undefined
  }
  const root = find(await ui.drawn())
  expect(root).toBeDefined()
  return (root!.children ?? []).map(drawnText)
}

/** A pane's props at a size. */
const sized = (columns: number, rows: number) => ({ ...PROPS, bodyColumns: columns, scroll: { offset: 0, bodyRows: rows } })

test('at every size each drawn line is exactly the pane wide and the pane fits its rows, on both surfaces', async ($, on) => {
  memoryHost(on, { git: true })
  on('tool.call', { tool: 'Bash' }, async () => ({ isError: true, result: 'Exit code 1', text: 'Exit code 1\nboom' }))
  for (let i = 0; i < 12; i++) await $.tool.call({ tool: 'Bash', command: `false # case ${i} ${'x'.repeat(i * 9)}` })

  for (const surface of SURFACES) {
    for (const [columns, rows] of [[40, 15], [70, 30], [120, 50]] as const) {
      const ui = await $.ui.mount({ ...PANE, props: sized(columns, rows), surface, viewport })
      const lines = await paneLines(ui)
      expect(lines.length).toBeGreaterThan(4)
      expect(lines.length).toBeLessThanOrEqual(rows)
      // Every glyph drawn here takes one cell, so its length is its width.
      for (const l of lines) expect([...l].length).toBe(columns)
      expect(lines[0]).toContain('proj')
      if (columns === 40) {
        expect(lines[0]).not.toContain('main')
        expect(lines[1]).toContain(' History¹² ')
        expect(lines[1]).toContain(' 2')
        expect(lines[1]).not.toContain('Warnings')
      } else {
        expect(lines[0]).toContain('main')
        expect(lines[1]).toMatch(/History¹² +Warnings¹² +Stale⁰ +Denied⁰/)
      }
      if (columns === 120) expect(lines[0]).toContain('main · 0cc107b')
      expect(lines[0]).toContain('12 would warn')
      expect(lines.at(-1)).toContain('f: Forget  a: Forget all')
      await ui.unmount()
    }
  }
})

test('a pane three rows tall draws the one line asking for more room, on both surfaces', async ($, on) => {
  memoryHost(on)
  on('tool.call', { tool: 'Bash' }, async () => ({ isError: true, result: 'Exit code 1', text: 'Exit code 1\nboom' }))
  await $.tool.call({ tool: 'Bash', command: 'false # short pane' })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, props: sized(70, 3), surface, viewport })
    expect((await ui.findAll({ type: 'Text' })).map((t) => t.text)).toEqual(['Pane too short; make the window taller.'])
    expect(await ui.findAll({ type: 'Button' })).toEqual([])
    await ui.unmount()
  }
})

/** The keys of the rows a drawing lists, in order. */
async function rowKeys(ui: { findAll(q: { type: string }): Promise<Array<{ key: string | undefined }>> }): Promise<string[]> {
  return (await ui.findAll({ type: 'Button' })).map((b) => String(b.key)).filter((k) => k.startsWith('row:'))
}

/** A beneath that fails every call, and denies one whose command says `denied`. */
function failing(on: On): void {
  const h = on as unknown as (event: string, matcher: { tool: string }, hook: (_$: unknown, e: { command?: string }) => Promise<unknown>) => void
  h('tool.call', { tool: 'Bash' }, async (_$, e) => (String(e.command).includes('denied') ? { deny: 'blocked by policy' } : { isError: true, result: 'Exit code 1', text: 'Exit code 1\nboom' }))
}

test('a warned call draws the Just warned card with the call; Dismiss and forgetting its record remove it', async ($, on) => {
  memoryHost(on)
  failing(on)
  await $.tool.call({ tool: 'Bash', command: 'false # warn me' })
  let ui = await $.ui.mount({ ...PANE, surface: 'terminal', viewport })
  expect((await paneLines(ui)).join('\n')).not.toContain('Just warned')
  await ui.unmount()

  // The same call again: Cassandra warns, and the pane shows what was run.
  await $.tool.call({ tool: 'Bash', command: 'false # warn me' })
  ui = await $.ui.mount({ ...PANE, surface: 'terminal', viewport })
  let lines = await paneLines(ui)
  expect(lines.some((l) => l.includes('Just warned'))).toBe(true)
  expect(lines.find((l) => l.includes('you ran'))).toContain('false # warn me')
  await ui.press({ key: 'dismiss' })
  expect((await paneLines(ui)).join('\n')).not.toContain('Just warned')
  await ui.unmount()

  // Warned again, then the record is forgotten: the card goes with it (Review Focus 5).
  await $.tool.call({ tool: 'Bash', command: 'false # warn me' })
  ui = await $.ui.mount({ ...PANE, surface: 'terminal', viewport })
  expect((await paneLines(ui)).join('\n')).toContain('Just warned')
  await ui.press({ key: 'forget' })
  lines = await paneLines(ui)
  expect(lines.join('\n')).not.toContain('Just warned')
  expect(await rowKeys(ui)).toEqual([])
  await ui.unmount()
})

test('the tab digits ride on hidden twins: 2 lists only the rows that would warn, 4 only the denials', async ($, on) => {
  memoryHost(on)
  failing(on)
  await $.tool.call({ tool: 'Bash', command: 'false # one' })
  await $.tool.call({ tool: 'Bash', command: 'echo denied' })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface, viewport })
    expect(await rowKeys(ui)).toHaveLength(2)
    expect((await ui.find({ key: 'tabkey:warnings' }))?.props.hotkey).toBe('2')
    await ui.press({ key: 'tabkey:warnings' })
    expect(await rowKeys(ui)).toHaveLength(1)
    let lines = await paneLines(ui)
    expect(lines.some((l) => l.includes('false # one'))).toBe(true)
    expect(lines.some((l) => l.includes('echo denied'))).toBe(false)
    await ui.press({ key: 'tabkey:denied' })
    lines = await paneLines(ui)
    expect(await rowKeys(ui)).toHaveLength(1)
    expect(lines.some((l) => l.includes('echo denied'))).toBe(true)
    // A press on the tab itself switches too.
    await ui.press({ key: 'tab:history' })
    expect(await rowKeys(ui)).toHaveLength(2)
    // Every line is still the pane's width: the twins draw nothing.
    for (const l of await paneLines(ui)) expect([...l].length).toBe(80)
    await ui.unmount()
  }
})

test('j moves the marker down and Enter on the marked row opens it in place; k moves it back', async ($, on) => {
  memoryHost(on)
  failing(on)
  await $.tool.call({ tool: 'Bash', command: 'false # older' })
  await $.tool.call({ tool: 'Bash', command: 'false # newer' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', viewport })
  const keys = await rowKeys(ui)
  expect(keys).toHaveLength(2)
  expect((await ui.find({ key: 'down' }))?.props.hotkey).toBe('j')
  await ui.press({ key: 'down' })
  // Enter presses the row under the ring, which j moved onto the marked row.
  await ui.press({ key: keys[1]! })
  let lines = await paneLines(ui)
  const at = lines.findIndex((l) => l.includes('false # older'))
  expect(lines[at + 1]).toContain('why it failed')
  expect(lines.some((l) => l.includes('false # newer') && l.includes('▸'))).toBe(true)
  // Enter again closes it.
  await ui.press({ key: keys[1]! })
  expect((await paneLines(ui)).join('\n')).not.toContain('why it failed')
  await ui.press({ key: 'up' })
  await ui.press({ key: keys[0]! })
  lines = await paneLines(ui)
  expect(lines[lines.findIndex((l) => l.includes('false # newer')) + 1]).toContain('why it failed')
  await ui.unmount()
})

test('an expanded row with a fix note shows the fix line', async ($, on) => {
  memoryHost(on, { git: true })
  let calls = 0
  // Fails, then passes (a fix note is kept and the record forgotten), then fails again.
  on('tool.call', { tool: 'Bash' }, async () => (++calls === 2 ? { result: 'ok' } : { isError: true, result: 'Exit code 1', text: 'Exit code 1\nboom' }))
  for (let i = 0; i < 3; i++) await $.tool.call({ tool: 'Bash', command: 'bun test # fixed once' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', viewport })
  const [key] = await rowKeys(ui)
  await ui.press({ key: key! })
  const lines = await paneLines(ui)
  expect(lines.some((l) => /^\s+fix\s+\S/.test(l))).toBe(true)
  await ui.unmount()
})

test('s opens the search; Enter applies it, x clears it; Forget all still forgets every counted record', async ($, on) => {
  memoryHost(on)
  failing(on)
  for (const c of ['bun test # a', 'bun run lint # b', 'npm test # c']) await $.tool.call({ tool: 'Bash', command: c })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', viewport })
  expect(await rowKeys(ui)).toHaveLength(3)
  expect(await ui.find({ key: 'search-field' })).toBeUndefined()
  await ui.press({ key: 'search' })
  expect((await ui.find({ key: 'search-field' }))?.type).toBe('Input')
  // Typing alone applies nothing; Enter does.
  await ui.input({ key: 'search-field', text: 'bun', kind: 'change' })
  expect(await rowKeys(ui)).toHaveLength(3)
  await ui.input({ key: 'search-field', text: 'bun' })
  expect(await ui.find({ key: 'search-field' })).toBeUndefined()
  expect(await rowKeys(ui)).toHaveLength(2)
  expect((await paneLines(ui)).join('\n')).not.toContain('npm test')
  expect((await ui.find({ key: 'search-clear' }))?.props.hotkey).toBe('x')
  await ui.press({ key: 'search-clear' })
  expect(await rowKeys(ui)).toHaveLength(3)
  expect(await ui.find({ key: 'search-clear' })).toBeUndefined()

  // With the filter on, the confirm counts and forgets every record, not only those shown.
  await ui.press({ key: 'search' })
  await ui.input({ key: 'search-field', text: 'npm' })
  expect(await rowKeys(ui)).toHaveLength(1)
  await ui.press({ key: 'forget-all' })
  expect((await ui.find({ key: 'forget-all-confirm' }))?.text).toBe('Forget all 3 records')
  await ui.press({ key: 'forget-all-confirm' })
  expect(await rowKeys(ui)).toEqual([])
  await ui.unmount()
  const after = await $.ui.mount({ ...PANE, surface: 'terminal', viewport })
  await after.press({ key: 'search-clear' }).catch(() => undefined)
  expect((await after.find({ type: 'Text', text: /Nothing remembered/ }))?.text.trim()).toBe('Nothing remembered in this project.')
  await after.unmount()
})

test('h opens the key list, rates first, within the pane; h again closes it', async ($, on) => {
  memoryHost(on)
  failing(on)
  for (let i = 0; i < 6; i++) await $.tool.call({ tool: 'Bash', command: `false # keys ${i}` })
  for (const [columns, rows] of [[80, 30], [40, 15]] as const) {
    const ui = await $.ui.mount({ ...PANE, props: sized(columns, rows), surface: 'terminal', viewport })
    // Where the bar has no room for Keys, its hotkey rides on a hidden twin.
    const help = columns === 40 ? 'twin:help' : 'help'
    expect((await ui.find({ key: help }))?.props.hotkey).toBe('h')
    await ui.press({ key: help })
    const lines = await paneLines(ui)
    expect(lines.length).toBeLessThanOrEqual(rows)
    for (const l of lines) expect([...l].length).toBe(columns)
    const title = lines.findIndex((l) => l.includes('Keys'))
    expect(title).toBeGreaterThan(0)
    expect(lines[title + 1]).toContain('No warning raised yet, so no rates.')
    expect(await rowKeys(ui)).not.toHaveLength(0)
    await ui.press({ key: help })
    expect((await paneLines(ui)).join('\n')).not.toContain('No warning raised yet')
    await ui.unmount()
  }
})
