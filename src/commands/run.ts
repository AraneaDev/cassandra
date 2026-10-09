import { pathsFor } from '../core/paths.ts'
import type { Io } from '../core/io.ts'
import { list } from './list.ts'
import { why } from './why.ts'
import { forget } from './forget.ts'
import { stats } from './stats.ts'
import { exportAll } from './export.ts'

/** What a command produces: the exit code and the text to show. */
export type CommandResult = { code: number; text: string }

/** The help text, shown for an unknown command. */
export const USAGE = `Usage: cassandra <command> [options]

  list              remembered failures for this project
  why <hash>        one record in full
  forget <hash>     drop one record
  forget --all      drop every record for this project
  stats             whether the warnings are earning their place
  export            the whole index as JSON

Options:
  --cwd <path>      project to act on (default: current directory)`

/** Route a subcommand to its implementation; the text the CLI prints and the mod returns. */
export async function runCommand(io: Io, cwd: string, args: string[]): Promise<CommandResult> {
  const [command = 'list', ...rest] = args.filter((a) => a !== '')
  const paths = await pathsFor(io, cwd)
  switch (command) {
    case 'list': return list(io, paths)
    case 'why': return why(io, paths, rest[0] ?? '')
    case 'forget': return forget(io, paths, rest.includes('--all') ? null : rest[0] ?? null, rest.includes('--all'))
    case 'stats': return stats(io, paths)
    case 'export': return exportAll(io, paths)
    default: return { code: 1, text: USAGE }
  }
}
