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
  /**
   * An `mtime` stamp computed with every file time cut to whole milliseconds, set only
   * when some file time had a fraction, so it differs from `value`. A front end whose
   * listing is whole-millisecond compares against this; see `unchanged`.
   */
  coarse?: string
  /** The raw git state behind a `git` stamp: what a fix note is computed from later. */
  git?: { head: string; dirty: string[] }
}

/** One remembered failure, stored as a single JSON file named by its fingerprint. */
export interface FailureRecord {
  tool: string
  display: string
  /** The monorepo package a Bash call ran in, relative to the repo root; absent at the root. */
  scope?: string
  kind: RecordKind
  count: number
  stateStamp: string
  stateKind: StateKind
  /** The stamp's `coarse` hash, when it had one. */
  stateCoarse?: string
  sessionId: string
  compactions: number
  firstSeen: string
  lastSeen: string
  errorExcerpt: string
  agentId?: string
  /** HEAD when the call failed, git repositories only. */
  gitHead?: string
  /** Paths git reported as changed when the call failed, at most 200. */
  dirty?: string[]
  /** True when `dirty` was cut at the cap, so a path missing from it may still have been dirty. */
  dirtyTruncated?: boolean
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
  /** SessionStart: why the session (re)started; `compact` after a compaction. */
  source?: string
  /** SubagentStart: the subagent's type; a fork inherits the transcript. */
  agent_type?: string
}

/** What changed between a failure and the success that followed, by file name. */
export interface FixNote {
  /** Changed paths, at most 10, sorted. */
  files: string[]
  /** How many further changed paths were not kept. */
  more: number
  /** When the note was computed, ISO. */
  at: string
  /** Changed files named, no visible change in the repository, or the failure HEAD is gone. */
  kind: 'changed' | 'elsewhere' | 'rewritten'
}
