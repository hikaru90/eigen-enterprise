import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page, userEvent } from 'vitest/browser'
import { cellKey } from './ref'
import { budgetBook } from './test-utils/build-xlsx'
import { createLiveApiHarness } from './test-utils/live-api'
import XlsxEditor from './xlsx-editor.svelte'

/** The spreadsheet editor's cell formatting and sizing, end to end in the grid: format bar, shortcuts, drag handles. */

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

const props = {
  fileId: 'book-1:alice',
  name: 'Budget.xlsx',
  canEdit: true,
  heartbeatMs: 600_000,
  saveDelayMs: 20,
  idleMs: 600_000,
}

const savedBook = () => state.harness!.savedBook()
const savedStyle = async (r: number, c: number) => {
  const wb = await savedBook()
  return wb.styles().xf(wb.sheet('Budget').cells.get(cellKey(r, c))?.style ?? 0)
}
const cell = (ref: string) =>
  document.querySelector(`[data-testid="xlsx-grid"] [data-ref="${ref}"]`) as HTMLElement | null

async function click(ref: string, opts?: { shiftKey?: boolean }) {
  await expect.poll(() => cell(ref)).not.toBeNull()
  if (opts?.shiftKey) {
    await userEvent.keyboard('{Shift>}')
    await userEvent.click(cell(ref)!)
    await userEvent.keyboard('{/Shift}')
  } else await userEvent.click(cell(ref)!)
}

describe('xlsx editor: cell format and sizes', () => {
  beforeEach(() => {
    state.harness?.reset(BOOK)
    state.harness ??= createLiveApiHarness(BOOK)
  })

  it('Ctrl+B bolds the selection, the bar shows it pressed, and the save has it', async () => {
    render(XlsxEditor, props)
    await click('A2')
    await click('B3', { shiftKey: true })
    await expect
      .element(page.getByRole('button', { name: 'Bold' }))
      .toHaveAttribute('aria-pressed', 'false')
    await userEvent.keyboard('{Control>}b{/Control}')
    await expect.poll(() => cell('B3')!.style.fontWeight).toBe('600')
    await expect
      .element(page.getByRole('button', { name: 'Bold' }))
      .toHaveAttribute('aria-pressed', 'true')
    await expect.poll(() => state.harness!.savedCount()).toBe(1)
    expect((await savedStyle(1, 0)).font.bold).toBe(true)
    expect((await savedStyle(2, 1)).font.bold).toBe(true)
    // B2 kept its yellow fill.
    expect(await savedStyle(1, 1)).toMatchObject({ fill: '#FFFF00', font: { bold: true } })
    await userEvent.keyboard('{Control>}i{/Control}')
    await expect.poll(() => cell('A2')!.style.fontStyle).toBe('italic')
    await userEvent.keyboard('{Control>}z{/Control}')
    await expect.poll(() => cell('A2')!.style.fontStyle).toBe('')
  })

  it('the bar aligns, wraps and borders the selection; the grid draws it', async () => {
    render(XlsxEditor, props)
    await click('A2')
    await userEvent.click(page.getByRole('button', { name: 'Center' }))
    await expect.poll(() => cell('A2')!.style.textAlign).toBe('center')
    await userEvent.click(page.getByRole('button', { name: 'Align top' }))
    await expect.poll(() => cell('A2')!.classList.contains('g-cell-top')).toBe(true)
    await userEvent.selectOptions(page.getByLabelText('Borders'), 'bottom')
    await expect.poll(() => getComputedStyle(cell('A2')!).borderBottomStyle).toBe('solid')
    await expect.poll(() => state.harness!.savedCount()).toBeGreaterThan(0)
    await expect
      .poll(() => savedStyle(1, 0))
      .toMatchObject({
        horizontal: 'center',
        vertical: 'top',
        border: { bottom: { style: 'thin', color: null } },
      })
  })

  it('dragging a column edge sets its width; the width field sets it too', async () => {
    render(XlsxEditor, props)
    await expect.poll(() => cell('B2')).not.toBeNull()
    const handle = page.getByTestId('xlsx-col-resize-B').element()
    const box = handle.getBoundingClientRect()
    const x = box.left + 3
    const y = box.top + 5
    handle.dispatchEvent(
      new PointerEvent('pointerdown', { clientX: x, clientY: y, button: 0, bubbles: true }),
    )
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: x + 40, clientY: y }))
    await expect.element(page.getByTestId('xlsx-resize-guide')).toBeInTheDocument()
    window.dispatchEvent(new PointerEvent('pointerup', { clientX: x + 40, clientY: y }))
    await expect.poll(() => cell('B2')!.getBoundingClientRect().width).toBe(104)
    await expect.poll(() => state.harness!.savedCount()).toBe(1)
    expect(
      (await savedBook())
        .sheet('Budget')
        .cols.find((c) => c.min === 1)?.widthPx,
    ).toBe(104)
    await click('C2')
    await userEvent.fill(page.getByLabelText('Row height'), '30')
    await userEvent.keyboard('{Tab}')
    await expect.poll(() => cell('C2')!.getBoundingClientRect().height).toBe(40)
  })
})
