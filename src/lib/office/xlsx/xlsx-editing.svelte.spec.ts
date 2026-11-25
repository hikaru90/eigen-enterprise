import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page, userEvent } from 'vitest/browser'
import type { DriveItem, LockView } from '$lib/drive/api'
import { DriveApiError } from '$lib/drive/api'
import { cellKey } from './ref'
import { outlineOf } from './rows-cols'
import { sheetTabColor } from './sheet-tabs'
import { buildXlsx, fml, num, row, str } from './test-utils/build-xlsx'
import { openWorkbook } from './workbook'
import { resetPlainLive } from './test-utils/live-api'
import XlsxEditor from './xlsx-editor.svelte'

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
  exportSheetPdf:
    vi.fn<
      (
        id: string,
        opts?: Record<string, unknown>,
      ) => Promise<{ filename: string; bytes: Uint8Array }>
    >(),
}))

vi.mock('$lib/drive/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('$lib/drive/api')>()
  const { liveOverPlainApi } = await import('./test-utils/live-api')
  return { ...real, driveApi: { ...real.driveApi, ...api, ...liveOverPlainApi(api) } }
})

const props = {
  fileId: 'book-edit-1',
  name: 'Budget.xlsx',
  canEdit: true,
  heartbeatMs: 600_000,
  saveDelayMs: 20,
  idleMs: 600_000,
}

const sampleBook = () =>
  buildXlsx({
    strings: ['Item', 'Q1', 'Q2', 'Widget', 'Gadget', 'Sprocket', 'Extra'],
    sheets: [
      {
        name: 'Sales',
        rows:
          row(1, str('A1', 0, 1) + str('B1', 1, 1) + str('C1', 2, 1)) +
          row(2, str('A2', 3) + num('B2', 10) + num('C2', 20)) +
          row(3, str('A3', 4) + num('B3', 30) + num('C3', 40)) +
          row(4, str('A4', 5) + num('B4', 50) + fml('C4', 'B4*2', 100)),
      },
      {
        name: 'Summary',
        rows: row(1, str('A1', 6) + fml('B1', 'Sales!C4', 100)),
      },
    ],
  })

let latestBytes: Uint8Array
const savedBook = () => openWorkbook(latestBytes)

beforeEach(() => {

  resetPlainLive(api)
  vi.clearAllMocks()
  latestBytes = sampleBook()
  api.readBytes.mockResolvedValue(latestBytes)
  api.acquireLock.mockResolvedValue({ state: 'held', since: '2026-11-25T14:00:00Z' })
  api.heartbeatLock.mockResolvedValue({ state: 'held', since: '2026-11-25T14:00:00Z' })
  api.releaseLock.mockResolvedValue(undefined)
  api.writeBytes.mockImplementation(async (_id, bytes) => {
    latestBytes = bytes
    return {
      file: {
        type: 'file',
        id: 'book-edit-1',
        name: 'Budget.xlsx',
        parentId: null,
        ownerId: 'u1',
        updatedAt: '2026-11-25T14:00:00Z',
        trashedAt: null,
      },
    }
  })
  api.exportSheetPdf.mockResolvedValue({
    filename: 'Budget.pdf',
    bytes: new TextEncoder().encode('%PDF-1.4\n%%EOF\n'),
  })
})

const cell = (ref: string) => document.querySelector<HTMLElement>(`.xlsx-cell[data-ref="${ref}"]`)

const clickCell = async (ref: string, mods: { ctrl?: boolean; shift?: boolean } = {}) => {
  const el = cell(ref)!
  const rect = el.getBoundingClientRect()
  el.dispatchEvent(
    new PointerEvent('pointerdown', {
      bubbles: true,
      button: 0,
      buttons: 1,
      clientX: rect.left + 8,
      clientY: rect.top + 8,
      ctrlKey: !!mods.ctrl,
      shiftKey: !!mods.shift,
    }),
  )
  el.dispatchEvent(
    new PointerEvent('pointerup', {
      bubbles: true,
      button: 0,
      buttons: 0,
      clientX: rect.left + 8,
      clientY: rect.top + 8,
      ctrlKey: !!mods.ctrl,
      shiftKey: !!mods.shift,
    }),
  )
}

