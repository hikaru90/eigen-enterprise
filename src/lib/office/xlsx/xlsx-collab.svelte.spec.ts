import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { userEvent } from 'vitest/browser'
import { cellKey } from './ref'
import { budgetBook } from './test-utils/build-xlsx'
import { createLiveApiHarness } from './test-utils/live-api'
import XlsxEditor from './xlsx-editor.svelte'

const BOOK = budgetBook()
const state = vi.hoisted(() => ({ harness: null as ReturnType<typeof createLiveApiHarness> | null }))

vi.mock('$lib/drive/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('$lib/drive/api')>()
  return {
    ...real,
    driveApi: {
      ...real.driveApi,
      readBytes: (...a: [string]) => state.harness!.api.readBytes(...a),
      sheetLiveJoin: (...a: [string]) => state.harness!.api.sheetLiveJoin(...a),
      sheetLiveSubmit: (...a: [string, never]) => state.harness!.api.sheetLiveSubmit(...a),
      sheetLiveEntries: (...a: [string, number]) => state.harness!.api.sheetLiveEntries(...a),
      sheetLivePresence: (...a: [string, never]) => state.harness!.api.sheetLivePresence(...a),
      sheetLiveStream: (...a: [string, string, number]) => state.harness!.api.sheetLiveStream(...a),
    },
  }
})

const mountTarget = () => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  return host
}

const cellIn = (root: HTMLElement, ref: string) =>
  root.querySelector(`[data-testid="xlsx-grid"] [data-ref="${ref}"]`) as HTMLElement | null
const shownIn = (root: HTMLElement, ref: string) => cellIn(root, ref)?.textContent?.trim() ?? null

async function typeIn(root: HTMLElement, ref: string, text: string) {
  await expect.poll(() => cellIn(root, ref)).not.toBeNull()
  await userEvent.click(cellIn(root, ref)!)
  await userEvent.keyboard(text)
  await userEvent.keyboard('{Enter}')
}

