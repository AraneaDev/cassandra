import { pathsFor } from './paths'
import { list } from './commands/list'
import { why } from './commands/why'
import { forget } from './commands/forget'
import { stats } from './commands/stats'
import { exportAll } from './commands/export'

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
export function run(argv: string[]): number {
  const cwdFlag = argv.indexOf('--cwd')
  const cwd = cwdFlag !== -1 ? (argv[cwdFlag + 1] ?? process.cwd()) : process.cwd()
  // When --cwd is absent, cwdFlag is -1 and cwdFlag + 1 is 0: filtering on that index
  // would drop argv[0], the subcommand itself. Only strip the flag pair when it is
  // actually present.
  const args = cwdFlag === -1 ? argv : argv.filter((_, i) => i !== cwdFlag && i !== cwdFlag + 1)
  const [command, ...rest] = args
  const paths = pathsFor(cwd)

  switch (command) {
    case 'list': return list(paths)
    case 'why': return why(paths, rest[0] ?? '')
    case 'forget': return forget(paths, rest.includes('--all') ? null : rest[0] ?? null, rest.includes('--all'))
    case 'stats': return stats(paths)
    case 'export': return exportAll(paths)
    default:
      console.log(USAGE)
      return 1
  }
}

if (import.meta.main) process.exit(run(process.argv.slice(2)))
