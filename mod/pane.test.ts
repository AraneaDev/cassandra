import { expect, test } from 'claude-code/testing'
import { PANE, SURFACES, failing, memoryHost, paneLines, rowKeys, sized, viewport } from './memory-host.kit.ts'


test('the pane refuses a plugin origin, draws the remembered failure, forgets it, and asks before forgetting everything', async ($, on) => {
  const host = memoryHost(on)
  on('tool.call', { tool: 'Bash' }, async () => ({ isError: true, result: 'Exit code 1', text: 'Exit code 1\nboom' }))
  await $.tool.call({ tool: 'Bash', command: 'false # cassandra pane' })

  // A run from here carries a plugin origin, which may not open the pane, bare or with the
  // args the old subcommands took; the person's own origins are covered by test/mod.spec.ts.
  // The test mounts the pane itself instead.
  host.opened.count = 0
  for (const args of [undefined, '', 'pane', 'list', 'forget --all']) {
    const r = await $.command.run({ command: 'cassandra', args })
    expect([r.text, r.exitCode]).toEqual(['The pane opens only from your own /cassandra command.', 1])
  }
  expect(host.opened.count).toBe(0)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface, viewport })
    const keys = (await ui.findAll({ type: 'Button' })).map((b) => b.key)
    expect(keys.filter((k) => /^row:[0-9a-f]{16}$/.test(String(k)))).toHaveLength(1)
    expect(keys).toContain('forget')
    expect(keys).toContain('forget-all')

    await ui.press({ key: 'forget-all' })
    expect((await ui.find({ key: 'forget-all-confirm' }))?.text).toBe('Forget all 1 record')
    await ui.press({ key: 'forget-all-cancel' })
    expect((await ui.find({ key: 'forget-all' }))?.key).toBe('forget-all')
    await ui.unmount()
  }

  // Forget acts on the selected record, and the pane redraws without it.
  const one = await $.ui.mount({ ...PANE, surface: 'terminal', viewport })
  await one.press({ key: 'forget' })
  expect(await actionKeys(one)).toEqual([])
  await one.unmount()

  // The confirm is the person's own gesture: it forgets everything, and the pane redraws empty.
  await $.tool.call({ tool: 'Bash', command: 'false # cassandra pane, once more' })
  await $.tool.call({ tool: 'Bash', command: 'false # cassandra pane, and again' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', viewport })
  expect((await ui.findAll({ type: 'Button' })).filter((b) => String(b.key).startsWith('row:'))).toHaveLength(2)
  await ui.press({ key: 'forget-all' })
  expect((await ui.find({ key: 'forget-all-confirm' }))?.text).toBe('Forget all 2 records')
  await ui.press({ key: 'forget-all-confirm' })
  expect(await actionKeys(ui)).toEqual([])
  expect((await ui.find({ type: 'Text', text: /Nothing remembered/ }))?.text.trim()).toBe('Nothing remembered in this project.')
  await ui.unmount()
})

/** The Buttons that act on records: the rows, Forget and Forget all, and the confirm. */
async function actionKeys(ui: { findAll(q: { type: string }): Promise<Array<{ key: string | undefined }>> }): Promise<string[]> {
  return (await ui.findAll({ type: 'Button' })).map((b) => String(b.key)).filter((k) => k.startsWith('row:') || k.startsWith('forget'))
}

