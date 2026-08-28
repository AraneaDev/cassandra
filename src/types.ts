/** Which extractor applies to a tool call. */
export type ToolKind = 'bash' | 'mcp' | 'ignored'

/** Whether a record came from a tool failure or an auto-mode permission denial. */
export type RecordKind = 'failure' | 'denial'

/** How a workspace state stamp was obtained. `none` means it could not be, and never warns. */
export type StateKind = 'git' | 'mtime' | 'none'

/** A workspace state fingerprint, used to decide whether anything changed since a failure. */
export interface StateStamp {
  kind: StateKind
  value: string
}

/** One remembered failure, stored as a single JSON file named by its fingerprint. */
export interface FailureRecord {
  tool: string
  display: string
  kind: RecordKind
  count: number
  stateStamp: string
  stateKind: StateKind
  sessionId: string
  compactions: number
  firstSeen: string
  lastSeen: string
  errorExcerpt: string
  agentId?: string
}

/** The subset of a Claude Code hook payload Cassandra reads. All fields are optional by design. */
export interface HookPayload {
  hook_event_name?: string
  session_id?: string
  cwd?: string
  tool_name?: string
  tool_input?: unknown
  tool_use_id?: string
  error_message?: string
  denial_reason?: string
  agent_id?: string
}
