#!/bin/sh
# Every command hook comes through here. The classic binary is built in the background by
# session-start.sh, and never on a Claude Code build that loads the mod, which handles the
# session itself. Until it exists there is nothing to do, and a hook pointing at a file
# that is not there would be reported on every tool call. So: run it when it is there,
# and otherwise read the event and leave quietly.
bin="${CLAUDE_PLUGIN_ROOT:-}/bin/cassandra-hook"
[ -x "$bin" ] && exec "$bin"
cat >/dev/null 2>&1
exit 0