test('at every size each drawn line is exactly the pane wide and the pane fits its rows, on both surfaces', async ($, on) => {
  memoryHost(on, { git: true })
  on('tool.call', { tool: 'Bash' }, async () => ({ isError: true, result: 'Exit code 1', text: 'Exit code 1\nboom' }))
  for (let i = 0; i < 12; i++) await $.tool.call({ tool: 'Bash', command: `false # case ${i} ${'x'.repeat(i * 9)}` })

  for (const surface of SURFACES) {
    for (const [columns, rows] of [[40, 15], [70, 30], [120, 50]] as const) {
      const ui = await $.ui.mount({ ...PANE, props: sized(columns, rows), surface, viewport })
      const lines = await paneLines(ui)
      expect(lines.length).toBeGreaterThan(4)
      expect(lines.length).toBeLessThanOrEqual(rows)
      // Every glyph drawn here takes one cell, so its length is its width.
      for (const l of lines) expect([...l].length).toBe(columns)
      expect(lines[0]).toContain('proj')
      // The tabs sit under the header, with a blank row between them on a tall pane.
      const tabs = lines[rows >= 22 ? 2 : 1]!
      if (columns === 40) {
        expect(lines[0]).not.toContain('main')
        expect(tabs).toContain(' History¹² ')
        expect(tabs).toContain(' 2')
        expect(tabs).not.toContain('Warnings')
      } else {
        expect(lines[0]).toContain('main')
        expect(tabs).toMatch(/History¹² +Warnings¹² +Stale⁰ +Denied⁰/)
      }
      if (columns === 120) expect(lines[0]).toContain('main · 0cc107b')
      expect(lines[0]).toContain('12 would warn')
      expect(lines.at(-1)).toContain('f: Forget  a: Forget all')
      await ui.unmount()
    }
  }
})

test('a pane three rows tall draws the one line asking for more room, on both surfaces', async ($, on) => {
  memoryHost(on)
  on('tool.call', { tool: 'Bash' }, async () => ({ isError: true, result: 'Exit code 1', text: 'Exit code 1\nboom' }))
  await $.tool.call({ tool: 'Bash', command: 'false # short pane' })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, props: sized(70, 3), surface, viewport })
    expect((await ui.findAll({ type: 'Text' })).map((t) => t.text)).toEqual(['Pane too short; make the window taller.'])
    expect(await ui.findAll({ type: 'Button' })).toEqual([])
    await ui.unmount()
  }
})

test('a warned call draws the Just warned card with the call; Dismiss and forgetting its record remove it', async ($, on) => {
  memoryHost(on)
  failing(on)
  await $.tool.call({ tool: 'Bash', command: 'false # warn me' })
  let ui = await $.ui.mount({ ...PANE, surface: 'terminal', viewport })
  expect((await paneLines(ui)).join('\n')).not.toContain('Just warned')
  await ui.unmount()

  // The same call again: Cassandra warns, and the pane shows what was run.
  await $.tool.call({ tool: 'Bash', command: 'false # warn me' })
  ui = await $.ui.mount({ ...PANE, surface: 'terminal', viewport })
  let lines = await paneLines(ui)
  expect(lines.some((l) => l.includes('Just warned'))).toBe(true)
  expect(lines.find((l) => l.includes('you ran'))).toContain('false # warn me')
  await ui.press({ key: 'dismiss' })
  expect((await paneLines(ui)).join('\n')).not.toContain('Just warned')
  await ui.unmount()

  // Warned again, then the record is forgotten: the card goes with it (Review Focus 5).
  await $.tool.call({ tool: 'Bash', command: 'false # warn me' })
  ui = await $.ui.mount({ ...PANE, surface: 'terminal', viewport })
  expect((await paneLines(ui)).join('\n')).toContain('Just warned')
  await ui.press({ key: 'forget' })
  lines = await paneLines(ui)
  expect(lines.join('\n')).not.toContain('Just warned')
  expect(await rowKeys(ui)).toEqual([])
  await ui.unmount()
})

test('the tab digits ride on hidden twins: 2 lists only the rows that would warn, 4 only the denials', async ($, on) => {
  memoryHost(on)
  failing(on)
  await $.tool.call({ tool: 'Bash', command: 'false # one' })
  await $.tool.call({ tool: 'Bash', command: 'echo denied' })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface, viewport })
    expect(await rowKeys(ui)).toHaveLength(2)
    expect((await ui.find({ key: 'tabkey:warnings' }))?.props.hotkey).toBe('2')
    await ui.press({ key: 'tabkey:warnings' })
    expect(await rowKeys(ui)).toHaveLength(1)
    let lines = await paneLines(ui)
    expect(lines.some((l) => l.includes('false # one'))).toBe(true)
    expect(lines.some((l) => l.includes('echo denied'))).toBe(false)
    await ui.press({ key: 'tabkey:denied' })
    lines = await paneLines(ui)
    expect(await rowKeys(ui)).toHaveLength(1)
    expect(lines.some((l) => l.includes('echo denied'))).toBe(true)
    // A press on the tab itself switches too.
    await ui.press({ key: 'tab:history' })
    expect(await rowKeys(ui)).toHaveLength(2)
    // Every line is still the pane's width: the twins draw nothing.
    for (const l of await paneLines(ui)) expect([...l].length).toBe(80)
    await ui.unmount()
  }
})

