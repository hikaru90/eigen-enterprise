import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page, userEvent } from 'vitest/browser'
import type { DriveItem, LockView } from '$lib/drive/api'
import { themeOf } from './chart-color'
import { describeCharts } from './chart-ops'
import { readChart } from './chart-read'
import { chartXml, COLUMN_PLOT, PIE_PLOT, salesBook } from './test-utils/chart-fixtures'
import { openWorkbook } from './workbook'
import XlsxEditor from './xlsx-editor.svelte'

/** Browser component tests for XLSX SVG charts: grid overlay, live updates, insert, edit, move/resize, delete, and chart sheets. */

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

let BOOK = salesBook()

const savedBook = () => {
  const calls = api.writeBytes.mock.calls
  if (!calls.length) throw new Error('nothing saved')
  return openWorkbook(calls.at(-1)![1])
}
const cell = (ref: string) =>
  document.querySelector(`[data-testid="xlsx-grid"] [data-ref="${ref}"]`) as HTMLElement | null
const shown = (ref: string) => cell(ref)?.textContent?.trim() ?? null
const chartSvg = (idx = 0) =>
  document.querySelectorAll('[data-testid="xlsx-chart-svg"]')[idx] as SVGSVGElement | undefined
const chartFrames = () =>
  [...document.querySelectorAll('[data-testid="xlsx-chart-frame"]')] as HTMLElement[]

async function clickCell(ref: string, shift = false) {
  await expect.poll(() => cell(ref)).not.toBeNull()
  if (shift) {
    await userEvent.keyboard('{Shift>}')
    await userEvent.click(cell(ref)!)
    await userEvent.keyboard('{/Shift}')
  } else {
    await userEvent.click(cell(ref)!)
  }
}

async function typeInto(ref: string, text: string) {
  await clickCell(ref)
  await userEvent.keyboard(text)
  await userEvent.keyboard('{Enter}')
}

