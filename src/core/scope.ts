// src/core/scope.ts
import type { Io } from './io.ts'
import { dirname, normalize } from './path.ts'
import { findRepoRoot } from './paths.ts'

/** Files that make a directory a package root. A fixed list: regular files only. */
export const MANIFESTS: ReadonlySet<string> = new Set([
  'package.json', 'Cargo.toml', 'go.mod', 'pyproject.toml', 'composer.json', 'Gemfile',
  'pom.xml', 'build.gradle', 'build.gradle.kts', 'mix.exs', 'deno.json', 'deno.jsonc',
])

/** How far up the walk goes before it gives up. */
const MAX_STEPS = 32

/**
 * The package a call ran in, as a path relative to the repo root: the nearest directory
 * between `cwd` and the root that holds a manifest. '' for the root itself, for a
 * directory with no manifest below the root, outside git (where `cwd` is its own root),
 * and on any error. '' is today's identity, so a miss only loses a distinction.
 *
 * The root is checked before anything is listed, so a call at the repo root, the common
 * case, costs no listing at all.
 */
export async function packageScope(io: Io, cwd: string): Promise<string> {
  try {
    const root = await findRepoRoot(io, cwd)
    const prefix = root.endsWith('/') ? root : `${root}/`
    let dir = normalize(cwd)
    if (dir !== root && !dir.startsWith(prefix)) return ''
    for (let step = 0; step < MAX_STEPS; step += 1) {
      if (dir === root) return ''
      const listing = await io.list(dir)
      if (!listing.ok) return ''
      if (listing.entries.some((e) => e.kind === 'file' && MANIFESTS.has(e.name))) return dir.slice(prefix.length)
      const parent = dirname(dir)
      if (parent === dir) return ''
      dir = parent
    }
    return ''
  } catch {
    return ''
  }
}
