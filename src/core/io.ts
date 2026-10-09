/** What a directory entry is. A symbolic link is `other` and is never followed. */
export type EntryKind = 'file' | 'dir' | 'other'

/** One directory entry. `size` and `mtimeMs` are a regular file's own and 0 for anything else. */
export interface Entry {
  name: string
  kind: EntryKind
  size: number
  mtimeMs: number
}

/**
 * A directory listing, or why there is none.
 *
 * `missing` separates a directory that is genuinely gone (`ENOENT`, `ENOTDIR`) from one
 * that exists but could not be read. The freshness walk may skip the first and must not
 * skip the second, or a change confined to an unreadable subtree would never move the
 * stamp.
 */
export type Listing = { ok: true; entries: Entry[] } | { ok: false; missing: boolean }

/** What a finished subprocess left behind. */
export interface RunResult {
  exitCode: number
  stdout: string
}

/** The only environment variables the core reads. A closed set, because the mod runtime reads each by literal name. */
export type EnvName = 'CASSANDRA_HOME' | 'CLAUDE_PLUGIN_DATA' | 'HOME'

/**
 * Everything the core needs from outside itself.
 *
 * The binary and the CLI run on Bun with `node:fs`; the mod runs inside Claude Code,
 * where there is no Node and every effect goes through the engine's `$`. The core is
 * written once against this interface, so the two front ends cannot drift apart.
 * Every method is async because `$` is.
 */
export interface Io {
  /** The file's text; null when it does not exist. Rejects when it exists but cannot be read. */
  readText(path: string): Promise<string | null>
  /** Replace a file's content atomically, creating parent directories. Rejects on failure. */
  writeText(path: string, text: string): Promise<void>
  /** Append to a file, creating it and its parent directories. Rejects on failure. */
  appendText(path: string, text: string): Promise<void>
  /** Remove a file. A missing file is not an error; any other failure may reject. */
  remove(path: string): Promise<void>
  /** List a directory, never following links. */
  list(dir: string): Promise<Listing>
  /** Whether anything exists at the path. */
  exists(path: string): Promise<boolean>
  /** Run a program by argv, no shell. Null when it could not start or did not finish. */
  run(argv: readonly string[], cwd: string): Promise<RunResult | null>
  /** Lowercase hex SHA-256 of the text's UTF-8 bytes. */
  sha256(text: string): Promise<string>
  /** One environment variable. */
  env(name: EnvName): Promise<string | undefined>
  /** The operating system's home directory, consulted only when `HOME` is unusable; '' when unknown. */
  homeDir(): Promise<string>
  /** The current time, ISO 8601. */
  now(): string
}
