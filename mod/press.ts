import { forget } from '../src/commands/forget.ts'
import type { CommandResult } from '../src/commands/run.ts'
import type { Io } from '../src/core/io.ts'
import { paneModel, type PaneTab } from '../src/core/pane.ts'
import { isFingerprint, pathsFor } from '../src/core/paths.ts'
import { listRecords, readRecord } from '../src/core/record.ts'
import { markedRow, steppedRow, turnedPage, type DrawnBySurface, type DrawnPane } from './drawn.ts'
import type { InputEvent, PressEvent } from './engine.ts'
import {
  KEY_CANCEL, KEY_CONFIRM, KEY_DISMISS, KEY_DOWN, KEY_FORGET, KEY_FORGET_ALL, KEY_FULL, KEY_HELP, KEY_NEXT_PAGE, KEY_PREV_PAGE, KEY_RETEST, KEY_RETEST_CANCEL, KEY_RETEST_CONFIRM, KEY_SEARCH,
  KEY_SEARCH_CLEAR, KEY_SEARCH_FIELD, KEY_TABKEY_PREFIX, KEY_TAB_PREFIX, KEY_TWIN_PREFIX, KEY_UP, ROW_KEY_PREFIX,
} from './pane.tsx'
import { TAB_IDS, pageFor, readView, type PaneStore } from './view.ts'

/**
 * What the pane's presses, inputs and focus moves act through, built by the mod
 * (`paneHostOf` in install.ts) for the same reason as `RetestHost`: the validator follows
 * `$` only into a function declared in that file.
 */
export interface PaneHost {
  store: PaneStore
  /** An io over the session's own host. Throws when there is none. */
  io(): Io
  cwd(): Promise<string>
  sessionId(): Promise<string>
  /** Draw an open pane again. Never rejects. */
  redraw(): Promise<void>
  /** Re-read the live count, pin it under the prompt, and redraw. Never rejects. */
  refresh(io: Io): Promise<void>
  /** Run the retest the person confirmed, then show what it came to and redraw. Never rejects. */
  retest(io: Io, hash: string, shown: string): Promise<void>
}

/** What a press leaves to do once it is done: where the focus ring goes, and a retest to run. */
interface Pressed {
  /** The element the ring moves to (the row `j`/`k` marked, the search field `s` opened), or null. */
  ring: string | null
  /** The confirmed retest, run after the press so it holds up no other press while the call runs. */
  retest?: () => Promise<void>
}

/**
 * The record a row key names, by its full hash, when it is a row still remembered; null
 * otherwise. Never a prefix lookup: two records may share the id a row displays.
 */
async function rowHash(host: PaneHost, io: Io, key: string): Promise<string | null> {
  const hash = key.slice(ROW_KEY_PREFIX.length)
  if (!isFingerprint(hash)) return null
  return (await readRecord(io, await pathsFor(io, await host.cwd()), hash)) === null ? null : hash
}

/**
 * Select the row a key names, when it is a row still remembered; another row than the one
 * selected starts the full output from its first page. Never throws.
 */
export async function selectRow(host: PaneHost, key: string | undefined): Promise<void> {
  if (!key?.startsWith(ROW_KEY_PREFIX)) return
  try {
    const hash = await rowHash(host, host.io(), key)
    if (hash === null) return
    if (hash !== ((await host.store.get('selected')) ?? null)) await firstPage(host.store)
    await host.store.set('selected', hash)
  } catch {
    // The selection stays where it was.
  }
}

/**
 * Enter on a row, or a click: the marked row opens or closes in place; another row is
 * marked instead (the focus hook has usually marked it already). Either way the full output
 * starts from its first page. Rejects on a state failure.
 */
async function pressRow(host: PaneHost, io: Io, key: string, drawn: DrawnPane | undefined): Promise<void> {
  const { store } = host
  const hash = await rowHash(host, io, key)
  if (hash === null) return
  await firstPage(store)
  if (drawn && hash === markedRow(drawn, (await store.get('selected')) ?? null)) {
    await store.set('selected', hash)
    await store.set('expanded', !((await store.get('expanded')) ?? false))
    return
  }
  await store.set('selected', hash)
}

/**
 * `j` or `k`: mark the next or previous row of the list this surface drew, stopping at
 * either end. It moves from the selection wherever it is in that list, not only inside the
 * window shown, so a held key walks past the window's edge. A retest waiting for its
 * confirm is dropped: the confirm showed the old row's call. Resolves to the key of the row
 * now marked, for the ring to follow; null when nothing moved. Rejects on a state failure.
 */
async function moveMarker(store: PaneStore, drawn: DrawnPane | undefined, by: 1 | -1): Promise<string | null> {
  if (!drawn || drawn.rows.length === 0) return null
  const to = steppedRow(drawn, (await store.get('selected')) ?? null, by)
  await store.set('selected', to)
  await store.set('showFull', false)
  await firstPage(store)
  await store.set('confirmRetest', null)
  return `${ROW_KEY_PREFIX}${to}`
}

