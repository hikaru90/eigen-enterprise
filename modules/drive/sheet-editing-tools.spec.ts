import type { Actor } from './service'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { delegatedPrincipal } from '$lib/kernel/principals'
import { pageSetupOf, viewOptionsOf } from '$lib/office/xlsx/print'
import type { ExportPdfDeps, PdfPage } from '$lib/office/xlsx/print-pdf'
import { BrowserUnavailableError } from '$lib/office/xlsx/print-pdf'
import { cellKey } from '$lib/office/xlsx/ref'
import { richCells } from '$lib/office/xlsx/rich-text'
import { outlineOf } from '$lib/office/xlsx/rows-cols'
import { sheetTabColor } from '$lib/office/xlsx/sheet-tabs'
import { buildXlsx, fml, num, row, str } from '$lib/office/xlsx/test-utils/build-xlsx'
import { openWorkbook } from '$lib/office/xlsx/workbook'
import { memoryEditLockStore } from './locks'
import { DRIVE_SHEET_TOOL_NAMES, DRIVE_SHEET_WRITE_TOOLS, DRIVE_TOOL_NAMES } from './manifest'
import { memoryDriveAccess } from './memory-access'
import { createDriveService, DriveError } from './service'
import { diskBlobStore } from './storage'
import { memoryDriveStore } from './store'
import { createDriveTools } from './tools'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

const alice: Actor = { kind: 'user', userId: 'alice' }
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

const sampleBook = () =>
  buildXlsx({
    strings: ['Item', 'Amount', 'Apples', 'Oranges', 'Bananas', 'Note'],
    sheets: [
      {
        name: 'Data',
        rows:
          row(1, str('A1', 0) + str('B1', 1) + str('C1', 5)) +
          row(2, str('A2', 2) + num('B2', 10, 2) + fml('C2', 'B2*2', 20)) +
          row(3, str('A3', 3) + num('B3', 20, 2) + fml('C3', 'B3*2', 40)) +
          row(4, str('A4', 4) + num('B4', 30, 2) + fml('C4', 'SUM(B2:B3)', 30)),
      },
      {
        name: 'Summary',
        rows: row(1, str('A1', 0) + fml('B1', 'Data!B4', 30)),
      },
    ],
  })

async function setup(pdfDeps?: ExportPdfDeps) {
  const dir = await mkdtemp(join(tmpdir(), 'drive-sheet-editing-'))
  dirs.push(dir)
  const drive = createDriveService({
    store: memoryDriveStore(),
    blobs: diskBlobStore(dir, Buffer.alloc(32, 7)),
    access: memoryDriveAccess({ users: { alice: { role: 'member' } } }),
    maxUploadBytes: 1 << 22,
    locks: memoryEditLockStore(),
  })
  const tools = createDriveTools({ service: async () => drive, pdfDeps })
  const tool = (n: string) => tools.find((t) => t.name === n)!
  const as = (id: string) => ({
    principal: delegatedPrincipal({ id, roles: ['member'] }, 'orchestrator'),
    requestId: 'r',
  })
  const f = await drive.upload(
    alice,
    null,
    { name: 'report.xlsx', bytes: sampleBook(), mime: XLSX },
    'fail',
  )
  const reread = async () => openWorkbook((await drive.readFile(alice, f.id)).bytes)
  return { drive, tool, as, f, reread }
}

