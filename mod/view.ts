import type { PaneModel, PaneTab, PaneView } from '../src/core/pane.ts'
import type { PaneState } from './engine.ts'
import type { PaneExtras } from './layout.ts'
import { keyListRows } from './pane.tsx'

/**
 * The pane's values in `$.state`, one key at a time, each resolving to the stored value
 * (undefined when never set). The mod builds it (`storeOf` in install.ts) with one literal
 * reference per key, because `claude plugin validate` lists state only from those and
 * follows `$` only within that file.
 */
export interface PaneStore {
  get<K extends keyof PaneState>(key: K): Promise<PaneState[K] | undefined>
  set<K extends keyof PaneState>(key: K, value: PaneState[K]): Promise<unknown>
}

/** The tabs the list can show, in their order. */
export const TAB_IDS: readonly PaneTab[] = ['history', 'warnings', 'stale', 'denied']

/** What the pane remembers, read fresh; a value never set reads as a fresh pane's. Rejects when the state cannot be read. */
export async function readView(store: PaneStore): Promise<PaneView> {
  const tab = await store.get('tab')
  return {
    tab: tab !== undefined && TAB_IDS.includes(tab) ? tab : 'history',
    selected: (await store.get('selected')) ?? null,
    expanded: (await store.get('expanded')) ?? false,
    confirmAll: (await store.get('confirmAll')) ?? false,
    confirmRetest: (await store.get('confirmRetest')) ?? null,
    showFull: (await store.get('showFull')) ?? false,
    query: (await store.get('query')) ?? '',
    notice: (await store.get('notice')) ?? null,
    lastWarning: (await store.get('lastWarning')) ?? null,
  }
}

/** Whether the search field and the key list are open, and the full output's page, for a model. Rejects when the state cannot be read. */
export async function readExtras(store: PaneStore, model: PaneModel): Promise<PaneExtras> {
  return {
    searching: (await store.get('searching')) ?? false,
    showKeys: (await store.get('showKeys')) ?? false,
    keyRows: keyListRows(model).length,
    fullPage: (await store.get('fullPage')) ?? 0,
  }
}
