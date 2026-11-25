import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page, userEvent } from 'vitest/browser'
import { type DriveItem, type LockView } from '$lib/drive/api'
import { cellKey } from './ref'
import { budgetBook } from './test-utils/build-xlsx'
import { openWorkbook } from './workbook'
import XlsxEditor from './xlsx-editor.svelte'

/** The spreadsheet editor's cell formatting and sizing, end to end in the grid: format bar, shortcuts, drag handles. */

const api = vi.hoisted(() => ({
  readBytes: vi.fn<(id: string) => Promise<Uint8Array>>(),
  acquireLock: vi.fn<(id: string, session: string, takeover?: boolean) => Promise<LockView>>(),
  heartbeatLock: vi.fn<(id: string, session: string) => Promise<LockView>>(),
  releaseLock: vi.fn<(id: string, session: string) => Promise<void>>(),
  writeBytes:
    vi.fn<
      (
        id: string,
        bytes: Uint8Array,
        session: string,
        base?: string,
      ) => Promise<{ file: DriveItem }>
    >(),
}))
vi.mock('$lib/drive/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('$lib/drive/api')>()
  return { ...real, driveApi: { ...real.driveApi, ...api } }
})

const props = {
  fileId: 'book-1',
  name: 'Budget.xlsx',
  canEdit: true,
  heartbeatMs: 600_000,
  saveDelayMs: 20,
  idleMs: 600_000,
}
const BOOK = budgetBook()

const savedBook = () => {
  const calls = api.writeBytes.mock.calls
  if (!calls.length) throw new Error('nothing saved')
  return openWorkbook(calls.at(-1)![1])
}
const savedStyle = (r: number, c: number) => {
  const wb = savedBook()
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
    for (const fn of Object.values(api)) fn.mockReset()
    api.readBytes.mockImplementation(async () => api.writeBytes.mock.calls.at(-1)?.[1] ?? BOOK)
    api.acquireLock.mockResolvedValue({ state: 'held', since: '2026-11-25T10:00:00Z' })
    api.heartbeatLock.mockResolvedValue({ state: 'held', since: '2026-11-25T10:00:00Z' })
    api.releaseLock.mockResolvedValue(undefined)
    api.writeBytes.mockImplementation(async () => ({
      file: { id: 'book-1', type: 'file', name: 'Budget.xlsx' } as DriveItem,
    }))
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
    await expect.poll(() => api.writeBytes.mock.calls.length).toBe(1)
    expect(savedStyle(1, 0).font.bold).toBe(true)
    expect(savedStyle(2, 1).font.bold).toBe(true)
    // B2 kept its yellow fill.
    expect(savedStyle(1, 1)).toMatchObject({ fill: '#FFFF00', font: { bold: true } })
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
    await expect.poll(() => api.writeBytes.mock.calls.length).toBeGreaterThan(0)
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
    await expect.poll(() => api.writeBytes.mock.calls.length).toBe(1)
    expect(
      savedBook()
        .sheet('Budget')
        .cols.find((c) => c.min === 1)?.widthPx,
    ).toBe(104)
    await click('C2')
    await userEvent.fill(page.getByLabelText('Row height'), '30')
    await userEvent.keyboard('{Tab}')
    await expect.poll(() => cell('C2')!.getBoundingClientRect().height).toBe(40)
  })
})
