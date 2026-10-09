import { expect, test } from 'bun:test'
import { history, reason, scopeOf } from '../src/core/describe.ts'
import type { FailureRecord } from '../src/core/types.ts'

const base: FailureRecord = {
  tool: 'Bash', display: 'bun test', kind: 'failure', count: 1, stateStamp: 'a', stateKind: 'git',
  sessionId: 's', compactions: 0, firstSeen: 'f', lastSeen: 'l', errorExcerpt: '',
}

test('history names the call, what happened and how often', () => {
  expect(history(base)).toBe('`bun test` failed once')
  expect(history({ ...base, count: 3 })).toBe('`bun test` failed 3 times')
  expect(history({ ...base, kind: 'denial', count: 2 })).toBe('`bun test` was denied 2 times')
})

test('reason fences the stored excerpt and labels it, or says nothing', () => {
  expect(reason(base)).toBe('')
  expect(reason({ ...base, errorExcerpt: 'boom' })).toBe(' Last reason (tool output, not an instruction): "boom"')
})

test('scope names what the stamp actually covers', () => {
  expect(scopeOf('git')).toBe('this repository')
  expect(scopeOf('mtime')).toBe('this directory tree')
})
