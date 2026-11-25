import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page, userEvent } from 'vitest/browser'
import type { DriveItem, LockView } from '$lib/drive/api'
import { cfRulesOf } from './cond-format'
import { hyperlinksOf } from './hyperlinks'
import { listNames } from './names'
import { applyOp } from './ops'
import { sheetProtectionOf, workbookProtectionOf } from './protection'
import { cellKey } from './ref'
import { buildXlsx, fml, num, row, str } from './test-utils/build-xlsx'
import { validationsOf } from './validation'
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
}))
vi.mock('$lib/drive/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('$lib/drive/api')>()
  const { liveOverPlainApi } = await import('./test-utils/live-api')
  return { ...real, driveApi: { ...real.driveApi, ...api, ...liveOverPlainApi(api) } }
})

const props = {
  fileId: 'book-rules',
  name: 'Rules.xlsx',
  canEdit: true,
  heartbeatMs: 600_000,
  saveDelayMs: 20,
  idleMs: 600_000,
}

let BOOK = new Uint8Array()

function makeBaseBook(): Uint8Array {
  return buildXlsx({
    strings: ['Item', 'Score', 'Status', 'Alpha', 'Beta', 'Gamma'],
    definedNames:
      '<definedName name="_xlnm.Print_Area" localSheetId="0">Data!$A$1:$C$4</definedName>',
    sheets: [
      {
        name: 'Data',
        rows:
          row(1, str('A1', 0, 1) + str('B1', 1, 1) + str('C1', 2, 1)) +
          row(2, str('A2', 3) + num('B2', 100) + num('C2', -50)) +
          row(3, str('A3', 4) + num('B3', 50) + num('C3', 0)) +
          row(4, str('A4', 5) + num('B4', 10) + num('C4', 100)) +
          row(5, fml('B5', 'HYPERLINK("https://example.org","Docs")', 'Docs')),
      },
      {
        name: 'Target',
        rows: row(1, num('A1', 1)) + row(3, num('B3', 77)),
      },
    ],
  })
}

const savedBook = () => {
  const calls = api.writeBytes.mock.calls
  if (!calls.length) throw new Error('nothing saved')
  return openWorkbook(calls.at(-1)![1])
}
const cell = (ref: string) =>
  document.querySelector(`[data-testid="xlsx-grid"] [data-ref="${ref}"]`) as HTMLElement | null
const shown = (ref: string) => cell(ref)?.textContent?.trim() ?? null

async function clickCell(ref: string) {
  await expect.poll(() => cell(ref)).not.toBeNull()
  await userEvent.click(cell(ref)!)
}

async function typeInto(ref: string, text: string) {
  await clickCell(ref)
  await userEvent.keyboard(text)
  await userEvent.keyboard('{Enter}')
}