describe('drive.sheet_* everyday editing tools', () => {
  it('registers all 7 tools with proper manifest arrays, audit classes, and activity strings', async () => {
    const { tool } = await setup()
    const writes = [
      'drive.sheet_copy_range',
      'drive.sheet_fill',
      'drive.sheet_find_replace',
      'drive.sheet_merge',
      'drive.sheet_rows_cols',
      'drive.sheet_tab',
    ]
    for (const n of writes) {
      expect(DRIVE_SHEET_TOOL_NAMES).toContain(n)
      expect(DRIVE_SHEET_WRITE_TOOLS).toContain(n)
      expect(DRIVE_TOOL_NAMES).toContain(n)
      expect(tool(n)).toMatchObject({
        module: 'drive',
        auditClass: 'mutate',
        approvalRisk: 'internal',
      })
    }
    expect(DRIVE_SHEET_TOOL_NAMES).toContain('drive.sheet_export_pdf')
    expect(DRIVE_SHEET_WRITE_TOOLS).not.toContain('drive.sheet_export_pdf')
    expect(tool('drive.sheet_export_pdf')).toMatchObject({
      module: 'drive',
      auditClass: 'read',
    })

    const out = { file: { name: 'report.xlsx' } }
    expect(
      tool('drive.sheet_copy_range').activity!(
        {
          file_id: 'f',
          source_sheet: 'Data',
          source_range: 'A1:B2',
          target_sheet: 'Summary',
          to: 'D1',
        },
        out,
      ),
    ).toBe('Copied Data!A1:B2 to Summary!D1 in report.xlsx in Drive')
    expect(
      tool('drive.sheet_fill').activity!(
        { file_id: 'f', sheet: 'Data', source: 'A1:A2', target: 'A1:A5' },
        out,
      ),
    ).toBe('Filled A1:A5 from A1:A2 in Data of report.xlsx in Drive')
    expect(
      tool('drive.sheet_find_replace').activity!(
        { file_id: 'f', find: 'Apples', replace: 'Pears', sheet: 'Data' },
        out,
      ),
    ).toBe('Replaced “Apples” in Data of report.xlsx in Drive')
  })

  it('drive.sheet_copy_range supports copy, paste special transpose/values, cross-sheet and cut', async () => {
    const { drive, tool, as, f, reread } = await setup()
    // Cross-sheet transpose values-only copy
    await tool('drive.sheet_copy_range').handler(as('alice'), {
      file_id: f.id,
      source_sheet: 'Data',
      source_range: 'A2:B3',
      target_sheet: 'Summary',
      to: 'A3',
      mode: 'values',
      transpose: true,
    })
    let wb = await reread()
    expect(wb.sheet('Summary').cells.get(cellKey(2, 0))?.value).toBe('Apples')
    expect(wb.sheet('Summary').cells.get(cellKey(2, 1))?.value).toBe('Oranges')
    expect(wb.sheet('Summary').cells.get(cellKey(3, 0))?.value).toBe(10)
    expect(wb.sheet('Summary').cells.get(cellKey(3, 1))?.value).toBe(20)

    // Cut B4:C4 on Data -> D4:E4, verify value, formula, and incoming ref in Summary!B1 -> Data!D4
    await tool('drive.sheet_copy_range').handler(as('alice'), {
      file_id: f.id,
      source_sheet: 'Data',
      source_range: 'B4:C4',
      to: 'D4',
      cut: true,
    })
    wb = await reread()
    expect(wb.sheet('Data').cells.get(cellKey(3, 1))).toBeUndefined()
    expect(wb.sheet('Data').cells.get(cellKey(3, 2))).toBeUndefined()
    expect(wb.sheet('Data').cells.get(cellKey(3, 3))?.value).toBe(30)
    expect(wb.sheet('Data').cells.get(cellKey(3, 4))?.formula).toBe('SUM(B2:B3)')
    expect(wb.sheet('Summary').cells.get(cellKey(0, 1))?.formula).toBe('Data!D4')

    // Copy from another workbook fails on cut: true
    const other = await drive.upload(
      alice,
      null,
      { name: 'src.xlsx', bytes: sampleBook(), mime: XLSX },
      'fail',
    )
    await expect(
      tool('drive.sheet_copy_range').handler(as('alice'), {
        file_id: f.id,
        source_file_id: other.id,
        source_sheet: 'Data',
        source_range: 'A1:B2',
        to: 'E1',
        cut: true,
      }),
    ).rejects.toThrow(/same workbook/)
  })

  it('drive.sheet_fill extends numeric series and formulas and accepts custom lists', async () => {
    const { tool, as, f, reread } = await setup()
    await tool('drive.sheet_write').handler(as('alice'), {
      file_id: f.id,
      sheet: 'Data',
      cells: [{ ref: 'E1', value: 'Gold' }],
    })
    await tool('drive.sheet_fill').handler(as('alice'), {
      file_id: f.id,
      sheet: 'Data',
      source: 'B2:B3',
      target: 'B2:B5',
    })
    await tool('drive.sheet_fill').handler(as('alice'), {
      file_id: f.id,
      sheet: 'Data',
      source: 'E1',
      target: 'E1:E3',
      custom_lists: [['Bronze', 'Silver', 'Gold', 'Platinum']],
    })
    const wb = await reread()
    expect(wb.sheet('Data').cells.get(cellKey(3, 1))?.value).toBe(30)
    expect(wb.sheet('Data').cells.get(cellKey(4, 1))?.value).toBe(40)
    expect(wb.sheet('Data').cells.get(cellKey(1, 4))?.value).toBe('Platinum')
    expect(wb.sheet('Data').cells.get(cellKey(2, 4))?.value).toBe('Bronze')
  })

  it('drive.sheet_find_replace finds without writing when replace is omitted, and replaces on request', async () => {
    const { drive, tool, as, f, reread } = await setup()
    const revsBefore = (await drive.listRevisions(alice, f.id)).length
    const search = (await tool('drive.sheet_find_replace').handler(as('alice'), {
      file_id: f.id,
      find: '*es',
      sheet: 'Data',
    })) as { count: number; matches: Array<{ ref: string }>; revision: null }
    expect(search.revision).toBeNull()
    expect(search.count).toBe(2)
    expect(search.matches.map((m) => m.ref)).toEqual(['A2', 'A3'])
    expect(await drive.listRevisions(alice, f.id)).toHaveLength(revsBefore)

    const rep = (await tool('drive.sheet_find_replace').handler(as('alice'), {
      file_id: f.id,
      find: 'Apples',
      replace: 'Pears',
      sheet: 'Data',
    })) as { replaced: number }
    expect(rep.replaced).toBe(1)
    expect((await reread()).sheet('Data').cells.get(cellKey(1, 0))?.value).toBe('Pears')
  })

  it('drive.sheet_merge handles merges with loss refusal, clear, decimals, and rich text', async () => {
    const { tool, as, f, reread } = await setup()
    // Merging A1:C1 drops B1 & C1 values -> refuses until accept_losses: true
    await expect(
      tool('drive.sheet_merge').handler(as('alice'), {
        file_id: f.id,
        sheet: 'Data',
        range: 'A1:C1',
        mode: 'center',
      }),
    ).rejects.toThrow(/Accept the losses/)

    await tool('drive.sheet_merge').handler(as('alice'), {
      file_id: f.id,
      sheet: 'Data',
      range: 'A1:C1',
      mode: 'center',
      accept_losses: true,
      shift_decimals: 1,
      rich_text: {
        ref: 'A2',
        runs: [
          { text: 'Fresh ', bold: true },
          { text: 'Apples', color: '#008000' },
        ],
      },
    })
    await tool('drive.sheet_merge').handler(as('alice'), {
      file_id: f.id,
      sheet: 'Data',
      range: 'B2:B2',
      shift_decimals: 1,
    })
    let wb = await reread()
    expect(wb.sheet('Data').merges).toEqual([{ top: 0, left: 0, bottom: 0, right: 2 }])
    expect(wb.styles().xf(wb.sheet('Data').cells.get(cellKey(1, 1))!.style).numFmt).toBe('0.0')
    expect(richCells(wb, 'Data').get(cellKey(1, 0))).toEqual([
      { text: 'Fresh ', bold: true },
      { text: 'Apples', color: '#008000' },
    ])

    await tool('drive.sheet_merge').handler(as('alice'), {
      file_id: f.id,
      sheet: 'Data',
      range: 'A1:C1',
      mode: 'unmerge',
      clear: 'all',
    })
    wb = await reread()
    expect(wb.sheet('Data').merges).toEqual([])
    expect(wb.sheet('Data').cells.get(cellKey(0, 0))).toBeUndefined()
  })

  it('drive.sheet_rows_cols hides, groups, collapses, and autofits', async () => {
    const { tool, as, f, reread } = await setup()
    const res = (await tool('drive.sheet_rows_cols').handler(as('alice'), {
      file_id: f.id,
      sheet: 'Data',
      changes: [
        { action: 'hide_columns', from: 'C', hidden: true },
        { action: 'group_rows', from: 2, to: 3 },
        { action: 'collapse_rows', from: 2, to: 3, collapsed: true },
        { action: 'autofit_columns', from: 'A', to: 'B' },
      ],
    })) as { outline: ReturnType<typeof outlineOf> }
    expect(res.outline.rows).toHaveLength(1)
    expect(res.outline.rows[0]?.collapsed).toBe(true)
    const wb = await reread()
    expect(wb.sheet('Data').cols.find((c) => c.min === 2)?.hidden).toBe(true)
    expect(wb.sheet('Data').rows.get(1)?.hidden).toBe(true)
    expect(outlineOf(wb, 'Data').rows).toHaveLength(1)
  })

  it('drive.sheet_tab reorders, colours, hides, duplicates, and saves view + page setup', async () => {
    const { tool, as, f, reread } = await setup()
    await tool('drive.sheet_tab').handler(as('alice'), {
      action: 'set_sheet_color',
      file_id: f.id,
      sheet: 'Data',
      color: '#1F4E79',
    })
    await tool('drive.sheet_tab').handler(as('alice'), {
      action: 'duplicate_sheet',
      file_id: f.id,
      sheet: 'Data',
      name: 'Copy',
      position: 2,
    })
    await tool('drive.sheet_tab').handler(as('alice'), {
      action: 'set_view_options',
      file_id: f.id,
      sheet: 'Copy',
      show_gridlines: false,
      zoom_scale: 125,
    })
    await tool('drive.sheet_tab').handler(as('alice'), {
      action: 'set_page_setup',
      file_id: f.id,
      sheet: 'Copy',
      orientation: 'landscape',
      fit_to_width: 1,
      repeat_rows: '1:1',
    })
    const wb = await reread()
    expect(wb.sheets().map((s) => s.name)).toEqual(['Data', 'Copy', 'Summary'])
    expect(sheetTabColor(wb, 'Data')).toBe('#1F4E79')
    expect(viewOptionsOf(wb, 'Copy')).toMatchObject({ showGridlines: false, zoomScale: 125 })
    expect(pageSetupOf(wb, 'Copy')).toMatchObject({
      orientation: 'landscape',
      fitToWidth: 1,
      repeatRows: '1:1',
    })
  })

  it('drive.sheet_export_pdf renders via Chromium capability and fails loud when Chromium is unavailable', async () => {
    let seenHtml = ''
    const fakeLaunch = async () => ({
      async newPage(): Promise<PdfPage> {
        return {
          async route() {},
          async setContent(html: string) {
            seenHtml = html
          },
          async pdf() {
            return Buffer.from('%PDF-1.4\n%%EOF\n')
          },
        }
      },
      async close() {},
    })
    const ok = await setup({
      browser: { executablePath: () => '/usr/bin/fake-chromium', isExecutable: async () => true },
      launch: fakeLaunch,
    })
    const pdf = (await ok.tool('drive.sheet_export_pdf').handler(ok.as('alice'), {
      file_id: ok.f.id,
      sheet: 'Data',
      orientation: 'landscape',
    })) as { filename: string; mime: string; sizeBytes: number; sheets: string[]; dataB64: string }
    expect(pdf.filename).toBe('report.pdf')
    expect(pdf.mime).toBe('application/pdf')
    expect(pdf.sheets).toEqual(['Data'])
    expect(Buffer.from(pdf.dataB64, 'base64').toString()).toContain('%PDF-1.4')
    expect(seenHtml).toContain('Apples')
    expect(seenHtml).toContain('landscape')

    const missing = await setup({
      browser: {
        executablePath: () => null,
        isExecutable: async () => {
          throw new BrowserUnavailableError('no chromium installed')
        },
      },
    })
    await expect(
      missing
        .tool('drive.sheet_export_pdf')
        .handler(missing.as('alice'), { file_id: missing.f.id }),
    ).rejects.toSatisfy((err: unknown) => err instanceof DriveError && err.code === 'unavailable')
  })
})
