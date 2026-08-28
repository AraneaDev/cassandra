import { expect, test } from 'bun:test'
import type { FailureRecord } from '../src/types'

test('FailureRecord shape is constructible', () => {
  const r: FailureRecord = {
    tool: 'Bash',
    display: 'bun test',
    kind: 'failure',
    count: 1,
    stateStamp: 'a3f1c8',
    stateKind: 'git',
    sessionId: 's1',
    compactions: 0,
    firstSeen: '2026-08-28T00:00:00Z',
    lastSeen: '2026-08-28T00:00:00Z',
    errorExcerpt: 'boom',
  }
  expect(r.count).toBe(1)
})
