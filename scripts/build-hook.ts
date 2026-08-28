/**
 * Compiles the hook entrypoint into a standalone binary.
 *
 * `bun run` on a TypeScript file pays transpilation on every invocation, which on
 * the PreToolUse path means every tool call for the life of a session. A compiled
 * binary skips that. The artefact is around 90MB, so it is gitignored and built on
 * first use rather than committed.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')
mkdirSync(join(root, 'bin'), { recursive: true })

const result = await Bun.build({
  entrypoints: [join(root, 'src', 'hook.ts')],
  outdir: join(root, 'bin'),
  target: 'bun',
  compile: { outfile: join(root, 'bin', 'cassandra-hook') },
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}
console.error('built bin/cassandra-hook')
