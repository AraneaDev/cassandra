/**
 * Cassandra's own two tools, by full name. Nothing else under `mcp__cassandra__` is ours:
 * a user's MCP server may be called `cassandra` too, and its tools are tracked like any other.
 * Kept apart from tools.ts, which imports the fingerprint module that needs this set.
 */
/** How the engine prefixes this plugin's tools. */
export const OWN_TOOL_PREFIX = 'mcp__cassandra__'
/** The two tool names, without the prefix. */
export const OWN_TOOL_NAMES = ['query', 'resolve'] as const
/** The full names of the two tools. */
export const OWN_TOOLS: ReadonlySet<string> = new Set(OWN_TOOL_NAMES.map((n) => `${OWN_TOOL_PREFIX}${n}`))
