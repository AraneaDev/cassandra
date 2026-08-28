/**
 * Harvests real hook payloads from local Claude Code transcripts.
 *
 * Every schema assumption in the test suite is otherwise mine rather than the
 * harness's. Reading actual sessions is what catches a field that moved or a shape
 * I guessed wrong. When no transcripts exist the generator writes a small synthetic
 * set instead, so the suite still runs on a clean machine.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const outDir = join(import.meta.dir, '..', 'test', 'fixtures')
mkdirSync(outDir, { recursive: true })

const SYNTHETIC = [
  { hook_event_name: 'PreToolUse', session_id: 's1', cwd: '/tmp/x', tool_name: 'Bash', tool_input: { command: 'bun test' }, tool_use_id: 'toolu_1' },
  { hook_event_name: 'PostToolUseFailure', session_id: 's1', cwd: '/tmp/x', tool_name: 'Bash', tool_input: { command: 'bun test' }, tool_use_id: 'toolu_1', error_message: 'exit code 1' },
  { hook_event_name: 'PermissionDenied', session_id: 's1', cwd: '/tmp/x', tool_name: 'Bash', tool_input: { command: 'curl example.com' }, tool_use_id: 'toolu_2', denial_reason: 'network egress' },
  { hook_event_name: 'PreToolUse', session_id: 's1', cwd: '/tmp/x', tool_name: 'mcp__knossos__scan_project', tool_input: { project_id: 'pp', depth: 3 }, tool_use_id: 'toolu_3' },
]

/** Pull tool_use blocks out of transcripts and reshape them into PreToolUse payloads. */
function harvest(): unknown[] {
  const base = join(homedir(), '.claude', 'projects')
  if (!existsSync(base)) return []
  const found: unknown[] = []
  try {
    for (const project of readdirSync(base).slice(0, 20)) {
      const dir = join(base, project)
      let files: string[]
      try {
        files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).slice(0, 3)
      } catch {
        continue
      }
      for (const file of files) {
        for (const line of readFileSync(join(dir, file), 'utf8').split('\n').slice(0, 4000)) {
          if (!line.includes('"tool_use"')) continue
          try {
            const entry = JSON.parse(line) as { message?: { content?: unknown[] } }
            for (const block of entry.message?.content ?? []) {
              const b = block as { type?: string; name?: string; input?: unknown; id?: string }
              if (b.type !== 'tool_use' || !b.name) continue
              if (b.name !== 'Bash' && !b.name.startsWith('mcp__')) continue
              found.push({
                hook_event_name: 'PreToolUse', session_id: 'harvested', cwd: '/tmp/x',
                tool_name: b.name, tool_input: b.input, tool_use_id: b.id ?? 'toolu_h',
              })
              if (found.length >= 400) return found
            }
          } catch {
            // A truncated line is not a fixture.
          }
        }
      }
    }
  } catch {
    // An unreadable transcript directory simply yields nothing.
  }
  return found
}

const harvested = harvest()
writeFileSync(join(outDir, 'payloads.json'), JSON.stringify([...SYNTHETIC, ...harvested], null, 2))
console.error(`fixtures: ${SYNTHETIC.length} synthetic + ${harvested.length} harvested`)
