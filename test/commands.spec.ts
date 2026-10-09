import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { list } from '../src/commands/list.ts'
import { why } from '../src/commands/why.ts'
import { settle } from '../src/core/engine.ts'
import { run } from '../src/cli.ts'
import { runCommand, USAGE } from '../src/commands/run.ts'
import { nodeIo } from '../src/io/node.ts'
import { pathsFor } from '../src/core/paths.ts'
import { upsertRecord } from '../src/core/record.ts'

let tmp: string; let cwd: string
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'cass-cmd-')); process.env.CASSANDRA_HOME = join(tmp, 'home'); cwd = join(tmp, 'p'); mkdirSync(cwd) })
afterEach(() => { delete process.env.CASSANDRA_HOME; rmSync(tmp, { recursive: true, force: true }) })

const seed = { tool: 'Bash', display: 'bun test', kind: 'failure' as const, stateStamp: 'a', stateKind: 'git' as const, sessionId: 's', compactions: 0, errorExcerpt: 'boom' }

test('commands return their text and code without printing (Review Focus 4)', async () => {
  const printed: unknown[] = []
  const original = console.log
  console.log = (...a: unknown[]) => { printed.push(a) }
  try {
    expect(await runCommand(nodeIo, cwd, ['list'])).toEqual({ code: 0, text: 'No remembered failures for this project.' })
    await upsertRecord(nodeIo, await pathsFor(nodeIo, cwd), 'aa11bb22cc33dd44', seed)
    const listed = await runCommand(nodeIo, cwd, [])
    expect(listed.code).toBe(0)
    expect(listed.text.startsWith('1 remembered failure:\n\n  aa11bb22  failed 1x')).toBe(true)
    expect(listed.text.endsWith('\n')).toBe(false)
    expect(await runCommand(nodeIo, cwd, ['nope'])).toEqual({ code: 1, text: USAGE })
    expect((await runCommand(nodeIo, cwd, ['why'])).code).toBe(1)
    expect((await runCommand(nodeIo, cwd, ['forget'])).code).toBe(1)
  } finally {
    console.log = original
  }
  expect(printed).toEqual([])
})

test('the CLI passes empty-string arguments through as given', async () => {
  await upsertRecord(nodeIo, await pathsFor(nodeIo, cwd), 'aa11bb22cc33dd44', seed)
  const printed: string[] = []
  const original = console.log
  console.log = (...a: unknown[]) => { printed.push(a.join(' ')) }
  try {
    expect(await run(['forget', '', 'aa11bb22cc33dd44', '--cwd', cwd])).toBe(1)
    expect(printed).toEqual(['Pass a hash, or --all to clear the project index.'])
    expect((await runCommand(nodeIo, cwd, ['list'])).text).toContain('aa11bb22')
    printed.length = 0
    expect(await run([''])).toBe(1)
    expect(printed).toEqual([USAGE])
  } finally {
    console.log = original
  }
})

test('list and why name the package of a monorepo record', async () => {
  mkdirSync(join(cwd, '.git')); writeFileSync(join(cwd, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  mkdirSync(join(cwd, 'packages', 'a'), { recursive: true }); writeFileSync(join(cwd, 'packages', 'a', 'package.json'), '{}')
  await settle(nodeIo, { tool: 'Bash', input: { command: 'bun test' }, cwd: join(cwd, 'packages', 'a'), sessionId: 's' }, { kind: 'failure', reason: 'boom' }, null)
  const paths = await pathsFor(nodeIo, cwd)
  const listed = await list(nodeIo, paths)
  expect(listed.text).toContain('bun test (in packages/a)')
  const hash = listed.text.match(/ ([0-9a-f]{8}) /)![1]!
  expect((await why(nodeIo, paths, hash)).text.startsWith('bun test (in packages/a)\n')).toBe(true)
})
