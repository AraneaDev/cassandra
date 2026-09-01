---
description: Show the tool calls Cassandra remembers failing in this project
---

Run `bun "${CLAUDE_PLUGIN_ROOT}/src/cli.ts" list --cwd "$(pwd)"` and print its output
in a fenced code block, byte for byte.

Its columns are aligned by spaces, so reflowing it into a paragraph or a markdown
table destroys the thing being shown. Keep every line break and every run of spaces
exactly as printed, and do not recompute any number.

If the user asked for detail on one entry, run `why <hash>` instead. If they asked
whether Cassandra is worth keeping, run `stats` and read the false-positive rate and
the `same_context` share out of the result. Both print the same way, in a fenced
block, before anything you say about them.