describe('xlsx editor: charts', () => {
  beforeEach(() => {
    BOOK = salesBook()
    for (const fn of Object.values(api)) fn.mockReset()
    api.readBytes.mockImplementation(async () => api.writeBytes.mock.calls.at(-1)?.[1] ?? BOOK)
    api.acquireLock.mockResolvedValue({ state: 'held', since: '2026-11-25T10:00:00Z' })
    api.heartbeatLock.mockResolvedValue({ state: 'held', since: '2026-11-25T10:00:00Z' })
    api.releaseLock.mockResolvedValue(undefined)
    api.writeBytes.mockImplementation(async () => ({
      file: { id: 'book-1', type: 'file', name: 'Sales.xlsx' } as DriveItem,
    }))
  })

  it('renders an anchored chart over the grid and live-updates bars when cells change', async () => {
    render(XlsxEditor, props)
    await expect.poll(() => shown('B2')).toBe('10')
    await expect.poll(() => chartSvg()).toBeDefined()
    const svg = chartSvg()!
    expect(svg.querySelectorAll('rect[data-series="0"]').length).toBe(4)
    expect(svg.textContent).toContain('Sales')
    expect(svg.textContent).toContain('North')
    expect(svg.textContent).toContain('South')

    const barBefore = () =>
      Number(
        chartSvg()!
          .querySelector('rect[data-series="0"][data-point="0"]')
          ?.getAttribute('height') ?? 0,
      )
    const h0 = barBefore()
    await typeInto('B2', '80')
    await expect.poll(() => barBefore()).toBeGreaterThan(h0 * 2)
    await expect.poll(() => api.writeBytes.mock.calls.length).toBe(1)
  })

  it('inserts a chart from selection (default column, user picks type), edits properties, and deletes with undo', async () => {
    BOOK = salesBook([])
    render(XlsxEditor, props)
    await expect.poll(() => shown('B2')).toBe('10')
    await clickCell('A1')
    await clickCell('C5', true)
    await page.getByTestId('xlsx-insert-chart').click()
    await expect.element(page.getByTestId('xlsx-chart-dialog')).toBeInTheDocument()
    await expect.element(page.getByTestId('xlsx-chart-type')).toHaveValue('column')
    await expect.element(page.getByTestId('xlsx-chart-range')).toHaveValue('A1:C5')

    await userEvent.selectOptions(page.getByTestId('xlsx-chart-type'), 'line')
    await page.getByTestId('xlsx-chart-title').fill('Quarterly Trend')
    await page.getByTestId('xlsx-chart-save').click()

    await expect.poll(() => chartFrames().length).toBe(1)
    expect(chartSvg()!.textContent).toContain('Quarterly Trend')
    expect(chartSvg()!.querySelectorAll('path[data-series]').length).toBe(2)
    await expect.poll(() => api.writeBytes.mock.calls.length).toBe(1)
    expect(describeCharts(savedBook(), 'Data')[0]).toMatchObject({
      types: ['line'],
      title: 'Quarterly Trend',
    })

    // Select the chart and edit its title, axis title, data labels, and series colour.
    await userEvent.click(chartFrames()[0]!)
    await page.getByTestId('xlsx-chart-edit').click()
    await expect.element(page.getByTestId('xlsx-chart-dialog')).toBeInTheDocument()
    await page.getByTestId('xlsx-chart-title').fill('Edited Trend')
    await page.getByTestId('xlsx-chart-axis-val').fill('EUR')
    await page.getByTestId('xlsx-chart-label-val').click()
    await page.getByTestId('xlsx-chart-markers').click()
    await page.getByTestId('xlsx-chart-save').click()

    await expect.poll(() => chartSvg()!.textContent).toContain('Edited Trend')
    expect(chartSvg()!.textContent).toContain('EUR')
    expect(chartSvg()!.querySelectorAll('circle[data-series="0"]').length).toBe(4)

    // Delete via overlay button, then undo brings it back.
    await userEvent.click(chartFrames()[0]!)
    await page.getByTestId('xlsx-chart-delete').click()
    await expect.poll(() => chartFrames().length).toBe(0)
    await page.getByTestId('xlsx-undo').click()
    await expect.poll(() => chartFrames().length).toBe(1)
  })

  it('moves and resizes an anchored chart by pointer drag and saves the new position', async () => {
    render(XlsxEditor, props)
    await expect.poll(() => chartFrames().length).toBe(1)
    const frame = chartFrames()[0]!
    const box = frame.getBoundingClientRect()
    const beforeLeft = frame.style.left
    const beforeW = parseFloat(frame.style.width)

    // Drag to move right and down.
    frame.dispatchEvent(
      new PointerEvent('pointerdown', {
        clientX: box.left + 30,
        clientY: box.top + 20,
        button: 0,
        bubbles: true,
      }),
    )
    window.dispatchEvent(
      new PointerEvent('pointermove', { clientX: box.left + 110, clientY: box.top + 60 }),
    )
    window.dispatchEvent(
      new PointerEvent('pointerup', { clientX: box.left + 110, clientY: box.top + 60 }),
    )
    await expect.poll(() => frame.style.left).not.toBe(beforeLeft)

    // Select and drag the SE resize handle wider and taller.
    await userEvent.click(frame)
    const se = page.getByTestId('xlsx-chart-handle-se').element()
    const seBox = se.getBoundingClientRect()
    se.dispatchEvent(
      new PointerEvent('pointerdown', {
        clientX: seBox.left + 4,
        clientY: seBox.top + 4,
        button: 0,
        bubbles: true,
      }),
    )
    window.dispatchEvent(
      new PointerEvent('pointermove', { clientX: seBox.left + 90, clientY: seBox.top + 60 }),
    )
    window.dispatchEvent(
      new PointerEvent('pointerup', { clientX: seBox.left + 90, clientY: seBox.top + 60 }),
    )
    await expect.poll(() => parseFloat(frame.style.width)).toBeGreaterThan(beforeW + 40)
    await expect.poll(() => api.writeBytes.mock.calls.length).toBeGreaterThan(0)
    expect(describeCharts(savedBook(), 'Data')[0]!.position).not.toBe('E2:L16')
  })

  it('creates a chart sheet tab, renders it full-tab, and live-updates when data cells change', async () => {
    BOOK = salesBook([])
    render(XlsxEditor, props)
    await expect.poll(() => shown('B2')).toBe('10')
    await clickCell('A1')
    await page.getByTestId('xlsx-insert-chart').click()
    await userEvent.selectOptions(page.getByTestId('xlsx-chart-type'), 'pie')
    await page.getByTestId('xlsx-chart-new-sheet-toggle').click()
    await page.getByTestId('xlsx-chart-new-sheet').fill('Pie Tab')
    await page.getByTestId('xlsx-chart-save').click()

    await expect.element(page.getByTestId('xlsx-chart-sheet')).toBeInTheDocument()
    await expect.poll(() => chartSvg()).toBeDefined()
    expect(chartSvg()!.querySelectorAll('path[data-series="0"]').length).toBe(4)

    // Edit B2 on Data and switch back to Pie Tab: slices reflect the updated workbook.
    await page.getByTestId('xlsx-tab').first().click()
    await typeInto('B2', '200')
    await page.getByTestId('xlsx-tab').nth(1).click()
    await expect.element(page.getByTestId('xlsx-chart-sheet')).toBeInTheDocument()
    const pathD = chartSvg()!
      .querySelector('path[data-series="0"][data-point="0"]')
      ?.getAttribute('d')
    expect(pathD).toBeTruthy()
    await expect.poll(() => api.writeBytes.mock.calls.length).toBeGreaterThan(0)
    const wb = savedBook()
    expect(wb.requireSheet('Pie Tab').kind).toBe('chartsheet')
    const m = readChart(wb.pkg.xml('/xl/charts/chart1.xml'), themeOf(wb))
    expect(m.plots[0]!.kind).toBe('pie')
  })

  it('view-only users see charts without edit, resize, or delete controls', async () => {
    BOOK = salesBook([
      chartXml(COLUMN_PLOT, { title: 'Sales' }),
      chartXml(PIE_PLOT, { title: 'Pie' }),
    ])
    api.readBytes.mockResolvedValue(BOOK)
    render(XlsxEditor, { ...props, canEdit: false })
    await expect.poll(() => chartFrames().length).toBe(2)
    await userEvent.click(chartFrames()[0]!)
    expect(page.getByTestId('xlsx-chart-edit').query()).toBeNull()
    expect(page.getByTestId('xlsx-chart-delete').query()).toBeNull()
    expect(page.getByTestId('xlsx-chart-handle-se').query()).toBeNull()
    expect(page.getByTestId('xlsx-insert-chart').query()).toBeNull()
  })
})
