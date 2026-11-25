import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page, userEvent } from 'vitest/browser'
import { DriveApiError, type DriveItem, type LockHolder, type LockView } from '$lib/drive/api'
import { cellKey } from './ref'
import { budgetBook, buildXlsx, num, row } from './test-utils/build-xlsx'
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

const bob: LockHolder = {
  userId: 'bob',
  sessionId: 'tab-bob',
  since: '2026-11-25T10:00:00Z',
  name: 'Bob',
}
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
const cell = (ref: string) =>
  document.querySelector(`[data-testid="xlsx-grid"] [data-ref="${ref}"]`) as HTMLElement | null
const shown = (ref: string) => cell(ref)?.textContent?.trim() ?? null

async function click(ref: string) {
  await expect.poll(() => cell(ref)).not.toBeNull()
  await userEvent.click(cell(ref)!)
}

async function typeInto(ref: string, text: string) {
  await click(ref)
  await userEvent.keyboard(text)
  await userEvent.keyboard('{Enter}')
}

describe('xlsx editor', () => {
  beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockReset()
    // The server has what was last saved.
    api.readBytes.mockImplementation(async () => api.writeBytes.mock.calls.at(-1)?.[1] ?? BOOK)
    api.acquireLock.mockResolvedValue({ state: 'held', since: '2026-11-25T10:00:00Z' })
    api.heartbeatLock.mockResolvedValue({ state: 'held', since: '2026-11-25T10:00:00Z' })
    api.releaseLock.mockResolvedValue(undefined)
    api.writeBytes.mockImplementation(async () => ({
      file: { id: 'book-1', type: 'file', name: 'Budget.xlsx' } as DriveItem,
    }))
  })

  it('shows the sheet with calculated formulas, formats and tabs; view-only people can’t edit', async () => {
    render(XlsxEditor, { ...props, canEdit: false })
    await expect.poll(() => shown('B4')).toBe('1500')
    expect(shown('A2')).toBe('Rent')
    expect(cell('A1')!.style.fontWeight).toBe('600')
    expect(cell('B2')!.style.backgroundColor).toBe('rgb(255, 255, 0)')
    await expect.element(page.getByTestId('xlsx-tab').first()).toHaveTextContent('Budget')
    await expect.element(page.getByTestId('xlsx-view-only')).toBeInTheDocument()
    expect(page.getByTestId('xlsx-toolbar').query()).toBeNull()
    await click('B3')
    await userEvent.keyboard('9')
    expect(page.getByTestId('xlsx-cell-editor').query()).toBeNull()
    expect(api.acquireLock).not.toHaveBeenCalled()
    await expect.element(page.getByTestId('xlsx-formula')).toHaveValue('300')
  })

  it('types a value: the lock is taken, dependants recalculate, and the save is a revision based on what was opened', async () => {
    render(XlsxEditor, props)
    await expect.poll(() => shown('B4')).toBe('1500')
    expect(api.acquireLock).not.toHaveBeenCalled()
    await typeInto('B3', '450')
    await expect.poll(() => shown('B4')).toBe('1650')
    await expect.poll(() => api.writeBytes.mock.calls.length).toBe(1)
    expect(api.acquireLock).toHaveBeenCalledTimes(1)
    const [, , , base] = api.writeBytes.mock.calls[0]!
    expect(base).toMatch(/^[0-9a-f]{64}$/)
    const wb = savedBook()
    expect(wb.sheet('Budget').cells.get(cellKey(2, 1))?.value).toBe(450)
    expect(wb.sheet('Budget').cells.get(cellKey(3, 1))?.value).toBe(1650)
    expect(wb.sheet('Summary').cells.get(cellKey(0, 0))?.value).toBe(3300)
    await expect.element(page.getByTestId('xlsx-save-state')).toHaveTextContent('Saved')
  })

  it('enters a formula, shows its result, and the formula bar shows the formula', async () => {
    render(XlsxEditor, props)
    await expect.poll(() => shown('B4')).toBe('1500')
    await typeInto('B5', '=B4*2')
    await expect.poll(() => shown('B5')).toBe('3000')
    await click('B5')
    await expect.element(page.getByTestId('xlsx-formula')).toHaveValue('=B4*2')
    await expect.poll(() => api.writeBytes.mock.calls.length).toBe(1)
    expect(savedBook().sheet('Budget').cells.get(cellKey(4, 1))).toMatchObject({
      formula: 'B4*2',
      value: 3000,
    })
  })

  it('a spilling formula shows its results in the cells below, and saves as a dynamic array', async () => {
    render(XlsxEditor, props)
    await expect.poll(() => shown('B4')).toBe('1500')
    await typeInto('G1', '=SEQUENCE(3)')
    await expect.poll(() => shown('G1')).toBe('1')
    await expect.poll(() => shown('G3')).toBe('3')
    await expect.poll(() => api.writeBytes.mock.calls.length).toBe(1)
    const saved = savedBook().sheet('Budget').cells
    expect(saved.get(cellKey(0, 6))).toMatchObject({ dynamic: true, formulaRef: { bottom: 2 } })
    expect(saved.get(cellKey(2, 6))?.value).toBe(3)
  })

  it('edits through the formula bar', async () => {
    render(XlsxEditor, props)
    await expect.poll(() => shown('B3')).toBe('300')
    await click('B3')
    await page.getByTestId('xlsx-formula').fill('=B2+1')
    await userEvent.keyboard('{Enter}')
    await expect.poll(() => shown('B3')).toBe('1201')
    await expect.poll(() => shown('B4')).toBe('2401')
  })

  it('sets a number format on the selection', async () => {
    render(XlsxEditor, props)
    await expect.poll(() => shown('B3')).toBe('300')
    await click('B3')
    await userEvent.selectOptions(page.getByTestId('xlsx-format'), 'number')
    await expect.poll(() => shown('B3')).toBe('300.00')
    await expect.poll(() => api.writeBytes.mock.calls.length).toBe(1)
    const wb = savedBook()
    expect(wb.styles().xf(wb.sheet('Budget').cells.get(cellKey(2, 1))!.style).numFmt).toBe(
      '#,##0.00',
    )
  })

  it('inserts a row above the selection: cells and formulas move', async () => {
    render(XlsxEditor, props)
    await expect.poll(() => shown('A3')).toBe('Food')
    await click('A3')
    await page.getByTestId('xlsx-insert-row-above').click()
    await expect.poll(() => shown('A4')).toBe('Food')
    expect(shown('A3')).toBe('')
    await expect.poll(() => api.writeBytes.mock.calls.length).toBe(1)
    expect(savedBook().sheet('Budget').cells.get(cellKey(4, 1))?.formula).toBe('SUM(B2:B4)')
    await page.getByTestId('xlsx-undo').click()
    await expect.poll(() => shown('A3')).toBe('Food')
  })

  it('adds, renames and deletes a sheet (deleting asks first)', async () => {
    render(XlsxEditor, props)
    await expect.poll(() => shown('B4')).toBe('1500')
    await page.getByTestId('xlsx-add-sheet').click()
    await expect.element(page.getByTestId('xlsx-tab').nth(2)).toHaveTextContent('Sheet3')
    await expect
      .element(page.getByTestId('xlsx-tab').nth(2))
      .toHaveAttribute('aria-selected', 'true')
    await page.getByTestId('xlsx-rename-sheet').click()
    const input = page.getByTestId('xlsx-tab-rename')
    await input.fill('Notes')
    await userEvent.keyboard('{Enter}')
    await expect.element(page.getByTestId('xlsx-tab').nth(2)).toHaveTextContent('Notes')
    await page.getByTestId('xlsx-delete-sheet').click()
    await expect.element(page.getByTestId('xlsx-confirm')).toBeInTheDocument()
    await page.getByTestId('xlsx-confirm-ok').click()
    await expect.poll(() => document.querySelectorAll('[data-testid="xlsx-tab"]').length).toBe(2)
    await expect
      .poll(() =>
        savedBook()
          .sheets()
          .map((s) => s.name),
      )
      .toEqual(['Budget', 'Summary'])
  })

  it('deleting a sheet other sheets use lists what will show #REF! before doing it', async () => {
    render(XlsxEditor, props)
    await expect.poll(() => shown('B4')).toBe('1500')
    await page.getByTestId('xlsx-delete-sheet').click()
    await expect
      .element(page.getByTestId('xlsx-losses'))
      .toHaveTextContent('Formulas in other sheets that use it: 2')
    await page.getByTestId('xlsx-confirm-cancel').click()
    expect(api.writeBytes).not.toHaveBeenCalled()
    expect(document.querySelectorAll('[data-testid="xlsx-tab"]').length).toBe(2)
  })

  it('a newer version saved elsewhere is never overwritten: it says so and offers the newer one', async () => {
    api.writeBytes.mockRejectedValue(
      new DriveApiError('“Budget.xlsx” was changed since you opened it.', 409, 'conflict', null),
    )
    render(XlsxEditor, props)
    await expect.poll(() => shown('B4')).toBe('1500')
    await typeInto('B3', '1')
    await expect.element(page.getByTestId('xlsx-conflict')).toBeInTheDocument()
    expect(page.getByTestId('xlsx-toolbar').query()).toBeNull()
    api.readBytes.mockResolvedValue(
      budgetBook({ strings: ['Item', 'Cost', 'Rent', 'Food', 'Sum'] }),
    )
    await page.getByTestId('xlsx-reload').click()
    await expect.poll(() => shown('A4')).toBe('Sum')
    await expect.element(page.getByTestId('xlsx-toolbar')).toBeInTheDocument()
  })

  it('someone else editing: their name and Take over, nothing changes', async () => {
    api.acquireLock.mockResolvedValue({ state: 'locked', holder: bob })
    render(XlsxEditor, props)
    await expect.poll(() => shown('B4')).toBe('1500')
    await typeInto('B3', '9')
    await expect
      .element(page.getByTestId('xlsx-watching'))
      .toHaveTextContent('Bob is editing this workbook right now.')
    expect(shown('B3')).toBe('300')
    expect(api.writeBytes).not.toHaveBeenCalled()
  })

  it('names what it does not show, and that it is kept', async () => {
    const bytes = buildXlsx({
      sheets: [
        { name: 'S', rows: row(1, num('A1', 1)) },
        { name: 'Old', state: 'hidden' },
      ],
      parts: {
        '/xl/charts/chart1.xml': {
          xml: '<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"/>',
          type: 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml',
        },
      },
    })
    api.readBytes.mockResolvedValue(bytes)
    render(XlsxEditor, props)
    await expect.element(page.getByTestId('xlsx-notes')).toHaveTextContent('2 kind(s) of content')
    await page.getByTestId('xlsx-notes').getByRole('button').click()
    await expect.element(page.getByTestId('xlsx-notes-list')).toHaveTextContent('Charts: 1')
    await expect
      .element(page.getByTestId('xlsx-notes-list'))
      .toHaveTextContent('Hidden sheets (1): Old')
  })
})
