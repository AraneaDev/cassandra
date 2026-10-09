import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Keep every spec out of the developer's real home: the core writes a data-root pointer under HOME.
const home = mkdtempSync(join(tmpdir(), 'cass-home-'))
process.env.HOME = home
process.on('exit', () => rmSync(home, { recursive: true, force: true }))
delete process.env.CASSANDRA_HOME
delete process.env.CLAUDE_PLUGIN_DATA
