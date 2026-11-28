import type { Actor } from './service'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { delegatedPrincipal } from '$lib/kernel/principals'
import { createCalc } from '$lib/office/xlsx/calc'
import { readSheetPivots } from '$lib/office/xlsx/pivot'
import { readSheetTables } from '$lib/office/xlsx/tables'
import { buildXlsx, num, row, str } from '$lib/office/xlsx/test-utils/build-xlsx'
import { openWorkbook } from '$lib/office/xlsx/workbook'
import { memoryEditLockStore } from './locks'
import { memoryDriveAccess } from './memory-access'
import { createDriveService } from './service'
import { diskBlobStore } from './storage'
import { memoryDriveStore } from './store'
import { createDriveTools } from './tools'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

const alice: Actor = { kind: 'user', userId: 'alice' }
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

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

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'drive-sheet-pivot-'))
  dirs.push(dir)
  const drive = createDriveService({
    store: memoryDriveStore(),
    blobs: diskBlobStore(dir, Buffer.alloc(32, 7)),
    access: memoryDriveAccess({ users: { alice: { role: 'member' } } }),
    maxUploadBytes: 1 << 22,
    locks: memoryEditLockStore(),
  })
  const tools = createDriveTools({ service: async () => drive })
  const tool = (n: string) => tools.find((t) => t.name === n)!
  const ctx = {
    principal: delegatedPrincipal({ id: 'alice', roles: ['member'] }, 'orchestrator'),
    requestId: 'r',
  }
  const f = await drive.upload(alice, null, { name: 'sales.xlsx', bytes: sales(), mime: XLSX }, 'fail')
  const reread = async () => openWorkbook((await drive.readFile(alice, f.id)).bytes)
  const run = (n: string, input: Record<string, unknown>) =>
    tool(n).handler(ctx as never, { file_id: f.id, ...input }) as Promise<Record<string, unknown>>
  return { tool, run, reread }
}

const NAMES = [
  'drive.sheet_table_create',
  'drive.sheet_table_update',
  'drive.sheet_table_delete',
  'drive.sheet_pivot_create',
  'drive.sheet_pivot_update',
  'drive.sheet_pivot_refresh',
  'drive.sheet_pivot_delete',
]

describe('drive.sheet_table_* / drive.sheet_pivot_* (the grid’s tables and pivot tables as registry actions)', () => {
  it('are mutating Drive tools with readable activity lines', async () => {
    const { tool } = await setup()
    for (const n of NAMES)
      expect(tool(n)).toMatchObject({ module: 'drive', auditClass: 'mutate', approvalRisk: 'internal' })
    expect(
      tool('drive.sheet_table_create').activity!(
        { file_id: 'f', sheet: 'Data', range: 'A1:C5' },
        { file: { name: 'sales.xlsx' } },
      ),
    ).toBe('Created a table on A1:C5 in Data of sales.xlsx in Drive')
  })

  it('creates a table, adds a totals row, converts it back to a range — each a new revision', async () => {
    const { run, reread } = await setup()
    const created = await run('drive.sheet_table_create', { sheet: 'Data', range: 'A1', name: 'Sales' })
    expect(created.table).toMatchObject({
      name: 'Sales',
      ref: 'A1:C5',
      headerRow: true,
      columns: ['Region', 'Product', 'Amount'],
    })
    await run('drive.sheet_table_update', {
      sheet: 'Data',
      table: 'Sales',
      totals_row: true,
      totals_columns: [{ column: 'Amount', function: 'sum' }],
    })
    let wb = await reread()
    expect(readSheetTables(wb, 'Data')[0]).toMatchObject({ totalsRowCount: 1 })
    expect(createCalc(wb).cell('Data', 5, 2).value).toBe(42)
    await run('drive.sheet_table_delete', { sheet: 'Data', table: 'Sales' })
    wb = await reread()
    expect(readSheetTables(wb, 'Data')).toEqual([])
    expect(createCalc(wb).cell('Data', 1, 2).value).toBe(10)
  })

  it('creates, updates, refreshes and deletes a pivot table', async () => {
    const { run, reread } = await setup()
    const created = await run('drive.sheet_pivot_create', {
      source: 'Data!A1:C5',
      rows: ['Region'],
      values: [{ field: 'Amount', agg: 'sum' }],
    })
    const sheet = String(created.sheet)
    expect(created.pivot).toMatchObject({ rows: ['Region'], values: [{ field: 'Amount', agg: 'sum' }] })
    const name = (created.pivot as { name: string }).name
    let wb = await reread()
    expect(readSheetPivots(wb, sheet)).toHaveLength(1)
    const updated = await run('drive.sheet_pivot_update', {
      sheet,
      pivot: name,
      columns: ['Product'],
    })
    expect(updated.pivot).toMatchObject({ columns: ['Product'] })
    await run('drive.sheet_pivot_refresh', { sheet, pivot: name })
    await run('drive.sheet_pivot_delete', { sheet, pivot: name })
    wb = await reread()
    expect(readSheetPivots(wb, sheet)).toEqual([])
  })

  it('drive.sheet_filter filters a table’s column by name (rows hidden, the table’s own filter written)', async () => {
    const { run, reread } = await setup()
    await run('drive.sheet_table_create', { sheet: 'Data', range: 'A1:C5', name: 'Sales' })
    const out = await run('drive.sheet_filter', {
      sheet: 'Data',
      table: 'Sales',
      columns: [{ column: 'A', values: ['East'] }],
    })
    expect(out.filter).toMatchObject({ rows_shown: 2, rows_hidden: 2 })
    const wb = await reread()
    expect(wb.sheet('Data').rows.get(2)?.hidden).toBe(true)
    expect(readSheetTables(wb, 'Data')[0]!.autoFilter!.columns).toEqual([
      { col: 0, kind: 'values', values: ['East'], blanks: false },
    ])
    await expect(
      run('drive.sheet_filter', { sheet: 'Data', table: 'Sales', off: true }),
    ).rejects.toThrow(/sheet_table_update/)
  })

  it('refuses an unknown table or pivot without saving', async () => {
    const { run } = await setup()
    await expect(run('drive.sheet_table_update', { sheet: 'Data', table: 'Nope', totals_row: true })).rejects.toThrow()
    await expect(run('drive.sheet_pivot_refresh', { sheet: 'Data', pivot: 'Nope' })).rejects.toThrow()
  })
})
