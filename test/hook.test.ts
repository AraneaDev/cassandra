import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { handle } from '../src/hook'
import { pathsFor, pendingPath } from '../src/paths'
import { fingerprint } from '../src/fingerprint'
import { readRecord } from '../src/record'
import { readStats } from '../src/stats'

let tmp: string
let cwd: string

function gitInit(dir: string): void {
  const run = (...a: string[]): void => {
    Bun.spawnSync(['git', '-C', dir, ...a], { stdout: 'ignore', stderr: 'ignore' })
  }
  run('init', '-q'); run('config', 'user.email', 't@e.com'); run('config', 'user.name', 'T')
  writeFileSync(join(dir, 'a.txt'), 'one')
  run('add', '-A'); run('commit', '-qm', 'init')
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cass-hook-'))
  process.env.CASSANDRA_HOME = join(tmp, 'home')
  cwd = join(tmp, 'repo')
  mkdirSync(cwd, { recursive: true })
  gitInit(cwd)
})

afterEach(() => {
  delete process.env.CASSANDRA_HOME
  rmSync(tmp, { recursive: true, force: true })
})

const fail = (command: string) => ({
  hook_event_name: 'PostToolUseFailure',
  session_id: 's1', cwd, tool_name: 'Bash',
  tool_input: { command }, tool_use_id: 't1', error_message: '3 tests failing',
})

const pre = (command: string, extra: Record<string, unknown> = {}) => ({
  hook_event_name: 'PreToolUse',
  session_id: 's1', cwd, tool_name: 'Bash',
  tool_input: { command }, tool_use_id: 't2', ...extra,
})

test('an unknown command is silent', () => {
  expect(handle(pre('bun test'))).toBeNull()
})

test('a failure is recorded', () => {
  handle(fail('bun test'))
  const hash = fingerprint('Bash', { command: 'bun test' })!
  expect(readRecord(pathsFor(cwd), hash)?.count).toBe(1)
})

test('a repeat with nothing changed warns', () => {
  handle(fail('bun test'))
  const out = handle(pre('bun test'))
  expect(out).toBeString()
  const parsed = JSON.parse(out!)
  expect(parsed.hookSpecificOutput.hookEventName).toBe('PreToolUse')
  expect(parsed.hookSpecificOutput.additionalContext).toContain('bun test')
  expect(parsed.hookSpecificOutput.additionalContext).toContain('3 tests failing')
})

test('a repeat after a real edit is silent', () => {
  handle(fail('bun test'))
  writeFileSync(join(cwd, 'a.txt'), 'changed')
  expect(handle(pre('bun test'))).toBeNull()
})

test('warning writes a pending marker naming the record', () => {
  handle(fail('bun test'))
  handle(pre('bun test'))
  expect(existsSync(pendingPath(pathsFor(cwd), 't2'))).toBe(true)
})

test('a success on a warned call clears the record and logs a false positive', () => {
  handle(fail('bun test'))
  handle(pre('bun test'))
  handle({
    hook_event_name: 'PostToolUse', session_id: 's1', cwd,
    tool_name: 'Bash', tool_input: { command: 'bun test' }, tool_use_id: 't2',
  })
  const hash = fingerprint('Bash', { command: 'bun test' })!
  expect(readRecord(pathsFor(cwd), hash)).toBeNull()
  expect(readStats(pathsFor(cwd)).some((e) => e.kind === 'false_positive')).toBe(true)
})

test('a repeat failure on a warned call logs confirmed and does not clear', () => {
  handle(fail('bun test'))
  handle(pre('bun test'))
  handle({ ...fail('bun test'), tool_use_id: 't2' })
  const hash = fingerprint('Bash', { command: 'bun test' })!
  expect(readRecord(pathsFor(cwd), hash)?.count).toBe(2)
  expect(readStats(pathsFor(cwd)).some((e) => e.kind === 'confirmed')).toBe(true)
})

