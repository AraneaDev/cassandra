import type { LastWarning, PaneTab } from '../src/core/pane.ts'
import type { ModHost } from '../src/io/mod.ts'
import type { Elements } from './pane.tsx'

/** A user-role row a plugin appends: text blocks the model reads, in the named loop (main when absent). */
export interface AppendArgs {
  message: { type: 'user'; content: Array<{ type: 'text'; text: string }> }
  agentId?: string
}

/** What an append resolves to: the stored row, or `{ deny }` when a plugin above refused it. */
export interface AppendResult {
  deny?: string
  [key: string]: unknown
}

/** What the pane keeps in `$.state` between redraws; `types/index.d.ts` declares the same contract to the engine. */
export interface PaneState {
  selected: string | null
  confirmAll: boolean
  rev: number
  notice: string | null
  tab: PaneTab
  expanded: boolean
  showFull: boolean
  fullPage: number
  /** The record `fullPage` was turned on; any other record shows its first page. */
  fullPageOf: string | null
  query: string
  confirmRetest: string | null
  lastWarning: LastWarning | null
  searching: boolean
  showKeys: boolean
}

/** A reference to one of the pane's values, as `$.state` takes it. */
export type PaneRef<K extends keyof PaneState> = { readonly plugin: 'cassandra'; readonly key: K }

/** The arguments of `$.ui.open`, as far as the mod passes them. */
export interface OpenArgs {
  id: string
  title: string
  focus: boolean
  closeOnEscape: boolean
}

/** The slice of `$` the hooks use: the core's, the session's identity and its append, tool registration, state and the pane. */
export type ModEngine = ModHost & {
  session: { id(): Promise<string>; cwd(): Promise<string>; append(args: AppendArgs): Promise<AppendResult>; surfaces(): Promise<readonly string[]> }
  tool: {
    register(spec: { name: string; description: string; inputSchema?: Record<string, unknown> }): Promise<unknown>
    check(args: { tool: string; input: unknown }): Promise<{ decision: 'allow' | 'ask' | 'deny' }>
    call(args: { tool: string; consent?: string; [key: string]: unknown }): Promise<unknown>
  }
  command: { register(spec: { name: string; description?: string; argumentHint?: string }): Promise<unknown> }
  state: {
    get<K extends keyof PaneState>(ref: PaneRef<K>): Promise<{ value: PaneState[K] | undefined; version: number }>
    set<K extends keyof PaneState>(ref: PaneRef<K>, value: PaneState[K]): Promise<unknown>
  }
  ui: {
    status(text: string | undefined): void
    open(args: OpenArgs): Promise<unknown>
    resolve(e: PaneRenderEvent): Elements
    focus(args: { requestId: string; key: string }): Promise<{ deny?: string }>
    toast(text: string): void
  }
}

/** Which site the pane hooks match: the one pane this plugin opens. */
export interface PaneMatcher {
  component: 'Pane'
  requestId: string
}

/** A `ui.render` input for the pane, as far as the mod reads it. */
export interface PaneRenderEvent {
  /** Where the tree will be drawn: terminal, desktop, vscode or mobile. */
  surface?: string
  props: { bodyColumns?: number; scroll?: { bodyRows: number } }
  viewport?: { columns: number; rows: number }
  [key: string]: unknown
}

/** A `ui.press` input: the key of the Button pressed. */
export interface PressEvent {
  element: string
  /** Where the press came from: the surface whose drawing it pressed. */
  surface?: string
  [key: string]: unknown
}

/** A `ui.focus` input: the key of the element taking the ring, absent for one of the engine's stops. */
export interface FocusEvent {
  element?: string
  /** Where the ring moves: terminal, desktop, vscode or mobile. */
  surface?: string
  [key: string]: unknown
}

/** A `ui.input` input: an edit of, or Enter in, an Input the pane drew. */
export interface InputEvent {
  element: string
  kind: 'change' | 'submit'
  value: string
  [key: string]: unknown
}

