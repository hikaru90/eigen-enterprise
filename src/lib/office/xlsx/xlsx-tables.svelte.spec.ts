import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page, userEvent } from 'vitest/browser'
import type { DriveItem, LockView } from '$lib/drive/api'
import { readSheetPivots } from './pivot'
import { readSheetTables } from './tables'
import { buildXlsx, num, row, str } from './test-utils/build-xlsx'
import { openWorkbook } from './workbook'
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
}))
vi.mock('$lib/drive/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('$lib/drive/api')>()
  return { ...real, driveApi: { ...real.driveApi, ...api } }
})

const props = {
  fileId: 'book-1',
  name: 'Sales.xlsx',
  canEdit: true,
  heartbeatMs: 600_000,
  saveDelayMs: 20,
  idleMs: 600_000,
}

const sales = () =>
  buildXlsx({
    strings: ['Region', 'Product', 'Amount', 'East', 'West', 'Pen', 'Ink'],
    sheets: [
      {
        name: 'Data',
        rows:
          row(1, str('A1', 0) + str('B1', 1) + str('C1', 2)) +
          row(2, str('A2', 3) + str('B2', 5) + num('C2', 10)) +
          row(3, str('A3', 4) + str('B3', 5) + num('C3', 20)) +
          row(4, str('A4', 3) + str('B4', 6) + num('C4', 5)) +
          row(5, str('A5', 4) + str('B5', 6) + num('C5', 7)),
      },
    ],
  })

const savedBook = () => {
  const calls = api.writeBytes.mock.calls
  if (!calls.length) throw new Error('nothing saved')
  return openWorkbook(calls.at(-1)![1])
}
const cell = (ref: string) =>
  document.querySelector(`[data-testid="xlsx-grid"] [data-ref="${ref}"]`) as HTMLElement | null
const shown = (ref: string) => cell(ref)?.textContent?.trim() ?? null

async function click(ref: string) {
  await expect.poll(() => cell(ref)).not.toBeNull()
  await userEvent.click(cell(ref)!)
}

describe('xlsx editor: tables and pivot tables', () => {
  beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockReset()
    // One build per test: a ZIP built again a second later has other timestamps (another SHA), which the editor reads as a newer version.
    const original = sales()
    api.readBytes.mockImplementation(async () => api.writeBytes.mock.calls.at(-1)?.[1] ?? original)
    api.acquireLock.mockResolvedValue({ state: 'held', since: '2026-11-25T10:00:00Z' })
    api.heartbeatLock.mockResolvedValue({ state: 'held', since: '2026-11-25T10:00:00Z' })
    api.releaseLock.mockResolvedValue(undefined)
    api.writeBytes.mockImplementation(async () => ({
      file: { id: 'book-1', type: 'file', name: 'Sales.xlsx' } as DriveItem,
    }))
  })

  it('Ctrl+T creates a table from the cells around the active cell; the table bar adds a total row', async () => {
    render(XlsxEditor, props)
    await expect.poll(() => shown('C2')).toBe('10')
    await click('B3')
    await userEvent.keyboard('{Control>}t{/Control}')
    await expect.element(page.getByTestId('xlsx-table-dialog')).toBeInTheDocument()
    await expect.element(page.getByTestId('xlsx-table-range')).toHaveValue('A1:C5')
    await expect.element(page.getByTestId('xlsx-table-headers')).toBeChecked()
    await page.getByTestId('xlsx-table-create').click()
    await expect.element(page.getByTestId('xlsx-table-bar')).toBeInTheDocument()
    await expect.element(page.getByTestId('xlsx-table-name')).toHaveValue('Table1')
    // The header row gets the table's drop-downs.
    await expect
      .poll(() => document.querySelectorAll('[data-testid="xlsx-filter-button"]').length)
      .toBe(3)
    await page.getByTestId('xlsx-table-totalsRow').click()
    await expect.poll(() => shown('C6')).toBe('42')
    await expect.poll(() => api.writeBytes.mock.calls.length).toBeGreaterThan(0)
    await expect
      .poll(() => readSheetTables(savedBook(), 'Data')[0]?.totalsRowCount ?? 0)
      .toBe(1)
  })

  it('creates a PivotTable on a new sheet and builds it from the field list', async () => {
    render(XlsxEditor, props)
    await expect.poll(() => shown('C2')).toBe('10')
    await click('A1')
    await page.getByTestId('xlsx-pivot-create-open').click()
    await expect.element(page.getByTestId('xlsx-pivot-range')).toHaveValue('Data!A1:C5')
    await page.getByTestId('xlsx-pivot-create').click()
    await expect.element(page.getByTestId('xlsx-pivot-fields')).toBeInTheDocument()
    // A ticked field goes to Rows; "Add to" puts one in Values (summed).
    await page.getByRole('checkbox', { name: 'Region' }).click()
    await expect
      .poll(() =>
        [...document.querySelectorAll('[data-area="rows"] [data-testid="xlsx-pivot-chip"]')].map(
          (e) => e.getAttribute('data-field'),
        ),
      )
      .toEqual(['Region'])
    const add = document.querySelector<HTMLSelectElement>(
      '[data-testid="xlsx-pivot-add"][data-field="Amount"]',
    )!
    await userEvent.selectOptions(add, 'values')
    await expect.poll(() => shown('B6')).toBe('42')
    expect(shown('A4')).toBe('East')
    expect(shown('B4')).toBe('15')
    await expect.poll(() => api.writeBytes.mock.calls.length).toBeGreaterThan(0)
    const book = savedBook()
    const sheet = book.sheets().find((s) => s.name !== 'Data')!.name
    await expect
      .poll(() => readSheetPivots(savedBook(), sheet)[0]?.dataFields.map((d) => d.agg))
      .toEqual(['sum'])
    // Changing how a value is summarised recalculates the PivotTable.
    await userEvent.selectOptions(page.getByTestId('xlsx-pivot-agg'), 'count')
    await expect.poll(() => shown('B6')).toBe('4')
  })
})