test('a success on a call that was never warned about clears nothing', () => {
  handle(fail('bun test'))
  const out = handle({
    hook_event_name: 'PostToolUse', session_id: 's1', cwd,
    tool_name: 'Bash', tool_input: { command: 'bun test' }, tool_use_id: 'never-warned',
  })
  expect(out).toBeNull()
  const hash = fingerprint('Bash', { command: 'bun test' })!
  expect(readRecord(pathsFor(cwd), hash)).not.toBeNull()
})

test('a permission denial is recorded and warns on repeat', () => {
  handle({
    hook_event_name: 'PermissionDenied', session_id: 's1', cwd,
    tool_name: 'Bash', tool_input: { command: 'curl example.com' },
    tool_use_id: 't9', denial_reason: 'network egress',
  })
  const out = handle(pre('curl example.com'))
  expect(out).toBeString()
  expect(JSON.parse(out!).hookSpecificOutput.additionalContext).toContain('network egress')
})

test('a main-agent failure retried inside a subagent crosses the subagent boundary', () => {
  handle(fail('bun test'))
  handle(pre('bun test', { agent_id: 'a1', tool_use_id: 't5' }))
  expect(readStats(pathsFor(cwd)).some((e) => e.kind === 'warned' && e.boundary === 'subagent')).toBe(true)
})

test('a repeat after a compaction is attributed to compaction', () => {
  handle(fail('bun test'))
  handle({ hook_event_name: 'PostCompact', session_id: 's1', cwd })
  handle(pre('bun test', { tool_use_id: 't6' }))
  expect(readStats(pathsFor(cwd)).some((e) => e.kind === 'warned' && e.boundary === 'compaction')).toBe(true)
})

test('Edit and Write calls are ignored entirely', () => {
  expect(handle({
    hook_event_name: 'PostToolUseFailure', session_id: 's1', cwd,
    tool_name: 'Edit', tool_input: { old_string: 'a', new_string: 'b' },
    tool_use_id: 't7', error_message: 'boom',
  })).toBeNull()
  expect(handle({
    hook_event_name: 'PreToolUse', session_id: 's1', cwd,
    tool_name: 'Edit', tool_input: { old_string: 'a' }, tool_use_id: 't8',
  })).toBeNull()
})

test('an unknown event, empty payload or missing cwd is silent', () => {
  expect(handle({ hook_event_name: 'Nonsense' })).toBeNull()
  expect(handle({})).toBeNull()
  expect(handle({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'x' } })).toBeNull()
})

test('the same subagent retrying its own failure is same_context, not subagent', () => {
  handle({ ...fail('bun test'), agent_id: 'a1' })
  handle(pre('bun test', { agent_id: 'a1', tool_use_id: 't5' }))
  expect(readStats(pathsFor(cwd)).some((e) => e.kind === 'warned' && e.boundary === 'same_context')).toBe(true)
})

test('a different subagent retrying is attributed to the subagent boundary', () => {
  handle({ ...fail('bun test'), agent_id: 'a1' })
  handle(pre('bun test', { agent_id: 'a2', tool_use_id: 't5' }))
  expect(readStats(pathsFor(cwd)).some((e) => e.kind === 'warned' && e.boundary === 'subagent')).toBe(true)
})

test('the main agent retrying a subagent failure is attributed to the subagent boundary', () => {
  handle({ ...fail('bun test'), agent_id: 'a1' })
  handle(pre('bun test', { tool_use_id: 't5' }))
  expect(readStats(pathsFor(cwd)).some((e) => e.kind === 'warned' && e.boundary === 'subagent')).toBe(true)
})

test('a failure record stores the agent id it was written under', () => {
  handle({ ...fail('bun test'), agent_id: 'a1' })
  const hash = fingerprint('Bash', { command: 'bun test' })!
  expect(readRecord(pathsFor(cwd), hash)?.agentId).toBe('a1')
})
