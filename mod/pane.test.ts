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

/** Answer the plugin's host calls from an in-memory filesystem. */
function memoryHost(on: On): void {
  const files = new Map<string, string>([[`${CWD}/a.txt`, 'one']])
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
    // No git here: the freshness stamp falls back to the tree's mtimes.
    return done(128)
  })
  h('ui.open', async () => ({ value: { isPlaced: true } }))
  h('ui.panes', async () => ({ value: [] }))
  h('session.surfaces', async () => ({ value: ['terminal'] }))
}

test('the pane opens, draws the remembered failure, and asks before forgetting everything', async ($, on) => {
  memoryHost(on)
  on('tool.call', { tool: 'Bash' }, async () => ({ isError: true, result: 'Exit code 1', text: 'Exit code 1\nboom' }))
  await $.tool.call({ tool: 'Bash', command: 'false # cassandra pane' })

  const r = await $.command.run({ command: 'cassandra', args: 'pane' })
  expect(r.text).toBe('Opened the Cassandra pane.')

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface, viewport })
    const keys = (await ui.findAll({ type: 'Button' })).map((b) => b.key)
    expect(keys).toHaveLength(3)
    expect(keys[0]).toMatch(/^row:[0-9a-f]{8}$/)
    expect(keys.slice(1)).toEqual(['forget', 'forget-all'])

    await ui.press({ key: 'forget-all' })
    expect(await ui.find({ key: 'forget-all-confirm' })).toBeDefined()
    await ui.press({ key: 'forget-all-cancel' })
    expect(await ui.find({ key: 'forget-all' })).toBeDefined()
    await ui.unmount()
  }

  // The confirm is the person's own gesture: it forgets everything, and the pane redraws empty.
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', viewport })
  await ui.press({ key: 'forget-all' })
  await ui.press({ key: 'forget-all-confirm' })
  expect(await ui.findAll({ type: 'Button' })).toEqual([])
  expect(await ui.find({ type: 'Text', text: /Nothing remembered in this project\./ })).toBeDefined()
  await ui.unmount()
})
