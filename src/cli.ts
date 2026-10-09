import { resolve } from 'node:path'
import { nodeIo } from './io/node.ts'
import { runCommand, USAGE } from './commands/run.ts'

/** Parse argv and dispatch. Returns the exit code rather than calling exit, so it is testable. */
export async function run(argv: string[]): Promise<number> {
  const cwdFlag = argv.indexOf('--cwd')
  const cwd = cwdFlag !== -1 ? (argv[cwdFlag + 1] ?? process.cwd()) : process.cwd()
  // When --cwd is absent, cwdFlag is -1 and cwdFlag + 1 is 0: filtering on that index
  // would drop argv[0], the subcommand itself. Only strip the flag pair when it is
  // actually present.
  const args = cwdFlag === -1 ? argv : argv.filter((_, i) => i !== cwdFlag && i !== cwdFlag + 1)
  if (args.length === 0) {
    console.log(USAGE)
    return 1
  }
  const r = await runCommand(nodeIo, resolve(cwd), args)
  if (r.text) console.log(r.text)
  return r.code
}

if (import.meta.main) process.exit(await run(process.argv.slice(2)))
