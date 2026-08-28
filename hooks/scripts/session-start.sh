#!/bin/sh
# Build ladder. Cassandra's hot path is a compiled binary that is gitignored
# because it is around 90MB, so the first session after install builds it.
#
# Three rungs: use the binary, build it in the background, or report inert. Every
# one of them ends in exit 0, because a plugin that cannot start must still not
# stop a session from starting.
set -u

root=${CLAUDE_PLUGIN_ROOT:-}
[ -n "$root" ] || exit 0

# Drain stdin so the caller never blocks on a full pipe.
cat >/dev/null 2>&1

[ -x "$root/bin/cassandra-hook" ] && exit 0

if ! command -v bun >/dev/null 2>&1; then
  printf '%s\n' '{"systemMessage":"cassandra is inert: bun was not found on PATH, so the hook binary cannot be built. Install bun and restart the session."}'
  exit 0
fi

# Background, so a first session never waits on a compile. Until it lands every
# hook invocation finds no binary and Claude Code skips it.
( cd "$root" && bun run scripts/build-hook.ts >/dev/null 2>&1 ) &

printf '%s\n' '{"systemMessage":"cassandra is building its hook binary in the background. It will be active from the next session."}'
exit 0