describe('xlsx editor: conditional formatting, validation, hyperlinks, names & protection', () => {
  beforeEach(() => {
    resetPlainLive(api)
    BOOK = makeBaseBook()
    for (const fn of Object.values(api)) fn.mockReset()
    api.readBytes.mockImplementation(async () => api.writeBytes.mock.calls.at(-1)?.[1] ?? BOOK)
    api.acquireLock.mockResolvedValue({ state: 'held', since: '2026-11-25T10:00:00Z' })
    api.heartbeatLock.mockResolvedValue({ state: 'held', since: '2026-11-25T10:00:00Z' })
    api.releaseLock.mockResolvedValue(undefined)
    api.writeBytes.mockImplementation(async () => ({
      file: { id: 'book-rules', type: 'file', name: 'Rules.xlsx' } as DriveItem,
    }))
  })

  it('renders colour scales, data bars (with negative axis) and icon sets, and edits rules in the panel', async () => {
    const wb = openWorkbook(BOOK)
    applyOp(wb, {
      op: 'cf_add',
      sheet: 'Data',
      range: 'B2:B4',
      rule: {
        type: 'colorScale',
        points: [
          { kind: 'min', color: '#F8696B' },
          { kind: 'percentile', value: '50', color: '#FFEB84' },
          { kind: 'max', color: '#63BE7B' },
        ],
      },
    })
    applyOp(wb, {
      op: 'cf_add',
      sheet: 'Data',
      range: 'C2:C4',
      rule: {
        type: 'dataBar',
        bar: {
          color: '#638EC6',
          negativeColor: '#FF0000',
          gradient: false,
          showValue: true,
          axis: 'automatic',
        },
      },
    })
    applyOp(wb, {
      op: 'cf_add',
      sheet: 'Data',
      range: 'B2:B4',
      rule: {
        type: 'iconSet',
        icons: { set: '3Arrows' },
      },
    })
    BOOK = wb.pkg.toBytes()

    render(XlsxEditor, props)
    await expect.poll(() => shown('B2')).toBe('100')

    // Colour scale interpolated fills (max = green, mid = yellow, min = red)
    expect(cell('B2')!.style.backgroundColor).toBe('rgb(99, 190, 123)')
    expect(cell('B3')!.style.backgroundColor).toBe('rgb(255, 235, 132)')
    expect(cell('B4')!.style.backgroundColor).toBe('rgb(248, 105, 107)')

    // Icon set SVG in each cell
    const b2Icon = cell('B2')!.querySelector('[data-testid="xlsx-cf-icon"]')
    const b4Icon = cell('B4')!.querySelector('[data-testid="xlsx-cf-icon"]')
    expect(b2Icon?.getAttribute('data-set')).toBe('3Arrows')
    expect(b2Icon?.getAttribute('data-index')).toBe('2')
    expect(b4Icon?.getAttribute('data-index')).toBe('0')

    // Data bars + axis + negative side
    const c2Bar = cell('C2')!.querySelector('[data-testid="xlsx-cf-bar"]')
    const c4Bar = cell('C4')!.querySelector('[data-testid="xlsx-cf-bar"]')
    expect(c2Bar?.getAttribute('data-negative')).toBe('true')
    expect(c4Bar?.getAttribute('data-negative')).toBeNull()
    expect(cell('C2')!.querySelector('[data-testid="xlsx-cf-axis"]')).not.toBeNull()

    // Open Rules panel and add a cellIs rule with Stop If True on B2:B4
    await page.getByTestId('xlsx-cf-open').click()
    await expect.element(page.getByTestId('xlsx-cf-panel')).toBeVisible()
    await expect.element(page.getByTestId('xlsx-cf-rule').first()).toBeVisible()

    await userEvent.fill(page.getByTestId('xlsx-cf-range').element() as HTMLInputElement, 'B2:B4')
    await page.getByTestId('xlsx-cf-type').selectOptions('cellIs')
    await page.getByTestId('xlsx-cf-operator').selectOptions('greaterThan')
    await userEvent.fill(page.getByTestId('xlsx-cf-val1').element() as HTMLInputElement, '80')
    await page.getByTestId('xlsx-cf-bold').click()
    await page.getByTestId('xlsx-cf-stop').click()
    await page.getByTestId('xlsx-cf-submit').click()

    // Added rule lands at priority 1 with Stop If True: overrides fill & bold, stops iconSet underneath on B2
    await expect.poll(() => cell('B2')!.style.fontWeight).toBe('600')
    expect(cell('B2')!.style.backgroundColor).toBe('rgb(255, 199, 206)')
    expect(cell('B2')!.querySelector('[data-testid="xlsx-cf-icon"]')).toBeNull()

    // Move priority 1 down -> iconSet moves to priority 1; delete the added rule afterwards
    await page.getByTestId('xlsx-cf-down').first().click()
    await expect
      .poll(() => cell('B2')!.querySelector('[data-testid="xlsx-cf-icon"]'))
      .not.toBeNull()

    // Delete priority 2 (our added rule)
    await page.getByTestId('xlsx-cf-delete').nth(1).click()
    await expect
      .poll(() => api.writeBytes.mock.calls.length > 0 && cfRulesOf(savedBook(), 'Data').length)
      .toBe(3)
  })

  it('shows data validation dropdown, input prompt, stop & warning alerts, and invalid circles', async () => {
    render(XlsxEditor, props)
    await expect.poll(() => shown('A2')).toBe('Alpha')

    // Set a list validation with input message on A2:A3
    await clickCell('A2')
    await page.getByTestId('xlsx-dv-open').click()
    await expect.element(page.getByTestId('xlsx-dv-dialog')).toBeVisible()
    await userEvent.fill(page.getByTestId('xlsx-dv-range').element() as HTMLInputElement, 'A2:A3')
    await page.getByTestId('xlsx-dv-type').selectOptions('list')
    await userEvent.fill(
      page.getByTestId('xlsx-dv-source').element() as HTMLInputElement,
      'Yes, No, Maybe',
    )
    await userEvent.fill(
      page.getByTestId('xlsx-dv-input-title').element() as HTMLInputElement,
      'Pick one',
    )
    await userEvent.fill(
      page.getByTestId('xlsx-dv-input-msg').element() as HTMLInputElement,
      'Choose a status',
    )
    await page.getByTestId('xlsx-dv-save').click()

    await expect.poll(() => cell('A2')?.getAttribute('data-has-dropdown')).toBe('true')
    await expect.element(page.getByTestId('xlsx-dv-prompt')).toHaveTextContent('Pick one')
    await expect.element(page.getByTestId('xlsx-dv-prompt')).toHaveTextContent('Choose a status')

    // Open dropdown and select "Maybe"
    await page.getByTestId('xlsx-dv-dropdown-btn').click()
    await expect.element(page.getByTestId('xlsx-dv-menu')).toBeVisible()
    await page.getByTestId('xlsx-dv-option').nth(2).click()
    await expect.poll(() => shown('A2')).toBe('Maybe')

    // Set a whole-number Stop rule on D2 (between 1 and 10)
    await clickCell('D2')
    await page.getByTestId('xlsx-dv-open').click()
    await page.getByTestId('xlsx-dv-type').selectOptions('whole')
    await page.getByTestId('xlsx-dv-operator').selectOptions('between')
    await userEvent.fill(page.getByTestId('xlsx-dv-val1').element() as HTMLInputElement, '1')
    await userEvent.fill(page.getByTestId('xlsx-dv-val2').element() as HTMLInputElement, '10')
    await userEvent.fill(
      page.getByTestId('xlsx-dv-error-msg').element() as HTMLInputElement,
      'Must be 1..10',
    )
    await page.getByTestId('xlsx-dv-save').click()

    // Invalid entry triggers Stop alert and refuses commit; Retry re-opens edit
    await typeInto('D2', '99')
    await expect.element(page.getByTestId('xlsx-dv-alert')).toHaveTextContent('Must be 1..10')
    expect(shown('D2')).toBe('')
    await page.getByTestId('xlsx-dv-retry').click()
    await expect.element(page.getByTestId('xlsx-cell-editor')).toBeVisible()
    // Retry selects the rejected entry (as Excel): typing replaces it.
    await userEvent.keyboard('7{Enter}')
    await expect.poll(() => shown('D2')).toBe('7')

    // Toggle Circle invalid data: A3 currently holds "Beta" (not in Yes,No,Maybe)
    await page.getByTestId('xlsx-dv-circles-toggle').click()
    await expect.poll(() => cell('A3')?.getAttribute('data-invalid')).toBe('true')
    expect(cell('A3')!.querySelector('[data-testid="xlsx-dv-invalid"]')).not.toBeNull()
    expect(cell('A2')?.getAttribute('data-invalid')).toBeNull()

    await expect
      .poll(() => api.writeBytes.mock.calls.length > 0 && validationsOf(savedBook(), 'Data').length)
      .toBe(2)
  })

  it('adds, follows, edits and removes hyperlinks, plus shows HYPERLINK() formula links', async () => {
    render(XlsxEditor, props)
    await expect.poll(() => shown('B5')).toBe('Docs')

    // HYPERLINK() formula cell shows openable external link without chip edit/remove
    await clickCell('B5')
    await expect.element(page.getByTestId('xlsx-link-popover')).toBeVisible()
    const formulaLink = page.getByTestId('xlsx-link-open').element() as HTMLAnchorElement
    expect(formulaLink.tagName).toBe('A')
    expect(formulaLink.href).toBe('https://example.org/')
    expect(formulaLink.getAttribute('rel')).toBe('noopener noreferrer')
    expect(page.getByTestId('xlsx-link-chip-edit').query()).toBeNull()

    // Add an internal place link on D3 -> Target!B3
    await clickCell('D3')
    await page.getByTestId('xlsx-link-btn').click()
    await expect.element(page.getByTestId('xlsx-link-dialog')).toBeVisible()
    await userEvent.fill(
      page.getByTestId('xlsx-link-target').element() as HTMLInputElement,
      'Target!B3',
    )
    await userEvent.fill(page.getByTestId('xlsx-link-text').element() as HTMLInputElement, 'Jump')
    await userEvent.fill(
      page.getByTestId('xlsx-link-tooltip').element() as HTMLInputElement,
      'Go to Target',
    )
    await page.getByTestId('xlsx-link-save').click()

    await expect.poll(() => shown('D3')).toBe('Jump')
    expect(cell('D3')!.style.textDecorationLine || cell('D3')!.style.textDecoration).toContain(
      'underline',
    )
    await expect.element(page.getByTestId('xlsx-link-popover')).toHaveTextContent('Target!B3')

    // Click Open to navigate to Target!B3
    await page.getByTestId('xlsx-link-open').click()
    await expect.poll(() => shown('B3')).toBe('77')
    await expect.element(page.getByTestId('xlsx-ref')).toHaveValue('B3')

    // Switch back to Data and edit D3 to external URL, then remove hyperlink keeping text
    await page.getByTestId('xlsx-tab').first().click()
    await clickCell('D3')
    await page.getByTestId('xlsx-link-chip-edit').click()
    await userEvent.fill(
      page.getByTestId('xlsx-link-target').element() as HTMLInputElement,
      'https://example.com',
    )
    await page.getByTestId('xlsx-link-save').click()

    await expect
      .poll(() => (page.getByTestId('xlsx-link-open').element() as HTMLAnchorElement).href)
      .toBe('https://example.com/')
    await page.getByTestId('xlsx-link-chip-remove').click()
    await expect.poll(() => page.getByTestId('xlsx-link-popover').query()).toBeNull()
    expect(shown('D3')).toBe('Jump')
    await expect
      .poll(() => api.writeBytes.mock.calls.length > 0 && hyperlinksOf(savedBook(), 'Data').length)
      .toBe(0)
  })

  it('adds, renames and deletes defined names in Name Manager while keeping built-ins read-only', async () => {
    render(XlsxEditor, props)
    await expect.poll(() => shown('B2')).toBe('100')

    await clickCell('B2')
    await page.getByTestId('xlsx-names-open').click()
    await expect.element(page.getByTestId('xlsx-names-dialog')).toBeVisible()
    // Built-in _xlnm.Print_Area is visible and stays read-only on click
    await expect.element(page.getByTestId('xlsx-names-list')).toHaveTextContent('_xlnm.Print_Area')
    await page.getByTestId('xlsx-name-row').first().click()
    expect((page.getByTestId('xlsx-name-input').element() as HTMLInputElement).value).toBe('')

    // Add TopScore = Data!$B$2
    await userEvent.fill(
      page.getByTestId('xlsx-name-input').element() as HTMLInputElement,
      'TopScore',
    )
    await userEvent.fill(
      page.getByTestId('xlsx-name-refers').element() as HTMLInputElement,
      '=Data!$B$2',
    )
    await page.getByTestId('xlsx-name-save').click()
    await expect.element(page.getByTestId('xlsx-names-list')).toHaveTextContent('TopScore')
    await page.getByTestId('xlsx-names-close').click()

    // Use the defined name in D4
    await typeInto('D4', '=TopScore*2')
    await expect.poll(() => shown('D4')).toBe('200')

    // Rename TopScore -> BestScore and verify formula rewrites and still evaluates
    await page.getByTestId('xlsx-names-open').click()
    await page.getByTestId('xlsx-name-row').nth(1).click()
    await userEvent.fill(
      page.getByTestId('xlsx-name-input').element() as HTMLInputElement,
      'BestScore',
    )
    await page.getByTestId('xlsx-name-save').click()
    await expect.element(page.getByTestId('xlsx-names-list')).toHaveTextContent('BestScore')

    // Delete BestScore -> D4 becomes #NAME?
    await page.getByTestId('xlsx-name-row').nth(1).click()
    await page.getByTestId('xlsx-name-delete').click()
    await page.getByTestId('xlsx-names-close').click()
    await expect.poll(() => shown('D4')).toBe('#NAME?')

    await expect
      .poll(
        () =>
          api.writeBytes.mock.calls.length > 0 &&
          listNames(savedBook())
            .map((n) => n.name)
            .join(),
      )
      .toBe('_xlnm.Print_Area')
  })

  it('protects sheet and workbook structure with passwords and refuses locked edits explicitly', async () => {
    render(XlsxEditor, props)
    await expect.poll(() => shown('B2')).toBe('100')

    // Unlock B2 first
    await clickCell('B2')
    await page.getByTestId('xlsx-protect-open').click()
    await expect.element(page.getByTestId('xlsx-protect-dialog')).toBeVisible()
    await page.getByTestId('xlsx-cell-locked').click()
    await page.getByTestId('xlsx-cell-prot-apply').click()

    // Protect Data sheet with password
    await userEvent.fill(
      page.getByTestId('xlsx-protect-sheet-pw').element() as HTMLInputElement,
      's3cret',
    )
    await page.getByTestId('xlsx-protect-sheet-btn').click()
    await expect
      .element(page.getByTestId('xlsx-protect-sheet-status'))
      .toHaveTextContent('Protected')

    // Protect workbook structure
    await userEvent.fill(
      page.getByTestId('xlsx-protect-wb-pw').element() as HTMLInputElement,
      'wbpass',
    )
    await page.getByTestId('xlsx-protect-wb-btn').click()
    await expect.element(page.getByTestId('xlsx-protect-wb-status')).toHaveTextContent('Protected')
    await page.getByTestId('xlsx-protect-close').click()

    await expect.element(page.getByTestId('xlsx-protect-open')).toHaveTextContent('Protected')

    // Locked cell A2 refuses typing with an explicit failure message
    await clickCell('A2')
    await userEvent.keyboard('Hack')
    await expect.element(page.getByTestId('xlsx-failure')).toHaveTextContent(/protected/i)
    expect(page.getByTestId('xlsx-cell-editor').query()).toBeNull()
    expect(shown('A2')).toBe('Alpha')

    // Empty locked cell D2 refuses Delete
    await clickCell('D2')
    await userEvent.keyboard('{Delete}')
    await expect.element(page.getByTestId('xlsx-failure')).toHaveTextContent(/protected/i)

    // Formula bar refuses locked cell focus
    await clickCell('A2')
    ;(page.getByTestId('xlsx-formula').element() as HTMLInputElement).focus()
    await expect.element(page.getByTestId('xlsx-failure')).toHaveTextContent(/protected/i)

    // Unlocked cell B2 CAN be edited
    await typeInto('B2', '250')
    await expect.poll(() => shown('B2')).toBe('250')

    // Protected workbook refuses adding a sheet
    await page.getByTestId('xlsx-add-sheet').click()
    await expect.element(page.getByTestId('xlsx-failure')).toHaveTextContent(/protected/i)

    // Wrong password fails unprotect; right password unlocks sheet
    await page.getByTestId('xlsx-protect-open').click()
    await userEvent.fill(
      page.getByTestId('xlsx-unprotect-sheet-pw').element() as HTMLInputElement,
      'wrong',
    )
    await page.getByTestId('xlsx-unprotect-sheet-btn').click()
    await expect.element(page.getByTestId('xlsx-protect-error')).toHaveTextContent(/password/i)

    await userEvent.fill(
      page.getByTestId('xlsx-unprotect-sheet-pw').element() as HTMLInputElement,
      's3cret',
    )
    await page.getByTestId('xlsx-unprotect-sheet-btn').click()
    await expect
      .element(page.getByTestId('xlsx-protect-sheet-status'))
      .toHaveTextContent('Not protected')
    await page.getByTestId('xlsx-protect-close').click()

    // Now A2 can be edited
    await typeInto('A2', 'Updated')
    await expect.poll(() => shown('A2')).toBe('Updated')
    await expect
      .poll(
        () =>
          api.writeBytes.mock.calls.length > 0 &&
          savedBook().sheet('Data').cells.get(cellKey(1, 0))?.value,
      )
      .toBe('Updated')
    const saved = savedBook()
    expect(saved.sheet('Data').cells.get(cellKey(1, 0))?.value).toBe('Updated')
    expect(sheetProtectionOf(saved, 'Data')).toBeNull()
    expect(workbookProtectionOf(saved)?.structure).toBe(true)
  })
})