/** A `session.compact` input, as far as the mod reads it. */
export interface CompactEvent {
  /** What is compacting; 'precompute' prepares a summary ahead of time and installs nothing. */
  trigger?: 'manual' | 'auto' | 'plugin' | 'precompute'
  agentId?: string
}

/** A `session.append` input: one row a loop of the session keeps. */
export interface AppendEvent {
  message: unknown
  door: string
  origin: { kind: string; name?: string; [key: string]: unknown }
  uuid: string
  agentId?: string
}

/** An `agent.spawn` input, as far as the mod reads it. */
export interface SpawnEvent {
  subagentType: string
  [key: string]: unknown
}

/** An `agent.spawn` result: the new loop's id, or the refusal. */
export interface SpawnResult {
  agentId?: string
  deny?: string
  [key: string]: unknown
}


/** A `command.run` input, as far as the mod reads it. */
export interface CommandEvent {
  command: string
  args: string
  /** Where the run came from: the person's Enter ('composer'), their remote client ('bridge'), a headless run ('sdk'), or something else. */
  origin?: { kind: string; [key: string]: unknown }
}

/** A `tool.call` input: the tool, the engine's own keys, and the tool's arguments beside them. */
export interface ToolCallEvent {
  tool: string
  tool_use_id?: string
  agentId?: string
  [key: string]: unknown
}

/** A `tool.call` result: answered, errored, or denied. */
export interface ToolCallOutcome {
  deny?: string
  isError?: boolean
  text?: string
  context?: readonly string[]
  [key: string]: unknown
}

/** A hook's `next`, which carries the dispatch's abort signal and who raised it (`plugin`: a `$` call's plugin, `engine` for the engine's own). */
export type Next<E, R> = ((e: E) => Promise<R>) & { signal?: AbortSignal; origin?: { plugin: string } }

/** The overloads of `on` this mod uses, typed structurally so CI can check them without the engine's types. */
export interface ModOn {
  (event: 'session.start', hook: ($: ModEngine, e: unknown, next: Next<unknown, unknown>) => Promise<unknown>): unknown
  (event: 'session.end', hook: ($: ModEngine, e: { sessionId: string }, next: Next<{ sessionId: string }, unknown>) => Promise<unknown>): unknown
  (event: 'session.compact', hook: ($: ModEngine, e: CompactEvent, next: Next<CompactEvent, { skip?: string }>) => Promise<unknown>): unknown
  (event: 'session.append', hook: ($: ModEngine, e: AppendEvent, next: Next<AppendEvent, unknown>) => Promise<unknown>): unknown
  (event: 'agent.spawn', hook: ($: ModEngine, e: SpawnEvent, next: Next<SpawnEvent, SpawnResult>) => Promise<unknown>): unknown
  (event: 'command.run', matcher: { command: string }, hook: ($: ModEngine, e: CommandEvent, next: Next<CommandEvent, unknown>) => Promise<{ text?: string; exitCode?: number }>): unknown
  (event: 'tool.call', matcher: { tool: RegExp }, hook: ($: ModEngine, e: ToolCallEvent, next: Next<ToolCallEvent, ToolCallOutcome>) => Promise<ToolCallOutcome>): unknown
  (event: 'ui.render', matcher: PaneMatcher, hook: ($: ModEngine, e: PaneRenderEvent, next: Next<PaneRenderEvent, unknown>) => Promise<unknown>): unknown
  (event: 'ui.press', matcher: PaneMatcher, hook: ($: ModEngine, e: PressEvent, next: Next<PressEvent, unknown>) => Promise<unknown>): unknown
  (event: 'ui.input', matcher: PaneMatcher, hook: ($: ModEngine, e: InputEvent, next: Next<InputEvent, unknown>) => Promise<unknown>): unknown
  (event: 'ui.focus', matcher: PaneMatcher, hook: ($: ModEngine, e: FocusEvent, next: Next<FocusEvent, unknown>) => Promise<unknown>): unknown
}
