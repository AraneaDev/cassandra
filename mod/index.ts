import type { Register } from 'claude-code'
import { install, type ModOn } from './install.ts'

/**
 * The engine's entry point. This is the only file that sees the engine's own types; the
 * hooks themselves are typed structurally in `install.ts` so CI can check and run them.
 * `claude plugin validate` and `tsc -p mod` (where the engine has laid its types) check
 * that the real `on` and `$` fit.
 */
export const register: Register = (on) => {
  install(on as unknown as ModOn)
}
