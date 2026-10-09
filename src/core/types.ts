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
  /**
   * The failing tool's output. Claude Code names this `error`, confirmed against the
   * hooks reference. `error_message` was the name assumed while this plugin was written
   * and it does not exist, so it is kept only as a fallback in case the field is ever
   * renamed back. For Bash the string starts with a line reading `Exit code N`.
   */
  error?: string
  error_message?: string
  /** True when the failure reached Claude Code as an abort rather than a real tool error. */
  is_interrupt?: boolean
  denial_reason?: string
  reason?: string
  agent_id?: string
}
