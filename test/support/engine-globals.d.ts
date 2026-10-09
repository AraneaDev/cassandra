// The globals the engine gives a hooks module, declared for `tsc` in CI, where the
// engine's own types (laid under .claude-plugin/types/ on load) do not exist. A module
// must not declare these itself, so they live here, outside the plugin's modules.

/** The JSX factory the engine's mod runtime supplies. */
declare function h(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): unknown