/**
 * Switch the list to `tab`: the marked row stays marked when the new tab lists it, else the
 * tab's first row is marked, closed. A waiting retest is dropped, and the full output starts
 * from its first page. Rejects on a host failure.
 */
async function switchTab(host: PaneHost, io: Io, cwd: string, tab: PaneTab): Promise<void> {
  const { store } = host
  const view = await readView(store)
  const model = await paneModel(io, cwd, { ...view, tab }, await host.sessionId())
  await store.set('tab', tab)
  await store.set('confirmRetest', null)
  await firstPage(store)
  if (model.selected === view.selected) return
  await store.set('selected', model.selected)
  await store.set('expanded', false)
  await store.set('showFull', false)
}

/**
 * `n` or `p`: show the next or previous page of the full output this surface drew, stopping
 * at its first and last page. The page is kept for the record drawn, so another record
 * shows its first. Nothing drawn here, or no full output drawn, turns nothing. Rejects on
 * a state failure.
 */
async function turnPage(store: PaneStore, drawn: DrawnPane | undefined, by: 1 | -1): Promise<void> {
  if (!drawn || drawn.fullPages === 0) return
  await store.set('fullPage', turnedPage(drawn, await pageFor(store, drawn.selected), by))
  await store.set('fullPageOf', drawn.selected)
}

/** Start the full output from its first page, on whichever record shows it next. Rejects on a state failure. */
async function firstPage(store: PaneStore): Promise<void> {
  await store.set('fullPage', 0)
  await store.set('fullPageOf', null)
}

/** The tab a tab's Button or its hidden twin names; null for any other key. */
function tabOf(key: string): PaneTab | null {
  const id = key.startsWith(KEY_TAB_PREFIX) ? key.slice(KEY_TAB_PREFIX.length) : key.startsWith(KEY_TABKEY_PREFIX) ? key.slice(KEY_TABKEY_PREFIX.length) : null
  return TAB_IDS.find((t) => t === id) ?? null
}

/** What a search field's text is kept as: one line, trimmed. */
const searchText = (value: string): string => value.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim()

/** Run one forget for the pane: its failure becomes the notice, and any change redraws. Never throws. */
async function paneForget(host: PaneHost, io: Io, run: () => Promise<CommandResult | null>, failure: string): Promise<void> {
  let notice: string | null
  try {
    const r = await run()
    if (r === null) {
      // Nothing seen to act on: redraw, so the person sees the store as it is now,
      // without the outcome of an older action beside it.
      await host.store.set('notice', null).catch(() => undefined)
      await host.redraw()
      return
    }
    notice = r.code === 0 ? null : r.text
  } catch {
    notice = failure
  }
  try {
    await host.store.set('notice', notice)
  } catch {
    // The pane shows the outcome at its next redraw, or not at all.
  }
  await host.refresh(io)
}

/**
 * The record Forget acts on: a row this surface drew. The row focus selected, when it was
 * drawn here (the ring sits on it even before the redraw), else the row drawn as
 * selected. Null when nothing was drawn here or that record is gone.
 */
async function forgetTarget(store: PaneStore, io: Io, cwd: string, drawn: DrawnPane | undefined): Promise<string | null> {
  if (!drawn) return null
  const target = markedRow(drawn, (await store.get('selected')) ?? null)
  if (target === null) return null
  const stored = await listRecords(io, await pathsFor(io, cwd))
  return stored.some((r) => r.hash === target) ? target : null
}

/** The notice of a confirm that could not forget every record. */
const FORGET_ALL_FAILED = 'Could not forget every record.'

/**
 * Forget exactly the records this surface counted on its confirm button, and no others.
 * A newer record stays and is named in the notice; a counted record already gone is
 * skipped. Nothing drawn here, or nothing counted left, deletes nothing: the confirmation
 * drops and the pane redraws. A store that cannot be counted deletes nothing either, and
 * says so. Rejects on a state failure.
 */
async function confirmForgetAll(host: PaneHost, io: Io, cwd: string, drawn: DrawnPane | undefined): Promise<void> {
  const { store } = host
  let stored: string[]
  try {
    stored = (await listRecords(io, await pathsFor(io, cwd))).map((r) => r.hash)
  } catch {
    await store.set('notice', FORGET_ALL_FAILED)
    await host.redraw()
    return
  }
  const targets = stored.filter((h) => drawn?.counted.has(h))
  if (stored.length === 0 || targets.length === 0) {
    // Nothing counted is left to confirm: drop the row and redraw the store as it is.
    await store.set('confirmAll', false)
    await store.set('notice', null)
    await host.redraw()
    return
  }
  const kept = stored.length - targets.length
  await store.set('confirmAll', false)
  let failed = false
  const paths = await pathsFor(io, cwd)
  for (const hash of targets) {
    try {
      if ((await forget(io, paths, hash, false)).code !== 0) failed = true
    } catch {
      failed = true
    }
  }
  // A delete that fails quietly leaves the record behind: count it as a failure.
  try {
    const left = new Set((await listRecords(io, paths)).map((r) => r.hash))
    if (targets.some((h) => left.has(h))) failed = true
  } catch {
    failed = true
  }
  const n = targets.length
  const notice = failed
    ? FORGET_ALL_FAILED
    : kept === 0 ? null : `Forgot ${n} ${n === 1 ? 'record' : 'records'}; ${kept} newer ${kept === 1 ? 'record was' : 'records were'} kept.`
  await store.set('notice', notice).catch(() => undefined)
  await host.refresh(io)
}

