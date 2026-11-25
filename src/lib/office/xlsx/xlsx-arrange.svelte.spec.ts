import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page, userEvent } from 'vitest/browser'
import type { DriveItem, LockView } from '$lib/drive/api'
import { autoFilterOf } from './filter'
import { frozenOf } from './panes'
import { cellKey } from './ref'
import { buildXlsx, fml, num, row, str } from './test-utils/build-xlsx'
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
  name: 'People.xlsx',
  canEdit: true,
  heartbeatMs: 600_000,
  saveDelayMs: 20,
  idleMs: 600_000,
}

/** Header (bold), four people with amounts and a formula each. */
const people = (after = '') =>
  buildXlsx({
    strings: ['Name', 'Amount', 'Double', 'bob', 'Alice', 'carol', 'Dave'],
    sheets: [
      {
        name: 'Data',
        rows:
          row(1, str('A1', 0, 1) + str('B1', 1, 1) + str('C1', 2, 1)) +
          row(2, str('A2', 3) + num('B2', 30) + fml('C2', 'B2*2', 60)) +
          row(3, str('A3', 4) + num('B3', 10) + fml('C3', 'B3*2', 20)) +
          row(4, str('A4', 5) + num('B4', 40) + fml('C4', 'B4*2', 80)) +
          row(5, str('A5', 6) + num('B5', 20) + fml('C5', 'B5*2', 40)),
        after,
      },
    ],
  })

/** The same book with the first row frozen, as Excel saves it. */
function withFrozenRow(bytes: Uint8Array): Uint8Array {
  const files = unzipSync(bytes)
  const name = 'xl/worksheets/sheet1.xml'
  files[name] = strToU8(
    strFromU8(files[name]!).replace(
      '<sheetView workbookViewId="0"/>',
      '<sheetView tabSelected="1" workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView>',
    ),
  )
  return zipSync(files)
}
let BOOK = people()

const savedBook = () => {
  const calls = api.writeBytes.mock.calls
  if (!calls.length) throw new Error('nothing saved')
  return openWorkbook(calls.at(-1)![1])
}
const cell = (ref: string) =>
  document.querySelector(`[data-testid="xlsx-grid"] [data-ref="${ref}"]`) as HTMLElement | null
const shown = (ref: string) => cell(ref)?.textContent?.trim() ?? null
const column = (col: string) => [2, 3, 4, 5].map((r) => shown(`${col}${r}`))

async function click(ref: string) {
  await expect.poll(() => cell(ref)).not.toBeNull()
  await userEvent.click(cell(ref)!)
}

