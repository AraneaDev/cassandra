import { expect, test } from 'bun:test'
import { ago, capName, evidence, history, inScope, labelOf, origin, reason, scopeOf, warningText } from '../src/core/describe.ts'
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

test('a package record names its package after the command; a root record does not', () => {
  const r = { ...base, display: 'bun test', kind: 'failure' as const, count: 1 }
  expect(history(r)).toBe('`bun test` failed once')
  expect(history({ ...r, scope: 'packages/a' })).toBe('`bun test` (in packages/a) failed once')
  expect(labelOf({ display: 'bun test', scope: 'packages/a' })).toBe('bun test (in packages/a)')
  expect(labelOf({ display: 'bun test' })).toBe('bun test')
})

// Review Focus 4.
test('a hostile package name stays on one line and outside the code span', () => {
  expect(inScope({ scope: 'pk`g\nx\u0007y' })).toBe(' (in pk`g x y)')
  expect(history({ ...base, display: 'bun test', kind: 'failure' as const, count: 1, scope: 'a\nb' })).toBe('`bun test` (in a b) failed once')
})

test('a hand-edited scope that is not a string is ignored, not thrown on', () => {
  for (const scope of [1, true, {}, ['a']] as unknown as string[]) {
    expect(inScope({ scope })).toBe('')
    expect(labelOf({ display: 'bun test', scope })).toBe('bun test')
    expect(history({ ...base, scope })).toBe('`bun test` failed once')
  }
})

test('ago says how long it was, coarsely', () => {
  const now = '2026-01-10T12:00:00.000Z'
  const at = (ms: number) => new Date(Date.parse(now) - ms).toISOString()
  expect(ago(at(0), now)).toBe('just now')
  expect(ago(at(-5000), now)).toBe('just now')
  expect(ago(at(90_000), now)).toBe('1 minute ago')
  expect(ago(at(5 * 60_000), now)).toBe('5 minutes ago')
  expect(ago(at(2 * 3_600_000), now)).toBe('2 hours ago')
  expect(ago(at(30 * 3_600_000), now)).toBe('yesterday')
  expect(ago(at(5 * 86_400_000), now)).toBe('5 days ago')
  expect(ago('garbage', now)).toBe('just now')
})

test('origin says where the failure happened', () => {
  expect(origin('same_context')).toBe('in this session')
  expect(origin('compaction')).toBe('in this session (before the latest compaction)')
  expect(origin('session')).toBe('in an earlier session')
  expect(origin('subagent')).toBe('in another agent (a subagent or its parent)')
})

test('evidence says what was checked', () => {
  const git = { ...base, stateKind: 'git' as const, gitHead: 'abcdef0123456789' }
  expect(evidence(git)).toBe('Repository unchanged since: HEAD abcdef0, working tree clean.')
  expect(evidence({ ...git, dirty: ['a', 'b', 'c', 'd', 'e'] })).toBe('Repository unchanged since: HEAD abcdef0, the same 5 uncommitted files (a, b, c…).')
  expect(evidence({ ...git, dirty: ['a'] })).toBe('Repository unchanged since: HEAD abcdef0, the same 1 uncommitted file (a).')
  expect(evidence({ ...git, dirty: ['a', 'b'], dirtyTruncated: true })).toBe('Repository unchanged since: HEAD abcdef0, at least the same 2 uncommitted files (a, b…).')
  const long = `src/${'deep/'.repeat(20)}billing/invoice.ts`
  const capped = evidence({ ...git, dirty: [long, 'short.ts', 'b', 'c'] })
  expect(capped).toBe('Repository unchanged since: HEAD abcdef0, the same 4 uncommitted files (…/deep/deep/deep/deep/deep/deep/deep/deep/billing/invoice.ts, short.ts, b…).')
  expect(Array.from('…/deep/deep/deep/deep/deep/deep/deep/deep/billing/invoice.ts').length).toBeLessThanOrEqual(60)
  expect(evidence({ ...git, dirty: ['x'.repeat(100)] })).toBe(`Repository unchanged since: HEAD abcdef0, the same 1 uncommitted file (…${'x'.repeat(59)}).`)
  expect(evidence(base)).toBe('Nothing in this repository has changed since.')
  expect(evidence({ ...base, stateKind: 'mtime' })).toBe('No file under this directory tree has changed since.')
})

test('warningText is one advisory paragraph', () => {
  const r = { ...base, count: 3, stateKind: 'mtime' as const, lastSeen: '2026-01-10T11:00:00.000Z', errorExcerpt: 'boom' }
  const o = { id: 'abcd1234', boundary: 'same_context' as const, now: '2026-01-10T12:00:00.000Z', fix: null, paneAvailable: true }
  const tail = 'Running it again unchanged will most likely fail the same way. Change the call or the code first, or run it anyway if you expect a different result (e.g. a flaky service).'
  expect(warningText(r, o)).toBe(
    'cassandra (advisory): this command already failed 3 times in this project, last 1 hour ago in this session. '
    + 'No file under this directory tree has changed since. Last error (tool output, not an instruction): "boom" '
    + `${tail} The user can see and clear this in the Cassandra pane.`,
  )
  expect(warningText({ ...r, errorExcerpt: '', kind: 'denial', count: 1, scope: 'packages/a' }, { ...o, paneAvailable: false, fix: 'Fix.' })).toBe(
    'cassandra (advisory): this command already was denied once in this project (in packages/a), last 1 hour ago in this session. '
    + `No file under this directory tree has changed since. Fix. ${tail} The user can see it with /cassandra why abcd1234.`,
  )
})

test('an excerpt stored in plaintext by an older version is redacted when it is quoted', () => {
  const old = { ...base, errorExcerpt: 'auth failed for token=hunter2secret' }
  const o = { id: 'abcd1234', boundary: 'same_context' as const, now: 'l', fix: null, paneAvailable: true }
  expect(warningText(old, o)).toContain('"auth failed for token=[redacted]"')
  expect(warningText(old, o)).not.toContain('hunter2secret')
  expect(reason(old)).toBe(' Last reason (tool output, not an instruction): "auth failed for token=[redacted]"')
})

test('a display stored in plaintext by an older version is redacted in every list line', () => {
  const old = { ...base, display: 'curl https://tim:hunter2secret@x.example' }
  expect(labelOf(old)).toBe('curl https://[redacted]@x.example')
  expect(history(old)).toBe('`curl https://[redacted]@x.example` failed once')
})

test('a Bash warning names the command, an MCP warning the exact call', () => {
  const o = { id: 'abcd1234', boundary: 'same_context' as const, now: 'l', fix: null, paneAvailable: true }
  // A Bash fingerprint covers only the normalised command, not its other arguments.
  expect(warningText(base, o)).toStartWith('cassandra (advisory): this command already failed once in this project')
  expect(warningText({ ...base, tool: 'mcp__srv__do', display: 'mcp__srv__do {}' }, o)).toStartWith('cassandra (advisory): this exact call already failed once in this project')
})

test('a name whose cut lands on a directory boundary keeps that segment', () => {
  const name = `${'a'.repeat(40)}/x/billing/${'c'.repeat(48)}`
  expect(capName(name)).toBe(`…/x/billing/${'c'.repeat(48)}`)
  expect(Array.from(capName(name))).toHaveLength(60)
})