/**
 * Run: the retest this surface drew whole, and only that one. Anything else (no confirm
 * waiting, or one this surface could not show whole) drops the confirm and runs nothing.
 * Resolves to the run, for after the press. Rejects on a state failure.
 */
async function confirmRetest(host: PaneHost, io: Io, drawn: DrawnPane | undefined): Promise<Pressed> {
  const { store } = host
  const hash = (await store.get('confirmRetest')) ?? null
  await store.set('confirmRetest', null)
  await store.set('notice', null)
  if (hash === null || drawn?.confirming !== hash || drawn.shown === null) return { ring: null }
  const shown = drawn.shown
  return { ring: null, retest: () => host.retest(io, hash, shown) }
}

/**
 * Act on a press in the pane, by the key of the Button pressed. Resolves to what is left to
 * do once the press is done (see Pressed). Never throws.
 */
export async function onPanePress(host: PaneHost, e: PressEvent, drawn: DrawnBySurface): Promise<Pressed> {
  const done = { ring: null }
  const { store } = host
  try {
    const io = host.io()
    const cwd = await host.cwd()
    const here = drawn.get(e.surface ?? '')
    // A bar key's hidden twin acts as the key itself.
    const element = e.element.startsWith(KEY_TWIN_PREFIX) ? e.element.slice(KEY_TWIN_PREFIX.length) : e.element
    const tab = tabOf(element)
    if (tab !== null) {
      await switchTab(host, io, cwd, tab)
      return done
    }
    switch (element) {
      case KEY_FORGET:
        await paneForget(host, io, async () => {
          const target = await forgetTarget(store, io, cwd, here)
          return target === null ? null : forget(io, await pathsFor(io, cwd), target, false)
        }, 'Could not forget the selected record.')
        return done
      // An old failure line must not sit beside the confirm row, nor outlive the cancel.
      case KEY_FORGET_ALL:
        await store.set('notice', null)
        // Nothing to confirm on an empty store.
        if ((await listRecords(io, await pathsFor(io, cwd))).length > 0) await store.set('confirmAll', true)
        return done
      case KEY_CANCEL:
        await store.set('notice', null)
        await store.set('confirmAll', false)
        return done
      case KEY_CONFIRM:
        await confirmForgetAll(host, io, cwd, here)
        return done
      case KEY_DOWN:
        return { ring: await moveMarker(store, here, 1) }
      case KEY_UP:
        return { ring: await moveMarker(store, here, -1) }
      // The full output shows in the open detail, so opening it opens the row too.
      case KEY_FULL: {
        const full = !((await store.get('showFull')) ?? false)
        await store.set('showFull', full)
        await firstPage(store)
        if (full) await store.set('expanded', true)
        return done
      }
      case KEY_NEXT_PAGE:
        await turnPage(store, here, 1)
        return done
      case KEY_PREV_PAGE:
        await turnPage(store, here, -1)
        return done
      case KEY_HELP:
        await store.set('showKeys', !((await store.get('showKeys')) ?? false))
        return done
      case KEY_DISMISS:
        await store.set('lastWarning', null)
        return done
      case KEY_SEARCH:
        await store.set('searching', true)
        return { ring: KEY_SEARCH_FIELD }
      case KEY_SEARCH_CLEAR:
        await store.set('query', '')
        await store.set('searching', false)
        return done
      // Marks the retest as waiting for its confirm, which shows the whole call.
      case KEY_RETEST:
        if (here?.retestable) {
          await store.set('notice', null)
          await store.set('confirmRetest', here.retestable)
        }
        return done
      case KEY_RETEST_CANCEL:
        await store.set('notice', null)
        await store.set('confirmRetest', null)
        return done
      case KEY_RETEST_CONFIRM:
        return await confirmRetest(host, io, here)
      default:
        if (element.startsWith(ROW_KEY_PREFIX)) await pressRow(host, io, element, here).catch(() => undefined)
        return done
    }
  } catch {
    // The press changes nothing.
    return done
  }
}

/** Enter in the search field: apply what it holds (empty clears) and close it. Never throws. */
export async function onPaneInput(store: PaneStore, e: InputEvent): Promise<void> {
  if (e.element !== KEY_SEARCH_FIELD || e.kind !== 'submit') return
  try {
    await store.set('query', searchText(e.value))
    await store.set('searching', false)
  } catch {
    // The search stays as it was.
  }
}