test('j moves the marker down and Enter on the marked row opens it in place; k moves it back', async ($, on) => {
  memoryHost(on)
  failing(on)
  await $.tool.call({ tool: 'Bash', command: 'false # older' })
  await $.tool.call({ tool: 'Bash', command: 'false # newer' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', viewport })
  const keys = await rowKeys(ui)
  expect(keys).toHaveLength(2)
  expect((await ui.find({ key: 'down' }))?.props.hotkey).toBe('j')
  await ui.press({ key: 'down' })
  // Enter presses the row under the ring, which j moved onto the marked row.
  await ui.press({ key: keys[1]! })
  let lines = await paneLines(ui)
  const at = lines.findIndex((l) => l.includes('false # older'))
  expect(lines[at + 1]).toContain('why it failed')
  expect(lines.some((l) => l.includes('false # newer') && l.includes('▸'))).toBe(true)
  // Enter again closes it.
  await ui.press({ key: keys[1]! })
  expect((await paneLines(ui)).join('\n')).not.toContain('why it failed')
  await ui.press({ key: 'up' })
  await ui.press({ key: keys[0]! })
  lines = await paneLines(ui)
  expect(lines[lines.findIndex((l) => l.includes('false # newer')) + 1]).toContain('why it failed')
  await ui.unmount()
})

test('an expanded row with a fix note shows the fix line', async ($, on) => {
  memoryHost(on, { git: true })
  let calls = 0
  // Fails, then passes (a fix note is kept and the record forgotten), then fails again.
  on('tool.call', { tool: 'Bash' }, async () => (++calls === 2 ? { result: 'ok' } : { isError: true, result: 'Exit code 1', text: 'Exit code 1\nboom' }))
  for (let i = 0; i < 3; i++) await $.tool.call({ tool: 'Bash', command: 'bun test # fixed once' })
  const ui = await $.ui.mount({ ...PANE, props: sized(120, 50), surface: 'terminal', viewport })
  const [key] = await rowKeys(ui)
  await ui.press({ key: key! })
  const lines = await paneLines(ui)
  expect(lines.some((l) => /^\s+fix\s+\S/.test(l))).toBe(true)
  await ui.unmount()
})

test('s opens the search; Enter applies it, x clears it; Forget all still forgets every counted record', async ($, on) => {
  memoryHost(on)
  failing(on)
  for (const c of ['bun test # a', 'bun run lint # b', 'npm test # c']) await $.tool.call({ tool: 'Bash', command: c })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', viewport })
  expect(await rowKeys(ui)).toHaveLength(3)
  expect(await ui.find({ key: 'search-field' })).toBeUndefined()
  await ui.press({ key: 'search' })
  expect((await ui.find({ key: 'search-field' }))?.type).toBe('Input')
  // Typing alone applies nothing; Enter does.
  await ui.input({ key: 'search-field', text: 'bun', kind: 'change' })
  expect(await rowKeys(ui)).toHaveLength(3)
  await ui.input({ key: 'search-field', text: 'bun' })
  expect(await ui.find({ key: 'search-field' })).toBeUndefined()
  expect(await rowKeys(ui)).toHaveLength(2)
  expect((await paneLines(ui)).join('\n')).not.toContain('npm test')
  expect((await ui.find({ key: 'search-clear' }))?.props.hotkey).toBe('x')
  await ui.press({ key: 'search-clear' })
  expect(await rowKeys(ui)).toHaveLength(3)
  expect(await ui.find({ key: 'search-clear' })).toBeUndefined()

  // With the filter on, the confirm counts and forgets every record, not only those shown.
  await ui.press({ key: 'search' })
  await ui.input({ key: 'search-field', text: 'npm' })
  expect(await rowKeys(ui)).toHaveLength(1)
  await ui.press({ key: 'forget-all' })
  expect((await ui.find({ key: 'forget-all-confirm' }))?.text).toBe('Forget all 3 records')
  await ui.press({ key: 'forget-all-confirm' })
  expect(await rowKeys(ui)).toEqual([])
  await ui.unmount()
  const after = await $.ui.mount({ ...PANE, surface: 'terminal', viewport })
  await after.press({ key: 'search-clear' }).catch(() => undefined)
  expect((await after.find({ type: 'Text', text: /Nothing remembered/ }))?.text.trim()).toBe('Nothing remembered in this project.')
  await after.unmount()
})

test('h opens the key list, rates first, within the pane; h again closes it', async ($, on) => {
  memoryHost(on)
  failing(on)
  for (let i = 0; i < 6; i++) await $.tool.call({ tool: 'Bash', command: `false # keys ${i}` })
  for (const [columns, rows] of [[80, 30], [40, 15]] as const) {
    const ui = await $.ui.mount({ ...PANE, props: sized(columns, rows), surface: 'terminal', viewport })
    // Where the bar has no room for Keys, its hotkey rides on a hidden twin.
    const help = columns === 40 ? 'twin:help' : 'help'
    expect((await ui.find({ key: help }))?.props.hotkey).toBe('h')
    await ui.press({ key: help })
    const lines = await paneLines(ui)
    expect(lines.length).toBeLessThanOrEqual(rows)
    for (const l of lines) expect([...l].length).toBe(columns)
    const title = lines.findIndex((l) => l.includes('Keys'))
    expect(title).toBeGreaterThan(0)
    // A blank row under the title, then the rates.
    expect(lines[title + 1]!.trim()).toBe('')
    expect(lines[title + 2]).toContain('No warning raised yet, so no rates.')
    expect(await rowKeys(ui)).not.toHaveLength(0)
    await ui.press({ key: help })
    expect((await paneLines(ui)).join('\n')).not.toContain('No warning raised yet')
    await ui.unmount()
  }
})

test('n and p page through the full output, its note counting the lines shown, and o closed and reopened starts it from the first page', async ($, on) => {
  memoryHost(on)
  const output = Array.from({ length: 70 }, (_, i) => `line ${i + 1}`).join('\n')
  on('tool.call', { tool: 'Bash' }, async () => ({ isError: true, result: 'Exit code 1', text: `Exit code 1\n${output}` }))
  await $.tool.call({ tool: 'Bash', command: 'bun test # paged output' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', viewport })
  await ui.press({ key: 'full' })
  const note = async (): Promise<[number, number, number]> => {
    const lines = await paneLines(ui)
    for (const l of lines) expect([...l].length).toBe(lines[0]!.length)
    const m = lines.map((l) => /lines (\d+)–(\d+) of (\d+)/.exec(l)).find((x) => x !== null)
    expect(m).toBeDefined()
    return [Number(m![1]), Number(m![2]), Number(m![3])]
  }
  const [from, to, total] = await note()
  expect([from, total]).toEqual([1, 71])
  expect(await ui.find({ key: 'prev-page' })).toBeFalsy()
  expect((await ui.find({ key: 'next-page' }))?.props.hotkey).toBe('n')

  await ui.press({ key: 'next-page' })
  expect(await note()).toEqual([to + 1, 2 * to, 71])
  expect((await paneLines(ui)).some((l) => l.trim() === `line ${to}`)).toBe(true)
  expect((await ui.find({ key: 'prev-page' }))?.props.hotkey).toBe('p')

  await ui.press({ key: 'prev-page' })
  expect(await note()).toEqual([1, to, 71])

  // Closed and opened again, the output starts from its first page. While n and p show, o
  // may have only its hidden twin left in the bar.
  const pressKey = async (key: string) => ui.press({ key: (await ui.find({ key })) ? key : `twin:${key}` })
  await ui.press({ key: 'next-page' })
  await pressKey('full')
  await pressKey('full')
  expect(await note()).toEqual([1, to, 71])
  await ui.unmount()
})
