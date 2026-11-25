import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import { DriveApiError, type DriveItem } from '$lib/drive/api'
import LegacySheetViewer from './legacy-sheet-viewer.svelte'
import { odsBook, xlsBook } from './test-utils/legacy-fixtures'

const { gotoMock, api } = vi.hoisted(() => ({
  gotoMock: vi.fn(),
  api: {
    readBytes: vi.fn<(id: string) => Promise<Uint8Array>>(),
    makeXlsxCopy:
      vi.fn<(id: string) => Promise<{ file: DriveItem; source: DriveItem; notKept: string[] }>>(),
  },
}))
vi.mock('$app/navigation', () => ({ goto: gotoMock, beforeNavigate: vi.fn() }))
vi.mock('$app/paths', () => ({ base: '', resolve: (path: string) => path }))
vi.mock('$lib/drive/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('$lib/drive/api')>()
  return { ...real, driveApi: { ...real.driveApi, ...api } }
})

const props = {
  fileId: 'ods-1',
  name: 'budget.ods',
  kind: 'ods' as const,
  canEdit: true,
  heartbeatMs: 600_000,
}
const cell = (ref: string) =>
  document.querySelector(`[data-testid="xlsx-grid"] [data-ref="${ref}"]`)?.textContent?.trim() ??
  null
const copy: DriveItem = {
  type: 'file',
  id: 'xlsx-9',
  name: 'budget.xlsx',
  parentId: null,
  ownerId: 'u1',
  updatedAt: '2026-11-25T10:00:00Z',
  trashedAt: null,
}

describe('.xls / .ods in the Drive: read-only through a conversion', () => {
  beforeEach(() => vi.resetAllMocks())

  it('shows the converted sheets in the grid, view only, and says what a copy does not keep', async () => {
    api.readBytes.mockResolvedValue(odsBook())
    render(LegacySheetViewer, props)
    await expect.poll(() => cell('B4')).toBe('1650')
    expect(cell('A4')).toBe('Total')
    await expect
      .element(page.getByTestId('legacy-sheet-banner'))
      .toHaveTextContent('OpenDocument spreadsheet (.ods)')
    await expect.element(page.getByTestId('xlsx-view-only')).toBeInTheDocument()
    await expect
      .element(page.getByTestId('legacy-sheet-not-kept'))
      .toHaveTextContent('cell formatting')
    await expect.element(page.getByTestId('legacy-sheet-not-kept')).toHaveTextContent('macros')
    expect(api.readBytes).toHaveBeenCalledWith('ods-1')
  })

  it('Make an editable .xlsx copy saves it next to the original (drive.make_xlsx_copy) and opens it', async () => {
    api.readBytes.mockResolvedValue(await xlsBook())
    api.makeXlsxCopy.mockResolvedValue({
      file: copy,
      source: { ...copy, id: 'xls-1' },
      notKept: [],
    })
    render(LegacySheetViewer, { ...props, fileId: 'xls-1', name: 'budget.xls', kind: 'xls' })
    await expect.poll(() => cell('A2')).toBe('Rent')
    await expect
      .element(page.getByTestId('legacy-sheet-banner'))
      .toHaveTextContent('Excel 97–2003 workbook (.xls)')
    await page.getByTestId('legacy-sheet-copy').click()
    expect(api.makeXlsxCopy).toHaveBeenCalledWith('xls-1')
    await expect.poll(() => gotoMock.mock.calls.at(-1)?.[0]).toBe('/drive/file/xlsx-9')
  })

  it('a refused copy shows the server’s reason; view-only people get no copy button', async () => {
    api.readBytes.mockResolvedValue(odsBook())
    api.makeXlsxCopy.mockRejectedValue(
      new DriveApiError('You can’t add files to that folder.', 403, null, null),
    )
    const view = render(LegacySheetViewer, props)
    await page.getByTestId('legacy-sheet-copy').click()
    await expect
      .element(page.getByTestId('legacy-sheet-failure'))
      .toHaveTextContent('You can’t add files to that folder.')
    expect(gotoMock).not.toHaveBeenCalled()
    view.unmount()
    render(LegacySheetViewer, { ...props, canEdit: false })
    await expect.poll(() => cell('B4')).toBe('1650')
    expect(page.getByTestId('legacy-sheet-copy').elements()).toHaveLength(0)
  })

  it('a file that does not convert says why', async () => {
    api.readBytes.mockResolvedValue(new TextEncoder().encode('not a spreadsheet'))
    render(LegacySheetViewer, props)
    await expect.element(page.getByText(/not a ZIP package/)).toBeInTheDocument()
  })
})
