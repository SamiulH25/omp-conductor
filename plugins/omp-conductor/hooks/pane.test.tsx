import { test, expect } from 'claude-code/testing'

test('pane draws the empty state and the demo workers on every surface that has Box and Text', async ($, on) => {
  on('ui.open', async () => ({ value: { isPlaced: true as const } }))
  for (const surface of ['terminal', 'desktop'] as const) {
    const mount = () =>
      $.ui.mount({
        plugin: 'omp-conductor',
        surface,
        component: 'Pane',
        requestId: 'omp-conductor',
        props: { title: 'x', isFocused: false } as never,
        viewport: { columns: 80, rows: 40 } as never,
      })

    const empty = await mount()
    expect(await empty.find({ type: 'Text', text: /No workers yet/ })).toBeDefined()
    await empty.unmount()

    await $.command.run({ command: 'conductor', args: 'demo' } as never)
    const full = await mount()
    expect(await full.find({ type: 'Text', text: /conductor/ })).toBeDefined()
    expect(await full.find({ type: 'Text', text: /lighthouse story/ })).toBeDefined()
    expect(await full.find({ type: 'Text', text: /Appended a Usage section/ })).toBeDefined()
    await full.unmount()
    await $.command.run({ command: 'conductor', args: 'demo' } as never)
  }
})
