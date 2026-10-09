import { resolve } from 'node:path'
import { pathsFor } from './core/paths.ts'
import { nodeIo } from './io/node.ts'
import { list } from './commands/list.ts'
import { why } from './commands/why.ts'
import { forget } from './commands/forget.ts'
import { stats } from './commands/stats.ts'
import { exportAll } from './commands/export.ts'

const USAGE = `Usage: cassandra <command> [options]

  list              remembered failures for this project
  why <hash>        one record in full
  forget <hash>     drop one record
  forget --all      drop every record for this project
  stats             whether the warnings are earning their place
  export            the whole index as JSON

Options:
  --cwd <path>      project to act on (default: current directory)`

/** Parse argv and dispatch. Returns the exit code rather than calling exit, so it is testable. */
export async function run(argv: string[]): Promise<number> {
  const cwdFlag = argv.indexOf('--cwd')
  const cwd = cwdFlag !== -1 ? (argv[cwdFlag + 1] ?? process.cwd()) : process.cwd()
  // When --cwd is absent, cwdFlag is -1 and cwdFlag + 1 is 0: filtering on that index
  // would drop argv[0], the subcommand itself. Only strip the flag pair when it is
  // actually present.
  const args = cwdFlag === -1 ? argv : argv.filter((_, i) => i !== cwdFlag && i !== cwdFlag + 1)
  const [command, ...rest] = args
  const paths = await pathsFor(nodeIo, resolve(cwd))

  switch (command) {
    case 'list': return list(nodeIo, paths)
    case 'why': return why(nodeIo, paths, rest[0] ?? '')
    case 'forget': return forget(nodeIo, paths, rest.includes('--all') ? null : rest[0] ?? null, rest.includes('--all'))
    case 'stats': return stats(nodeIo, paths)
    case 'export': return exportAll(nodeIo, paths)
    default:
      console.log(USAGE)
      return 1
  }
}

if (import.meta.main) process.exit(await run(process.argv.slice(2)))