describe('xlsx editor: real-time co-editing', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    state.harness?.reset(BOOK)
    state.harness ??= createLiveApiHarness(BOOK)
  })

  it('converges two concurrent editor instances across row inserts and shows coloured peer cursors', async () => {
    const targetA = mountTarget()
    const targetB = mountTarget()
    render(XlsxEditor, {
      target: targetA,
      props: { fileId: 'shared:alice', name: 'Budget.xlsx', canEdit: true, heartbeatMs: 600_000 },
    })
    render(XlsxEditor, {
      target: targetB,
      props: { fileId: 'shared:bob', name: 'Budget.xlsx', canEdit: true, heartbeatMs: 600_000 },
    })

    await expect.poll(() => shownIn(targetA, 'B4')).toBe('1500')
    await expect.poll(() => shownIn(targetB, 'B4')).toBe('1500')

    // Peer presence chips appear on both instances.
    await expect.poll(() => targetA.querySelector('[data-testid="xlsx-peers"]')?.textContent).toContain('Bob')
    await expect.poll(() => targetB.querySelector('[data-testid="xlsx-peers"]')?.textContent).toContain('Alice')

    // Alice selects B3 -> Bob renders a coloured peer cursor with Alice's name; switching sheets hides it.
    await userEvent.click(cellIn(targetA, 'B3')!)
    await expect.poll(() => targetB.querySelector('[data-testid="xlsx-peer-cursor"]')?.textContent).toBe('Alice')
    const bobSummaryTab = [...targetB.querySelectorAll('[data-testid="xlsx-tab"]')].find((el) =>
      el.textContent?.includes('Summary'),
    ) as HTMLElement
    await userEvent.click(bobSummaryTab)
    await expect.poll(() => targetB.querySelector('[data-testid="xlsx-peer-cursor"]')).toBeNull()
    const bobBudgetTab = [...targetB.querySelectorAll('[data-testid="xlsx-tab"]')].find((el) =>
      el.textContent?.includes('Budget'),
    ) as HTMLElement
    await userEvent.click(bobBudgetTab)
    await expect.poll(() => targetB.querySelector('[data-testid="xlsx-peer-cursor"]')?.textContent).toBe('Alice')

    // Go offline briefly so Alice inserts a row above A2 while Bob concurrently writes old B3 -> reconnect & converge.
    state.harness!.setOffline(true)
    await userEvent.click(cellIn(targetA, 'A2')!)
    await (targetA.querySelector('[data-testid="xlsx-insert-row-above"]') as HTMLButtonElement).click()
    await typeIn(targetB, 'B3', '777')

    await expect.poll(() => targetA.querySelector('[data-testid="xlsx-save-state"]')?.textContent).toContain('Offline')
    await expect.poll(() => targetB.querySelector('[data-testid="xlsx-save-state"]')?.textContent).toContain('Offline')

    // Reconnecting delivers open/resync automatically and converges both editors cleanly.
    state.harness!.setOffline(false)

    // Alice's row insert shifts Bob's write from B3 to B4 and SUM(B2:B3) -> SUM(B3:B4); both converge to 1977 in B5!
    await expect.poll(() => shownIn(targetA, 'B4')).toBe('777')
    await expect.poll(() => shownIn(targetB, 'B4')).toBe('777')
    await expect.poll(() => shownIn(targetA, 'B5')).toBe('1977')
    await expect.poll(() => shownIn(targetB, 'B5')).toBe('1977')

    const wb = await state.harness!.savedBook()
    expect(wb.sheet('Budget').cells.get(cellKey(3, 1))?.value).toBe(777)
    expect(wb.sheet('Budget').cells.get(cellKey(4, 1))?.value).toBe(1977)
  })

  it('queues edits while offline and resends them when clicking Retry', async () => {
    const host = mountTarget()
    render(XlsxEditor, {
      target: host,
      props: { fileId: 'shared:alice', name: 'Budget.xlsx', canEdit: true, heartbeatMs: 600_000 },
    })
    await expect.poll(() => shownIn(host, 'B4')).toBe('1500')

    state.harness!.setOffline(true)
    await typeIn(host, 'B2', '2000')
    await expect.poll(() => host.querySelector('[data-testid="xlsx-save-state"]')?.textContent).toContain('Offline — 1 pending')
    const retryBtn = host.querySelector('[data-testid="xlsx-retry"]') as HTMLButtonElement | null
    expect(retryBtn).not.toBeNull()

    state.harness!.setOffline(false, false)
    retryBtn!.click()
    await expect.poll(() => state.harness!.headSeq()).toBe(1)
    await expect.poll(() => host.querySelector('[data-testid="xlsx-save-state"]')?.textContent).toContain('Saved')
    expect((await state.harness!.savedBook()).sheet('Budget').cells.get(cellKey(1, 1))?.value).toBe(2000)
  })

  it('delivers live updates to a viewer in read-only mode without granting edit controls', async () => {
    const editorHost = mountTarget()
    const viewerHost = mountTarget()
    const submitSpy = vi.spyOn(state.harness!.api, 'sheetLiveSubmit')

    render(XlsxEditor, {
      target: editorHost,
      props: { fileId: 'shared:alice', name: 'Budget.xlsx', canEdit: true, heartbeatMs: 600_000 },
    })
    render(XlsxEditor, {
      target: viewerHost,
      props: { fileId: 'shared:viewer', name: 'Budget.xlsx', canEdit: false, heartbeatMs: 600_000 },
    })

    await expect.poll(() => shownIn(editorHost, 'B4')).toBe('1500')
    await expect.poll(() => shownIn(viewerHost, 'B4')).toBe('1500')
    expect(viewerHost.querySelector('[data-testid="xlsx-toolbar"]')).toBeNull()
    expect(viewerHost.querySelector('[data-testid="xlsx-view-only"]')?.textContent).toContain('View only')

    // Editor modifies B3 -> viewer receives live op and recalculated total immediately.
    await typeIn(editorHost, 'B3', '888')
    await expect.poll(() => shownIn(viewerHost, 'B3')).toBe('888')
    await expect.poll(() => shownIn(viewerHost, 'B4')).toBe('2088')

    // Viewer cannot mutate the workbook.
    await userEvent.click(cellIn(viewerHost, 'B2')!)
    await userEvent.keyboard('12345')
    expect(viewerHost.querySelector('[data-testid="xlsx-cell-editor"]')).toBeNull()
    expect(submitSpy).toHaveBeenCalledTimes(1)
  })
})
