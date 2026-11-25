import type { Actor } from './service'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { delegatedPrincipal } from '$lib/kernel/principals'
import { cellKey } from '$lib/office/xlsx/ref'
import { buildXlsx, fml, num, row, str } from '$lib/office/xlsx/test-utils/build-xlsx'
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

const table = () =>
  buildXlsx({
    strings: ['Name', 'Amount', 'bob', 'Alice', 'carol'],
    sheets: [
      {
        name: 'Data',
        rows:
          row(1, str('A1', 0) + str('B1', 1) + fml('C1', 'SUM(B2:B4)', 60)) +
          row(2, str('A2', 2) + num('B2', 30) + fml('C2', 'B2*2', 60)) +
          row(3, str('A3', 3) + num('B3', 10) + fml('C3', 'B3*2', 20)) +
          row(4, str('A4', 4) + num('B4', 20) + fml('C4', 'B4*2', 40)),
      },
    ],
  })

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'drive-sheet-arrange-'))
  dirs.push(dir)
  const drive = createDriveService({
    store: memoryDriveStore(),
    blobs: diskBlobStore(dir),
    access: memoryDriveAccess({ users: { alice: { role: 'member' } } }),
    maxUploadBytes: 1 << 22,
    locks: memoryEditLockStore(),
  })
  const tools = createDriveTools({ service: async () => drive })
  const tool = (n: string) => tools.find((t) => t.name === n)!
  const as = (id: string) => ({
    principal: delegatedPrincipal({ id, roles: ['member'] }, 'orchestrator'),
    requestId: 'r',
  })
  const f = await drive.upload(alice, null, { name: 'people.xlsx', bytes: table(), mime: XLSX }, 'fail')
  const reread = async () => openWorkbook((await drive.readFile(alice, f.id)).bytes)
  return { drive, tool, as, f, reread }
}

describe('drive.sheet_sort / sheet_filter / sheet_freeze (the grid’s sort, filter and freeze as registry actions)', () => {
  it('are mutating Drive tools with readable activity lines', async () => {
    const { tool } = await setup()
    for (const n of ['drive.sheet_sort', 'drive.sheet_filter', 'drive.sheet_freeze'])
      expect(tool(n)).toMatchObject({ module: 'drive', auditClass: 'mutate', approvalRisk: 'internal' })
    const out = { file: { name: 'people.xlsx' } }
    expect(
      tool('drive.sheet_sort').activity!(
        { file_id: 'f', sheet: 'Data', range: 'A1:C4', by: [{ column: 'B' }] },
        out,
      ),
    ).toBe('Sorted A1:C4 in Data of people.xlsx in Drive')
    expect(
      tool('drive.sheet_filter').activity!(
        { file_id: 'f', sheet: 'Data', columns: [{ column: 'A', values: ['bob'] }] },
        out,
      ),
    ).toBe('Filtered 1 column in Data of people.xlsx in Drive')
    expect(
      tool('drive.sheet_freeze').activity!({ file_id: 'f', sheet: 'Data', rows: 1, columns: 1 }, out),
    ).toBe('Froze 1 row and 1 column of Data in people.xlsx in Drive')
  })

  it('drive.sheet_sort sorts under the header with formulas following, as a new revision', async () => {
    const { drive, tool, as, f, reread } = await setup()
    await tool('drive.sheet_sort').handler(as('alice'), {
      file_id: f.id,
      sheet: 'Data',
      range: 'A1:C4',
      header: true,
      by: [{ column: 'B', descending: true }],
    })
    expect(await drive.listRevisions(alice, f.id)).toHaveLength(2)
    const s = (await reread()).sheet('Data')
    expect([1, 2, 3].map((r) => s.cells.get(cellKey(r, 0))?.value)).toEqual(['bob', 'carol', 'Alice'])
    expect(s.cells.get(cellKey(3, 2))).toMatchObject({ formula: 'B4*2', value: 20 })
    expect(s.cells.get(cellKey(0, 0))?.value).toBe('Name')
  })

  it('drive.sheet_filter turns the filter on, filters by shown values, reports it (also in drive.sheet_read), and turns it off', async () => {
    const { tool, as, f, reread } = await setup()
    const out = (await tool('drive.sheet_filter').handler(as('alice'), {
      file_id: f.id,
      sheet: 'Data',
      range: 'A1',
      columns: [{ column: 'B', values: ['10', '20'] }],
    })) as { filter: unknown }
    expect(out.filter).toEqual({
      range: 'A1:C4',
      columns: [{ column: 'B', values: ['10', '20'], blanks: false }],
      rows_shown: 2,
      rows_hidden: 1,
    })
    expect((await reread()).sheet('Data').rows.get(1)?.hidden).toBe(true)
    const read = (await tool('drive.sheet_read').handler(as('alice'), { file_id: f.id })) as {
      sheets: Array<Record<string, unknown>>
    }
    expect(read.sheets[0]).toMatchObject({ filter: { range: 'A1:C4' } })
    await tool('drive.sheet_filter').handler(as('alice'), { file_id: f.id, sheet: 'Data', off: true })
    expect((await reread()).sheet('Data').rows.get(1)?.hidden ?? false).toBe(false)
    await expect(
      tool('drive.sheet_filter').handler(as('alice'), { file_id: f.id, sheet: 'Data' }),
    ).rejects.toMatchObject({ code: 'invalid' })
    await expect(
      tool('drive.sheet_filter').handler(as('alice'), {
        file_id: f.id,
        sheet: 'Data',
        columns: [{ column: 'A', values: ['bob'] }],
      }),
    ).rejects.toMatchObject({ code: 'invalid', message: expect.stringMatching(/no filter/) })
  })

  it('drive.sheet_freeze freezes and unfreezes; drive.sheet_read shows it', async () => {
    const { tool, as, f } = await setup()
    const out = (await tool('drive.sheet_freeze').handler(as('alice'), {
      file_id: f.id,
      sheet: 'Data',
      rows: 1,
      columns: 0,
    })) as { frozen: unknown }
    expect(out.frozen).toEqual({ rows: 1, columns: 0 })
    const read = (await tool('drive.sheet_read').handler(as('alice'), { file_id: f.id })) as {
      sheets: Array<Record<string, unknown>>
    }
    expect(read.sheets[0]).toMatchObject({ frozen: { rows: 1, columns: 0 } })
    const off = (await tool('drive.sheet_freeze').handler(as('alice'), {
      file_id: f.id,
      sheet: 'Data',
      rows: 0,
      columns: 0,
    })) as { frozen: unknown }
    expect(off.frozen).toBeNull()
  })
})
