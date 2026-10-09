#!/bin/sh
# Build ladder for the classic hook path. Cassandra's binary is gitignored because it
# is around 90MB, so the first session after install builds it.
#
# On a Claude Code build that loads the in-process mod, the mod claims the session and
# the binary is not needed; the claim is a marker file, checked first. Every rung ends
# in exit 0, because a plugin that cannot start must still not stop a session starting.
set -u

root=${CLAUDE_PLUGIN_ROOT:-}
[ -n "$root" ] || exit 0

# Read stdin whole: the caller must never block on a full pipe, and the session id is in it.
input=$(cat 2>/dev/null || true)

# The mod cannot see CLAUDE_PLUGIN_DATA, so leave the data root where it looks for one
# (src/core/paths.ts reads the same pointer). This runs before the mod's session start.
# An explicit CASSANDRA_HOME wins over the pointer, so then there is nothing to leave.
if [ -z "${CASSANDRA_HOME:-}" ] && [ -n "${CLAUDE_PLUGIN_DATA:-}" ] && [ -n "${HOME:-}" ]; then
  {
    ptr="$HOME/.cassandra/data-root"
    if [ "$(cat "$ptr" 2>/dev/null || true)" != "$CLAUDE_PLUGIN_DATA" ]; then
      mkdir -p "$HOME/.cassandra" &&
        printf '%s' "$CLAUDE_PLUGIN_DATA" >"$ptr.$$" &&
        mv -f "$ptr.$$" "$ptr"
      rm -f "$ptr.$$"
    fi
  } >/dev/null 2>&1 || true
fi

# The data root, resolved as src/core/paths.ts resolves it: explicit, pointer, default.
data=${CASSANDRA_HOME:-${CLAUDE_PLUGIN_DATA:-}}
if [ -z "$data" ] && [ -f "${HOME:-/nonexistent}/.cassandra/data-root" ]; then
  data=$(cat "$HOME/.cassandra/data-root")
fi
[ -n "$data" ] || data="${HOME:-/nonexistent}/.cassandra"

# The session id, sanitised exactly as safeSegment does it.
id=$(printf '%s' "$input" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
seg=$(printf '%s' "$id" | tr -c 'a-zA-Z0-9._-' '-' | cut -c1-120)
case "$seg" in ''|.|..) seg=unknown ;; esac
[ -n "$id" ] && [ -f "$data/sessions/$seg.mod" ] && exit 0

[ -x "$root/bin/cassandra-hook" ] && exit 0

if ! command -v bun >/dev/null 2>&1; then
  printf '%s\n' '{"systemMessage":"cassandra: bun was not found on PATH, so the classic hook binary cannot be built. On Claude Code builds that load plugin mods, cassandra runs as an in-process mod and needs no bun; otherwise install bun and restart the session."}'
  exit 0
fi

# Background, so a first session never waits on a compile. Until it lands every
# hook invocation finds no binary and Claude Code skips it.
( cd "$root" && bun run scripts/build-hook.ts >/dev/null 2>&1 ) &

printf '%s\n' '{"systemMessage":"cassandra is building its classic hook binary in the background, for Claude Code builds without the in-process mod. Where the mod loads, cassandra is already active."}'
exit 0
