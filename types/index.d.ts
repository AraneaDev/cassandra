// Cassandra's state contract: what `/cassandra pane` keeps in `$.state` between redraws.
// The exported type makes this file a module, so the block below augments 'claude-code'.

/** A record's full fingerprint, as the pane stores the selection. */
export type CassandraHash = string

declare module 'claude-code' {
  interface PluginState {
    cassandra: { selected: CassandraHash | null; confirmAll: boolean; rev: number; notice: string | null }
  }
}
