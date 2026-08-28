---
description: Show the tool calls Cassandra remembers failing in this project
---

Run `bun "${CLAUDE_PLUGIN_ROOT}/src/cli.ts" list --cwd "$(pwd)"` and show the output.

If the user asked for detail on one entry, run `why <hash>` instead. If they asked
whether Cassandra is worth keeping, run `stats` and read the false-positive rate and
the `same_context` share out of the result.
