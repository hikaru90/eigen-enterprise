import type { Actor } from './service'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { delegatedPrincipal } from '$lib/kernel/principals'
import { cellKey } from '$lib/office/xlsx/ref'
import { budgetBook } from '$lib/office/xlsx/test-utils/build-xlsx'
import { openWorkbook } from '$lib/office/xlsx/workbook'
import { memoryEditLockStore } from './locks'
import { DRIVE_SHEET_WRITE_TOOLS } from './manifest'
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

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'drive-sheet-format-'))
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
  const as = (id: string) => ({
    principal: delegatedPrincipal({ id, roles: ['member'] }, 'orchestrator'),
    requestId: 'r',
  })
  const f = await drive.upload(
    alice,
    null,
    { name: 'budget.xlsx', bytes: budgetBook(), mime: XLSX },
    'fail',
  )
  const reread = async () => openWorkbook((await drive.readFile(alice, f.id)).bytes)
  return { drive, tool, as, f, reread }
}

describe('drive.sheet_format (the format toolbar and column/row sizes as a registry action)', () => {
  it('is a Drive write that waits on the approval mode', async () => {
    const { tool } = await setup()
    expect(DRIVE_SHEET_WRITE_TOOLS).toContain('drive.sheet_format')
    expect(tool('drive.sheet_format')).toMatchObject({
      module: 'drive',
      auditClass: 'mutate',
      approvalRisk: 'internal',
    })
  })

  it('formats ranges and sizes columns and rows in one revision; drive.sheet_read shows it', async () => {
    const { drive, tool, as, f, reread } = await setup()
    const out = await tool('drive.sheet_format').handler(as('alice'), {
      file_id: f.id,
      sheet: 'budget',
      styles: [
        {
          range: 'A1:D1',
          bold: true,
          fill: '#DDEBF7',
          border: { preset: 'bottom', style: 'medium', color: '#1F4E79' },
        },
        { range: 'B2:B4', italic: true, horizontal: 'right', font_color: '#C00000' },
      ],
      columns: [{ from: 'B', to: 'C', width: 18 }],
      rows: [{ from: 1, height: 24 }],
    })
    expect(out).toMatchObject({ sheet: 'Budget', file: { name: 'budget.xlsx' } })
    expect(
      tool('drive.sheet_format').activity!(
        {
          file_id: f.id,
          sheet: 'Budget',
          styles: [{ range: 'A1' }, { range: 'B2' }],
          rows: [{ from: 1, height: 20 }],
        },
        out,
      ),
    ).toBe('Formatted 2 ranges, 1 row height in Budget of budget.xlsx in Drive')
    expect(await drive.listRevisions(alice, f.id)).toHaveLength(2)
    const wb = await reread()
    const st = (r: number, c: number) =>
      wb.styles().xf(wb.sheet('Budget').cells.get(cellKey(r, c))?.style ?? 0)
    expect(st(0, 2)).toMatchObject({
      font: { bold: true },
      fill: '#DDEBF7',
      border: { bottom: { style: 'medium', color: '#1F4E79' } },
    })
    // B2 kept its yellow fill: only what was given changed.
    expect(st(1, 1)).toMatchObject({ fill: '#FFFF00', font: { italic: true, color: '#C00000' } })

    const read = (await tool('drive.sheet_read').handler(as('alice'), {
      file_id: f.id,
      range: 'A1:C2',
    })) as {
      cells: Array<Record<string, unknown>>
      sizes: { columns: unknown[]; rows: unknown[] }
    }
    expect(read.cells.find((c) => c.ref === 'B2')).toMatchObject({
      style: { italic: true, font_color: '#C00000', fill: '#FFFF00', horizontal: 'right' },
    })
    expect(read.cells.find((c) => c.ref === 'A1')).toMatchObject({
      style: { bold: true, fill: '#DDEBF7', border: { bottom: 'medium #1F4E79' } },
    })
    expect(read.sizes).toEqual({
      columns: [
        { columns: 'A', width: 20 },
        { columns: 'B', width: 18 },
        { columns: 'C', width: 18 },
      ],
      rows: [{ row: 1, height: 24 }],
    })
  })

  it('resets sizes, and refuses nothing-to-do and impossible values without saving', async () => {
    const { drive, tool, as, f, reread } = await setup()
    await tool('drive.sheet_format').handler(as('alice'), {
      file_id: f.id,
      sheet: 'Budget',
      columns: [{ from: 1, width: null }],
    })
    expect((await reread()).sheet('Budget').cols.map((c) => [c.min, c.max])).toEqual([[2, 3]])
    const before = (await drive.listRevisions(alice, f.id)).length
    for (const input of [
      { file_id: f.id, sheet: 'Budget' },
      { file_id: f.id, sheet: 'Budget', styles: [{ range: 'A1' }] },
      { file_id: f.id, sheet: 'Budget', styles: [{ range: 'A1', fill: 'yellow' }] },
      { file_id: f.id, sheet: 'Nope', styles: [{ range: 'A1', bold: true }] },
      { file_id: f.id, sheet: 'Budget', columns: [{ from: 'D', to: 'B', width: 10 }] },
    ])
      await expect(tool('drive.sheet_format').handler(as('alice'), input)).rejects.toThrow()
    expect(await drive.listRevisions(alice, f.id)).toHaveLength(before)
  })
})
