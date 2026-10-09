import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Keep every spec out of the developer's real home: the core writes a data-root pointer under HOME.
process.env.HOME = mkdtempSync(join(tmpdir(), 'cass-home-'))
delete process.env.CASSANDRA_HOME
delete process.env.CLAUDE_PLUGIN_DATA
