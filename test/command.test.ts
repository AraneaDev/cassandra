import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const command = readFileSync(join(import.meta.dir, '..', 'commands', 'cassandra.md'), 'utf8')

describe('the slash command', () => {
  it('has frontmatter with a description', () => {
    expect(command).toMatch(/^---\n[\s\S]*description:[\s\S]*\n---/)
  })

  it('runs the list', () => {
    expect(command).toContain('src/cli.ts" list --cwd')
  })

  // list and stats both lay their columns out on runs of spaces. Unfenced,
  // markdown reflows the whole thing into a paragraph and the columns, which
  // are the only reason the output is readable, are the casualty.
  it('asks for the output in a fenced block, kept byte for byte', () => {
    expect(command).toContain('fenced code block')
    expect(command).toContain('byte for byte')
  })

  it('says what reflowing it would cost', () => {
    expect(command).toMatch(/aligned by spaces/)
    expect(command).toMatch(/every run of spaces/)
  })

  // The command picks between three subcommands depending on what was asked,
  // which is why it is a prompt rather than an expanding one-liner. Losing a
  // branch would quietly make one of them unreachable.
  it('keeps all three subcommands reachable', () => {
    for (const sub of ['list', 'why', 'stats']) {
      expect(command).toContain(sub)
    }
  })
})