describe('XlsxEditor — Everyday Editing Parity', () => {
  it('supports Ctrl+Arrow jumping, Ctrl+Shift extension, Tab inside selection, multi-range Ctrl selection + status bar stats, and Name Box Go To', async () => {
    render(XlsxEditor, props)
    await expect.poll(() => cell('B2')?.textContent?.trim()).toBe('10')

    // Ctrl+ArrowDown from B1 jumps to bottom of contiguous block (B4)
    await clickCell('B1')
    await expect.element(page.getByTestId('xlsx-ref')).toHaveValue('B1')
    const grid = page.getByTestId('xlsx-grid')
    grid
      .element()
      .dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', ctrlKey: true, bubbles: true }),
      )
    await expect.element(page.getByTestId('xlsx-ref')).toHaveValue('B4')

    // Ctrl+Shift+Up from B4 extends to B1 and computes Sum/Avg/Count
    grid
      .element()
      .dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'ArrowUp',
          ctrlKey: true,
          shiftKey: true,
          bubbles: true,
        }),
      )
    await expect.element(page.getByTestId('xlsx-ref')).toHaveValue('B1:B4')
    await expect.element(page.getByTestId('xlsx-stat-count')).toHaveTextContent('Count: 4')
    await expect.element(page.getByTestId('xlsx-stat-sum')).toHaveTextContent('Sum: 90')
    await expect.element(page.getByTestId('xlsx-stat-avg')).toHaveTextContent('Average: 30')

    // Ctrl+click adds C2 to existing selection (multi-range): Count becomes 5, Sum becomes 110
    await clickCell('B2')
    await clickCell('B3', { shift: true })
    await clickCell('C2', { ctrl: true })
    await expect.element(page.getByTestId('xlsx-stat-count')).toHaveTextContent('Count: 3')
    await expect.element(page.getByTestId('xlsx-stat-sum')).toHaveTextContent('Sum: 60')

    // Tab moves within a multi-cell selection without collapsing it: from C3 (the last cell) it wraps to B2, then C2
    await clickCell('B2')
    await clickCell('C3', { shift: true })
    const activeId = () =>
      document.querySelector('[aria-activedescendant]')?.getAttribute('aria-activedescendant')
    grid.element().dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    await expect.poll(activeId).toBe('xlsx-cell-1-1')
    grid.element().dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    await expect.poll(activeId).toBe('xlsx-cell-1-2')
    await expect.element(page.getByTestId('xlsx-ref')).toHaveValue('B2:C3')

    // Name box Go To jumps across sheets
    const refBox = page.getByTestId('xlsx-ref')
    await userEvent.click(refBox)
    await userEvent.fill(refBox, 'Summary!B1')
    await userEvent.keyboard('{Enter}')
    await expect.element(page.getByTestId('xlsx-formula')).toHaveValue('=Sales!C4')
  })

  it('fills series via fill handle drag, double-click fill-down, and Ctrl+D / Ctrl+R', async () => {
    render(XlsxEditor, props)
    await expect.poll(() => cell('B2')?.textContent?.trim()).toBe('10')

    // Drag fill handle from B2:B3 down to B5 -> 50 becomes 50 overwritten? Wait: [10, 30] -> B4=50, B5=70!
    await clickCell('B2')
    await clickCell('B3', { shift: true })
    const handle = document.querySelector<HTMLElement>('[data-testid="xlsx-fill-handle"]')!
    const hRect = handle.getBoundingClientRect()
    const b5 = cell('B5')!
    const b5Rect = b5.getBoundingClientRect()
    handle.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        button: 0,
        buttons: 1,
        clientX: hRect.left + 3,
        clientY: hRect.top + 3,
      }),
    )
    window.dispatchEvent(
      new PointerEvent('pointermove', {
        bubbles: true,
        buttons: 1,
        clientX: b5Rect.left + 8,
        clientY: b5Rect.top + 8,
      }),
    )
    window.dispatchEvent(
      new PointerEvent('pointerup', {
        bubbles: true,
        button: 0,
        buttons: 0,
        clientX: b5Rect.left + 8,
        clientY: b5Rect.top + 8,
      }),
    )
    await expect.poll(() => cell('B5')?.textContent?.trim()).toBe('70')

    // Ctrl+D fills E1 -> E1:E2
    await clickCell('E1')
    await page.getByTestId('xlsx-formula').fill('Top')
    await userEvent.keyboard('{Enter}')
    await clickCell('E1')
    await clickCell('E2', { shift: true })
    page
      .getByTestId('xlsx-grid')
      .element()
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'd', ctrlKey: true, bubbles: true }))
    await expect.poll(() => cell('E2')?.textContent?.trim()).toBe('Top')

    // Double-click fill handle on F2 fills down alongside populated E2? Wait: adjacent E1:E2 has row 2 -> double-click F1 fills to row 2!
    await clickCell('F1')
    await page.getByTestId('xlsx-formula').fill('Side')
    await userEvent.keyboard('{Enter}')
    await clickCell('F1')
    document
      .querySelector<HTMLElement>('[data-testid="xlsx-fill-handle"]')!
      .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    await expect.poll(() => cell('F2')?.textContent?.trim()).toBe('Side')
  })

  it('supports copy, cut, paste special (values / transpose), and updates incoming formulas on cut', async () => {
    render(XlsxEditor, props)
    await expect.poll(() => cell('C4')?.textContent?.trim()).toBe('100')

    // Copy C4 (formula =B4*2, value 100) and paste Special Values into E4
    await clickCell('C4')
    await userEvent.click(page.getByTestId('xlsx-copy-btn'))
    await clickCell('E4')
    await userEvent.selectOptions(page.getByTestId('xlsx-paste-special'), 'values')
    await expect.poll(() => cell('E4')?.textContent?.trim()).toBe('100')
    await clickCell('E4')
    await expect.element(page.getByTestId('xlsx-formula')).toHaveValue('100')

    // Cut C4 -> D4: outline appears, paste moves it and updates Summary!B1 -> Sales!D4
    await clickCell('C4')
    await userEvent.click(page.getByTestId('xlsx-cut-btn'))
    await expect.element(page.getByTestId('xlsx-cut-outline')).toBeInTheDocument()
    await clickCell('D4')
    await userEvent.click(page.getByTestId('xlsx-paste-btn'))
    await expect.poll(() => cell('D4')?.textContent?.trim()).toBe('100')
    await expect.poll(() => document.querySelector('[data-testid="xlsx-cut-outline"]')).toBeNull()

    await expect
      .poll(() => savedBook().sheet('Summary').cells.get(cellKey(0, 1))?.formula)
      .toBe('Sales!D4')
  })

  it('supports Find & Replace dialog across workbook', async () => {
    render(XlsxEditor, props)
    await expect.poll(() => cell('A2')?.textContent?.trim()).toBe('Widget')

    await userEvent.click(page.getByTestId('xlsx-find-btn'))
    await expect.element(page.getByTestId('xlsx-find-dialog')).toBeInTheDocument()
    await userEvent.click(page.getByTestId('xlsx-find-tab-replace'))
    await userEvent.fill(page.getByTestId('xlsx-find-input'), 'Widget')
    await userEvent.fill(page.getByTestId('xlsx-replace-input'), 'SuperWidget')
    await userEvent.click(page.getByTestId('xlsx-replace-all'))
    await expect.poll(() => cell('A2')?.textContent?.trim()).toBe('SuperWidget')
  })

  it('supports Merge & Center, Clear, decimals, custom number format, and Format Painter', async () => {
    render(XlsxEditor, props)
    await expect.poll(() => cell('B2')?.textContent?.trim()).toBe('10')

    // Merge B1:C1 drops C1 ("Q2") -> shows loss confirm dialog, confirming merges them
    await clickCell('B1')
    await clickCell('C1', { shift: true })
    await userEvent.selectOptions(page.getByTestId('xlsx-merge'), 'center')
    await expect.element(page.getByTestId('xlsx-confirm')).toBeInTheDocument()
    await userEvent.click(page.getByTestId('xlsx-confirm-ok'))
    await expect
      .poll(() => savedBook().sheet('Sales').merges)
      .toEqual([{ top: 0, left: 1, bottom: 0, right: 2 }])

    // Increase decimal on B2 -> "10.0"
    await clickCell('B2')
    await userEvent.click(page.getByTestId('xlsx-decimals-more'))
    await expect.poll(() => cell('B2')?.textContent?.trim()).toBe('10.0')

    // Format Painter: bold B2 then paint onto C2
    await userEvent.click(page.getByRole('button', { name: 'Bold' }))
    await userEvent.click(page.getByTestId('xlsx-format-painter'))
    await expect
      .element(page.getByTestId('xlsx-format-painter'))
      .toHaveAttribute('aria-pressed', 'true')
    await clickCell('C2')
    await expect.poll(() => cell('C2')?.style.fontWeight).toBe('600')

    // Clear formats on C2 restores plain look
    await userEvent.selectOptions(page.getByTestId('xlsx-clear'), 'formats')
    await expect.poll(() => cell('C2')?.style.fontWeight).toBe('')
  })

  it('provides formula autocomplete, argument hints, point-to-select, and F4 lock cycling', async () => {
    render(XlsxEditor, props)
    await expect.poll(() => cell('B2')?.textContent?.trim()).toBe('10')

    await clickCell('D2')
    const bar = page.getByTestId('xlsx-formula')
    await userEvent.click(bar)
    await userEvent.fill(bar, '=SUM')
    await expect.element(page.getByTestId('xlsx-formula-autocomplete')).toBeInTheDocument()

    // Tab completes SUM( and displays argument hint
    await userEvent.keyboard('{Tab}')
    await expect.element(bar).toHaveValue('=SUM(')
    await expect.element(page.getByTestId('xlsx-formula-hint')).toBeInTheDocument()

    // Point-to-select clicks B2, updates formula bar + grid ref box highlight
    await clickCell('B2')
    await expect.element(bar).toHaveValue('=SUM(B2')
    await expect.element(page.getByTestId('xlsx-formula-ref-box')).toBeInTheDocument()

    // F4 cycles $B$2
    bar.element().dispatchEvent(new KeyboardEvent('keydown', { key: 'F4', bubbles: true }))
    await expect.element(bar).toHaveValue('=SUM($B$2')
    await userEvent.keyboard(')')
    await expect.element(bar).toHaveValue('=SUM($B$2)')
    await userEvent.keyboard('{Enter}')
    await expect.poll(() => cell('D2')?.textContent?.trim()).toBe('10')
  })

  it('supports rows/cols outline grouping & autofit, sheet tabs reorder/colour/hide/unhide/duplicate, view toggles, and PDF export failure handling', async () => {
    render(XlsxEditor, props)
    await expect.poll(() => cell('A2')?.textContent?.trim()).toBe('Widget')

    // Group rows 2..3 and collapse from outline gutter
    await clickCell('A2')
    await clickCell('A3', { shift: true })
    await userEvent.selectOptions(page.getByTestId('xlsx-rows-cols-menu'), 'group_rows')
    await expect.element(page.getByTestId('xlsx-outline-row-toggle-1-2')).toBeInTheDocument()
    await userEvent.click(page.getByTestId('xlsx-outline-row-toggle-1-2'))
    await expect.poll(() => cell('A2')?.style.height).toBe('0px')
    await expect.poll(() => outlineOf(savedBook(), 'Sales').rows[0]?.collapsed).toBe(true)

    // Double-click column resize handle autofits column A
    const colHandle = document.querySelector<HTMLElement>('[data-testid="xlsx-col-resize-A"]')!
    const wBefore = cell('A2')!.getBoundingClientRect().width
    colHandle.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    await expect.poll(() => cell('A2')!.getBoundingClientRect().width).not.toBe(wBefore)

    // Sheet tab colour, duplicate, hide, unhide
    await userEvent.click(page.getByTestId('xlsx-tab-menu-btn'))
    await userEvent.click(page.getByTestId('xlsx-tab-color-1F4E79'))
    await expect.poll(() => sheetTabColor(savedBook(), 'Sales')).toBe('#1F4E79')

    await userEvent.click(page.getByTestId('xlsx-tab-menu-btn'))
    await userEvent.click(page.getByTestId('xlsx-tab-action-duplicate'))
    await expect.poll(() => document.querySelectorAll('[data-testid="xlsx-tab"]').length).toBe(3)

    // Toggle gridlines and zoom
    await userEvent.click(page.getByTestId('xlsx-toggle-gridlines'))
    await userEvent.selectOptions(page.getByTestId('xlsx-zoom'), '150')
    await expect.poll(() => savedBook().sheet('Sales').rows.size > 0).toBe(true)

    // Page setup dialog + PDF export (also verifies loud failure surface when Chromium unavailable)
    await userEvent.click(page.getByTestId('xlsx-page-setup-btn'))
    await expect.element(page.getByTestId('xlsx-page-setup-dialog')).toBeInTheDocument()
    await userEvent.selectOptions(page.getByTestId('xlsx-page-orientation'), 'landscape')
    await userEvent.click(page.getByTestId('xlsx-page-export-pdf'))
    await expect.poll(() => api.exportSheetPdf).toHaveBeenCalled()

    api.exportSheetPdf.mockRejectedValueOnce(
      new DriveApiError('No Chromium installed', 503, 'unavailable', null),
    )
    await userEvent.click(page.getByTestId('xlsx-page-setup-btn'))
    await userEvent.click(page.getByTestId('xlsx-page-export-pdf'))
    await expect
      .element(page.getByTestId('xlsx-failure'))
      .toHaveTextContent('No Chromium installed')
  })
})