describe('xlsx editor: sort, filter, freeze panes', () => {
  beforeEach(() => {
    BOOK = people()
    for (const fn of Object.values(api)) fn.mockReset()
    api.readBytes.mockImplementation(async () => api.writeBytes.mock.calls.at(-1)?.[1] ?? BOOK)
    api.acquireLock.mockResolvedValue({ state: 'held', since: '2026-11-25T10:00:00Z' })
    api.heartbeatLock.mockResolvedValue({ state: 'held', since: '2026-11-25T10:00:00Z' })
    api.releaseLock.mockResolvedValue(undefined)
    api.writeBytes.mockImplementation(async () => ({
      file: { id: 'book-1', type: 'file', name: 'People.xlsx' } as DriveItem,
    }))
  })

  it('quick sort from one cell sorts the block around it under its header; formulas follow; undo puts it back', async () => {
    render(XlsxEditor, props)
    await expect.poll(() => shown('C2')).toBe('60')
    await click('B3')
    await page.getByTestId('xlsx-sort-asc').click()
    await expect.poll(() => column('A')).toEqual(['Alice', 'Dave', 'bob', 'carol'])
    expect(shown('A1')).toBe('Name')
    expect(column('C')).toEqual(['20', '40', '60', '80'])
    await expect.poll(() => api.writeBytes.mock.calls.length).toBe(1)
    expect(savedBook().sheet('Data').cells.get(cellKey(1, 2))?.formula).toBe('B2*2')
    await page.getByTestId('xlsx-undo').click()
    await expect.poll(() => column('A')).toEqual(['bob', 'Alice', 'carol', 'Dave'])
  })

  it('the Sort dialog sorts by the chosen column and order', async () => {
    render(XlsxEditor, props)
    await expect.poll(() => shown('C2')).toBe('60')
    await click('A2')
    await page.getByTestId('xlsx-sort-open').click()
    await expect.element(page.getByTestId('xlsx-sort-dialog')).toBeInTheDocument()
    await expect.element(page.getByTestId('xlsx-sort-header')).toBeChecked()
    await expect
      .element(page.getByTestId('xlsx-sort-column'))
      .toHaveTextContent('Column A (Name)')
    await userEvent.selectOptions(page.getByTestId('xlsx-sort-column'), 'Column B (Amount)')
    await userEvent.selectOptions(page.getByTestId('xlsx-sort-order'), 'Z to A, largest first')
    await page.getByTestId('xlsx-sort-go').click()
    await expect.poll(() => column('B')).toEqual(['40', '30', '20', '10'])
    expect(column('A')).toEqual(['carol', 'bob', 'Dave', 'Alice'])
  })

  it('filter: drop-downs on the header row, untick a value, its row hides, the status counts, Clear shows it again', async () => {
    render(XlsxEditor, props)
    await expect.poll(() => shown('C2')).toBe('60')
    await click('A1')
    await page.getByTestId('xlsx-filter-toggle').click()
    await expect
      .poll(() => document.querySelectorAll('[data-testid="xlsx-filter-button"]').length)
      .toBe(3)
    await expect
      .element(page.getByTestId('xlsx-filter-toggle'))
      .toHaveAttribute('aria-pressed', 'true')
    await page.getByRole('button', { name: 'Filter column A' }).click()
    const menu = page.getByTestId('xlsx-filter-menu')
    await expect.element(menu).toBeInTheDocument()
    await expect.element(menu).toHaveAttribute('role', 'dialog')
    expect(
      [...document.querySelectorAll('[data-testid="xlsx-filter-value"]')].map((e) =>
        e.getAttribute('data-value'),
      ),
    ).toEqual(['Alice', 'bob', 'carol', 'Dave'])
    await page.getByRole('checkbox', { name: 'bob' }).click()
    await page.getByTestId('xlsx-filter-ok').click()
    await expect.poll(() => cell('A2')?.style.height).toBe('0px')
    await expect
      .element(page.getByTestId('xlsx-filter-status'))
      .toHaveTextContent('3 of 4 rows shown')
    await expect
      .element(page.getByRole('button', { name: 'Column A is filtered: change the filter' }))
      .toBeInTheDocument()
    await expect.poll(() => api.writeBytes.mock.calls.length).toBeGreaterThan(0)
    await expect.poll(() => savedBook().sheet('Data').rows.get(1)?.hidden).toBe(true)
    expect(autoFilterOf(savedBook(), 'Data')?.columns).toEqual([
      { col: 0, kind: 'values', values: ['Alice', 'carol', 'Dave'], blanks: false },
    ])
    await page.getByRole('button', { name: 'Column A is filtered: change the filter' }).click()
    await page.getByTestId('xlsx-filter-clear').click()
    await expect.poll(() => cell('A2')?.style.height).not.toBe('0px')
    // Turning it off removes the drop-downs.
    await page.getByTestId('xlsx-filter-toggle').click()
    await expect
      .poll(() => document.querySelectorAll('[data-testid="xlsx-filter-button"]').length)
      .toBe(0)
  })

  it('the filter menu sorts the filter range by its column; Esc closes it', async () => {
    render(XlsxEditor, props)
    await expect.poll(() => shown('C2')).toBe('60')
    await click('B1')
    await page.getByTestId('xlsx-filter-toggle').click()
    await page.getByRole('button', { name: 'Filter column B' }).click()
    await page.getByTestId('xlsx-filter-sort-desc').click()
    await expect.poll(() => column('B')).toEqual(['40', '30', '20', '10'])
    await page.getByRole('button', { name: 'Filter column B' }).click()
    await expect.element(page.getByTestId('xlsx-filter-menu')).toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    expect(page.getByTestId('xlsx-filter-menu').query()).toBeNull()
  })

  it('freezes the top row (it stays as a sticky pane) and unfreezes', async () => {
    render(XlsxEditor, props)
    await expect.poll(() => shown('C2')).toBe('60')
    await userEvent.selectOptions(page.getByTestId('xlsx-freeze'), 'row')
    await expect.element(page.getByTestId('xlsx-frozen-rows')).toBeInTheDocument()
    expect(
      document.querySelector('[data-testid="xlsx-frozen-rows"] [data-ref="A1"]')?.textContent,
    ).toContain('Name')
    // Scrolling down: the frozen row stays where it is, the others move under it.
    const grid = document.querySelector('[data-testid="xlsx-grid"]') as HTMLElement
    const top = (ref: string) => cell(ref)!.getBoundingClientRect().top
    const frozenTop = top('A1')
    const bodyTop = top('A3')
    grid.scrollTop = 40
    grid.dispatchEvent(new Event('scroll'))
    await expect.poll(() => top('A3')).toBeCloseTo(bodyTop - 40, 0)
    expect(top('A1')).toBeCloseTo(frozenTop, 0)
    grid.scrollTop = 0
    grid.dispatchEvent(new Event('scroll'))
    await expect.poll(() => api.writeBytes.mock.calls.length).toBeGreaterThan(0)
    await expect.poll(() => frozenOf(savedBook(), 'Data')).toEqual({ rows: 1, cols: 0 })
    await click('B3')
    await userEvent.selectOptions(page.getByTestId('xlsx-freeze'), 'at')
    await expect.element(page.getByTestId('xlsx-frozen-cols')).toBeInTheDocument()
    expect(
      document.querySelector('[data-testid="xlsx-frozen-cols"] [data-ref="A3"]')?.textContent,
    ).toContain('Alice')
    const left = (ref: string) => cell(ref)!.getBoundingClientRect().left
    const frozenLeft = left('A3')
    const bodyLeft = left('C3')
    grid.scrollLeft = 30
    grid.dispatchEvent(new Event('scroll'))
    await expect.poll(() => left('C3')).toBeCloseTo(bodyLeft - 30, 0)
    expect(left('A3')).toBeCloseTo(frozenLeft, 0)
    await userEvent.selectOptions(page.getByTestId('xlsx-freeze'), 'none')
    await expect.poll(() => page.getByTestId('xlsx-frozen-rows').query()).toBeNull()
  })

  it('shows frozen panes and the filter a file already has, also to view-only people', async () => {
    BOOK = withFrozenRow(
      people(
        '<autoFilter ref="A1:C5"><filterColumn colId="0"><filters><filter val="bob"/></filters></filterColumn></autoFilter>',
      ),
    )
    api.readBytes.mockResolvedValue(BOOK)
    render(XlsxEditor, { ...props, canEdit: false })
    await expect.poll(() => shown('C2')).toBe('60')
    await expect.element(page.getByTestId('xlsx-frozen-rows')).toBeInTheDocument()
    await expect
      .element(page.getByRole('button', { name: 'Column A is filtered: change the filter' }))
      .toBeInTheDocument()
    await page.getByRole('button', { name: 'Column A is filtered: change the filter' }).click()
    await expect.element(page.getByRole('checkbox', { name: 'bob' })).toBeChecked()
    await expect.element(page.getByRole('checkbox', { name: 'Alice' })).not.toBeChecked()
    await expect.element(page.getByRole('checkbox', { name: 'Alice' })).toBeDisabled()
    expect(page.getByTestId('xlsx-filter-ok').query()).toBeNull()
  })
})
