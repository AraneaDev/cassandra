import { expect, mock, test } from 'claude-code/testing'

// The test environment has no `$.fs` or `$.process`, so the mod's bookkeeping fails inside
// its own try/catch here. What this proves against the real engine is that the module loads
// and that its `tool.call` hook is transparent: every call reaches the engine beneath it
// exactly once and its result comes back as the engine gave it. Records and warnings are
// covered by test/mod.spec.ts and by the spike against a real session.
test('the mod loads and passes a failing Bash call through untouched', async ($, on) => {
  mock.env(on, { CASSANDRA_HOME: '/tmp/cassandra-smoke', HOME: '/tmp/cassandra-smoke' })
  let ran = 0
  on('tool.call', { tool: 'Bash' }, async () => {
    ran += 1
    return { isError: true, result: 'Exit code 1', text: 'Exit code 1\nboom' }
  })

  for (let i = 1; i <= 2; i++) {
    const r = await $.tool.call({ tool: 'Bash', command: 'false # cassandra smoke' })
    expect(r.isError).toBe(true)
    expect(r.text).toBe('Exit code 1\nboom')
    expect(ran).toBe(i)
  }
})
