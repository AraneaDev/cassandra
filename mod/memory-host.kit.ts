import { expect, mock, type test } from 'claude-code/testing'

// Shared by the mod's kit tests. The kit's `$` has no fs or process, but the test's own
// hooks sit beneath the plugin and answer its `$.fs.*` and `$.process.run` calls (the pane
// spike's seam E). Here they keep a small filesystem in memory, so the real mod records a
// real failure and the real pane draws it from the store.

/** The surfaces every pane test draws on. */
export const SURFACES = ['terminal', 'desktop'] as const
/** A docked pane's props, 80 by 30. */
export const PROPS = {
  title: 'Cassandra',
  isFocused: true,
  bodyColumns: 80,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
} as const
/** The pane this plugin opens, as a mount names it. */
export const PANE = { plugin: 'cassandra', component: 'Pane', requestId: 'cassandra', props: PROPS } as const
/** The terminal the pane is mounted in. */
export const viewport = { columns: 160, rows: 40, isFullscreen: true }
/** The session's directory. */
export const CWD = '/mem/proj'

/** The `on` a kit test is handed. */
export type On = Parameters<Parameters<typeof test>[1]>[1]

/** The host calls answered here, as far as this test reads them. */
interface HostCall { path: string; text: string; argv: readonly string[]; init?: { stdin?: string } }

/** What a memory host leaves the test: its files, and how many panes the plugin asked to open. */
export interface MemoryHost { files: Map<string, string>; opened: { count: number } }

/**
 * Answer the plugin's host calls from an in-memory filesystem. With `git`, the project is a
 * checkout on branch `main` at a clean HEAD; without it, git answers nothing.
 */
export function memoryHost(on: On, { git = false }: { git?: boolean } = {}): MemoryHost {
  const files = new Map<string, string>([[`${CWD}/a.txt`, 'one']])
  const opened = { count: 0 }
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
    opened.count += 1
    return { value: { isPlaced: true } }
  })
  h('ui.panes', async () => ({ value: [] }))
  h('session.surfaces', async () => ({ value: ['terminal'] }))
  return { files, opened }
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
export async function paneLines(ui: { drawn(): Promise<unknown> }): Promise<string[]> {
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
export const sized = (columns: number, rows: number) => ({ ...PROPS, bodyColumns: columns, scroll: { offset: 0, bodyRows: rows } })

/** The keys of the rows a drawing lists, in order. */
export async function rowKeys(ui: { findAll(q: { type: string }): Promise<Array<{ key: string | undefined }>> }): Promise<string[]> {
  return (await ui.findAll({ type: 'Button' })).map((b) => String(b.key)).filter((k) => k.startsWith('row:'))
}

/** A beneath that fails every call, and denies one whose command says `denied`. */
export function failing(on: On): void {
  const h = on as unknown as (event: string, matcher: { tool: string }, hook: (_$: unknown, e: { command?: string }) => Promise<unknown>) => void
  h('tool.call', { tool: 'Bash' }, async (_$, e) => (String(e.command).includes('denied') ? { deny: 'blocked by policy' } : { isError: true, result: 'Exit code 1', text: 'Exit code 1\nboom' }))
}
