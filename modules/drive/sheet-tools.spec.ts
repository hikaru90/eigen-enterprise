import type { Actor } from './service'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { delegatedPrincipal } from '$lib/kernel/principals'
import type { StreamEvent } from '$lib/office/xlsx/collab/protocol'
import { cellKey } from '$lib/office/xlsx/ref'
import { budgetBook, buildXlsx, num, row } from '$lib/office/xlsx/test-utils/build-xlsx'
import { commentBook, pictureBook } from '$lib/office/xlsx/test-utils/drawing-fixtures'
import { openWorkbook } from '$lib/office/xlsx/workbook'
import { createSheetLive } from '$lib/server/sheet-live/service'
import { memorySheetLiveStore } from '$lib/server/sheet-live/store'
import { memoryEditLockStore } from './locks'
import { DRIVE_SHEET_TOOL_NAMES, DRIVE_SHEET_WRITE_TOOLS, DRIVE_TOOL_NAMES } from './manifest'
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
  const dir = await mkdtemp(join(tmpdir(), 'drive-sheet-tools-'))
  dirs.push(dir)
  const access = memoryDriveAccess({
    users: { alice: { role: 'member' }, bob: { role: 'member' } },
  })
  const drive = createDriveService({
    store: memoryDriveStore(),
    blobs: diskBlobStore(dir),
    access,
    maxUploadBytes: 1 << 22,
    locks: memoryEditLockStore(),
  })
  const tools = createDriveTools({ service: async () => drive })
  const tool = (n: string) => tools.find((t) => t.name === n)!
  const as = (id: string) => ({
    principal: delegatedPrincipal({ id, roles: ['member'] }, 'orchestrator'),
    requestId: 'r',
  })
  const book = async (bytes = budgetBook(), name = 'budget.xlsx') =>
    drive.upload(alice, null, { name, bytes, mime: XLSX }, 'fail')
  const reread = async (id: string) => openWorkbook((await drive.readFile(alice, id)).bytes)
  return { drive, tool, as, book, reread }
}

describe('drive.sheet_* tools (the spreadsheet editor as registry actions)', () => {
  it('are registered Drive tools: one read, two writes that wait on the approval mode', async () => {
    const { tool } = await setup()
    for (const name of DRIVE_SHEET_TOOL_NAMES) expect(DRIVE_TOOL_NAMES).toContain(name)
    expect(tool('drive.sheet_read')).toMatchObject({ module: 'drive', auditClass: 'read' })
    for (const name of DRIVE_SHEET_WRITE_TOOLS)
      expect(tool(name)).toMatchObject({
        module: 'drive',
        auditClass: 'mutate',
        approvalRisk: 'internal',
      })
    expect(
      tool('drive.sheet_write').activity!(
        {
          file_id: 'f',
          sheet: 'Budget',
          cells: [
            { ref: 'A1', value: 1 },
            { ref: 'A2', value: 2 },
          ],
        },
        { file: { name: 'budget.xlsx' } },
      ),
    ).toBe('Wrote 2 cells in Budget of budget.xlsx in Drive')
    expect(
      tool('drive.sheet_structure').activity!(
        {
          file_id: 'f',
          changes: [
            { action: 'add_sheet', name: 'Q1' },
            { action: 'insert_rows', sheet: 'Q1', at: 2, count: 3 },
          ],
        },
        { file: { name: 'budget.xlsx' } },
      ),
    ).toBe('Changed budget.xlsx in Drive: added the sheet Q1, inserted 3 rows in Q1')
  })

  it('drive.sheet_read lists the sheets and returns the cells of a range with values, formulas, text and formats', async () => {
    const { tool, as, book } = await setup()
    const f = await book()
    const out = (await tool('drive.sheet_read').handler(as('alice'), { file_id: f.id })) as {
      sheets: unknown[]
      sheet: string
      range: string
      cells: Array<Record<string, unknown>>
    }
    expect(out.sheets).toEqual([
      { name: 'Budget', kind: 'sheet', hidden: false, used: 'A1:D4' },
      { name: 'Summary', kind: 'sheet', hidden: false, used: 'A1:B1' },
    ])
    expect(out).toMatchObject({ sheet: 'Budget', range: 'A1:D4' })
    expect(out.cells.find((c) => c.ref === 'B4')).toEqual({
      ref: 'B4',
      value: 1500,
      formula: '=SUM(B2:B3)',
      text: '1500',
    })
    const part = (await tool('drive.sheet_read').handler(as('alice'), {
      file_id: f.id,
      sheet: 'summary',
      range: 'A1',
    })) as { sheet: string; cells: unknown[] }
    expect(part).toMatchObject({
      sheet: 'Summary',
      cells: [{ ref: 'A1', value: 3000, formula: '=Budget!B4*2' }],
    })
  })

  it('drive.sheet_write sets values, formulas and formats, saves a revision, and answers with the calculated cells', async () => {
    const { drive, tool, as, book, reread } = await setup()
    const f = await book()
    const out = (await tool('drive.sheet_write').handler(as('alice'), {
      file_id: f.id,
      sheet: 'Budget',
      cells: [
        { ref: 'B3', value: 800 },
        { ref: 'B5', formula: '=B4*2' },
        { ref: 'C2', value: 0.25, format: '0%' },
      ],
    })) as { cells: Array<Record<string, unknown>>; revision: { id: string } }
    expect(out.cells).toEqual([
      { ref: 'C2', value: 0.25, text: '25%', format: '0%' },
      { ref: 'B3', value: 800, text: '800' },
      { ref: 'B5', value: 4000, formula: '=B4*2', text: '4000' },
    ])
    expect(await drive.listRevisions(alice, f.id)).toHaveLength(2)
    const wb = await reread(f.id)
    expect(wb.sheet('Budget').cells.get(cellKey(3, 1))?.value).toBe(2000)
    expect(wb.sheet('Budget').cells.get(cellKey(1, 1))?.style).toBe(2)
  })

  it('drive.sheet_structure adds, renames and deletes sheets and moves rows, in one revision', async () => {
    const { drive, tool, as, book, reread } = await setup()
    const f = await book()
    await tool('drive.sheet_structure').handler(as('alice'), {
      file_id: f.id,
      changes: [
        { action: 'add_sheet', name: 'Notes' },
        { action: 'rename_sheet', sheet: 'Budget', name: 'Money' },
        { action: 'insert_rows', sheet: 'Money', at: 2, count: 1 },
        { action: 'insert_columns', sheet: 'Money', at: 'A', count: 1 },
      ],
    })
    expect(await drive.listRevisions(alice, f.id)).toHaveLength(2)
    const wb = await reread(f.id)
    expect(wb.sheets().map((s) => s.name)).toEqual(['Money', 'Summary', 'Notes'])
    expect(wb.sheet('Summary').cells.get(cellKey(0, 0))).toMatchObject({
      formula: 'Money!C5*2',
      value: 3000,
    })
  })

  it('refuses a structure change that would leave tables behind unless accepted, while drawings move with the cells', async () => {
    const { tool, as, book, reread } = await setup()
    const bytes = buildXlsx({
      sheets: [
        {
          name: 'S',
          rows: row(1, num('A1', 1)),
          after:
            '<drawing r:id="rId1"/><tableParts count="1"><tablePart r:id="rId2"/></tableParts>',
          rels: [
            { id: 'rId1', type: 'drawing', target: '../drawings/drawing1.xml' },
            { id: 'rId2', type: 'table', target: '../tables/table1.xml' },
          ],
        },
      ],
      parts: {
        '/xl/drawings/drawing1.xml': {
          xml: '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"><xdr:oneCellAnchor><xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>1</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:ext cx="95250" cy="95250"/><xdr:sp><xdr:nvSpPr><xdr:cNvPr id="2" name="Box"/><xdr:cNvSpPr/></xdr:nvSpPr><xdr:spPr/></xdr:sp><xdr:clientData/></xdr:oneCellAnchor></xdr:wsDr>',
          type: 'application/vnd.openxmlformats-officedocument.drawing+xml',
        },
        '/xl/tables/table1.xml': {
          xml: '<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="1" name="T" displayName="T" ref="A1:A2"/>',
          type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml',
        },
      },
    })
    const f = await book(bytes, 'pics.xlsx')
    const change = {
      file_id: f.id,
      changes: [{ action: 'insert_rows', sheet: 'S', at: 1, count: 1 }],
    }
    await expect(tool('drive.sheet_structure').handler(as('alice'), change)).rejects.toMatchObject({
      code: 'invalid',
      message: expect.stringMatching(/tables/),
    })
    const ok = (await tool('drive.sheet_structure').handler(as('alice'), {
      ...change,
      accept_losses: true,
    })) as { warnings: string[] }
    expect(ok.warnings).toEqual([expect.stringMatching(/1 × tables/)])
    const wb = await reread(f.id)
    expect(wb.pkg.text('/xl/drawings/drawing1.xml')).toContain('<xdr:row>2</xdr:row>')
  })

  it('refuses what is not a workbook, a missing sheet, a formula it can’t read, and a file open in an editor', async () => {
    const { drive, tool, as, book } = await setup()
    const csv = await drive.createDocument(alice, null, 'csv', 'table')
    await expect(
      tool('drive.sheet_read').handler(as('alice'), { file_id: csv.id }),
    ).rejects.toMatchObject({
      code: 'invalid',
      message: expect.stringMatching(/not an Excel workbook/),
    })
    const f = await book()
    await expect(
      tool('drive.sheet_read').handler(as('alice'), { file_id: f.id, sheet: 'Nope' }),
    ).rejects.toMatchObject({
      code: 'invalid',
      message: expect.stringMatching(/no sheet called “Nope”/),
    })
    await expect(
      tool('drive.sheet_write').handler(as('alice'), {
        file_id: f.id,
        sheet: 'Budget',
        cells: [{ ref: 'A1', formula: '=SUM(' }],
      }),
    ).rejects.toMatchObject({ code: 'invalid' })
    await drive.acquireLock(alice, f.id, 'tab-alice-1')
    // Open in an editor (a tab holds the edit lock): the tool waits its turn, it never cuts across.
    await expect(
      tool('drive.sheet_write').handler(as('alice'), {
        file_id: f.id,
        sheet: 'Budget',
        cells: [{ ref: 'A1', value: 1 }],
      }),
    ).rejects.toMatchObject({ code: 'locked' })
  })

  it('never overwrites a save that landed between reading and writing (conflict)', async () => {
    const { drive, tool, as, book, reread } = await setup()
    const f = await book()
    const real = drive.readFile.bind(drive)
    // Another save lands right after the tool read the file.
    drive.readFile = async (actor, id) => {
      const got = await real(actor, id)
      await drive.writeBytes(
        alice,
        id,
        budgetBook({ strings: ['Item', 'Cost', 'Rent', 'Food', 'Changed elsewhere'] }),
      )
      return got
    }
    await expect(
      tool('drive.sheet_write').handler(as('alice'), {
        file_id: f.id,
        sheet: 'Budget',
        cells: [{ ref: 'B2', value: 1 }],
      }),
    ).rejects.toMatchObject({ code: 'conflict' })
    drive.readFile = real
    expect((await reread(f.id)).sheet('Budget').cells.get(cellKey(3, 0))?.value).toBe(
      'Changed elsewhere',
    )
  })

  it('drive.read gives the workbook as Markdown tables, one per sheet', async () => {
    const { tool, as, book } = await setup()
    const f = await book()
    const out = (await tool('drive.read').handler(as('alice'), { file_id: f.id })) as {
      content: string
    }
    expect(out.content).toContain('## Sheet: Budget')
    expect(out.content).toContain('| Rent | 1200 |  |  |')
    expect(out.content).toContain('| Total | 1500 | 125 | 1500 |')
    expect(out.content).toContain('## Sheet: Summary')
  })

  it('routes drive.sheet_* reads and writes through SheetLive while an open session is active', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'drive-sheet-live-'))
    dirs.push(dir)
    const access = memoryDriveAccess({
      users: { alice: { role: 'member' }, bob: { role: 'member' } },
    })
    const drive = createDriveService({
      store: memoryDriveStore(),
      blobs: diskBlobStore(dir),
      access,
      maxUploadBytes: 1 << 22,
      locks: memoryEditLockStore(),
    })
    const live: ReturnType<typeof createSheetLive> = createSheetLive({
      drive,
      store: memorySheetLiveStore(),
      publish: async (m) => live.receive(m),
      nameOf: async (a) => (a.kind === 'user' ? a.userId : a.id),
    })
    const tools = createDriveTools({ service: async () => drive, sheetLive: async () => live })
    const tool = (n: string) => tools.find((t) => t.name === n)!
    const as = (id: string) => ({
      principal: delegatedPrincipal({ id, roles: ['member'] }, 'orchestrator'),
      requestId: 'r-live',
    })
    const folder = await drive.createFolder(alice, null, 'Coedit')
    access.grants.push({
      resourceType: 'folder',
      resourceId: folder.id,
      subject: { kind: 'user', userId: 'bob' },
      level: 'edit',
    })
    const f = await drive.upload(alice, folder.id, { name: 'budget.xlsx', bytes: budgetBook(), mime: XLSX }, 'fail')

    await live.join(alice, f.id)
    const events: StreamEvent[] = []
    const disconnect = await live.connect(alice, f.id, 'tab-alice', 0, (e) => events.push(e))

    // Unflushed edit in the browser's live session is visible to drive.sheet_read.
    await live.submit(alice, f.id, {
      clientId: 'tab-alice',
      baseSeq: 0,
      changes: [{ opId: 'a1', body: { kind: 'change', ops: [{ op: 'set_cells', sheet: 'Budget', cells: [{ ref: 'B2', value: 999 }] }], acceptLosses: false } }],
    })
    const readOut = (await tool('drive.sheet_read').handler(as('bob'), { file_id: f.id, sheet: 'Budget', range: 'B2' })) as {
      cells: Array<{ ref: string; value?: unknown }>
    }
    expect(readOut.cells[0]?.value).toBe(999)

    // Tool edits commit to the live log and broadcast to open peers immediately, without saving a premature Drive revision.
    const writeOut = (await tool('drive.sheet_write').handler(as('bob'), {
      file_id: f.id,
      sheet: 'Budget',
      cells: [{ ref: 'D2', value: 'tool-edit' }],
    })) as { revision: unknown; cells: Array<{ ref: string; value?: unknown }> }
    expect(writeOut.revision).toBeNull()
    expect(writeOut.cells[0]?.value).toBe('tool-edit')

    const fmtOut = (await tool('drive.sheet_format').handler(as('bob'), {
      file_id: f.id,
      sheet: 'Budget',
      styles: [{ range: 'D2', bold: true }],
    })) as { revision: unknown; sheet: string }
    expect(fmtOut.revision).toBeNull()
    expect(fmtOut.sheet).toBe('Budget')

    const freezeOut = (await tool('drive.sheet_freeze').handler(as('bob'), {
      file_id: f.id,
      sheet: 'Budget',
      rows: 1,
      columns: 0,
    })) as { revision: unknown; frozen: { rows: number; columns: number } }
    expect(freezeOut.revision).toBeNull()
    expect(freezeOut.frozen).toEqual({ rows: 1, columns: 0 })

    await new Promise((r) => setTimeout(r, 20))
    const entrySeqs = events.filter((e) => e.event === 'entry').map((e) => e.data.seq)
    expect(entrySeqs).toEqual([1, 2, 3, 4])

    // Disconnecting the last peer flushes all browser + agent changes into Drive.
    await disconnect()
    const saved = openWorkbook((await drive.readFile(alice, f.id)).bytes)
    expect(saved.sheet('Budget').cells.get(cellKey(1, 1))?.value).toBe(999)
    expect(saved.sheet('Budget').cells.get(cellKey(1, 3))?.value).toBe('tool-edit')
    live.stop()
  })

  it('drive.sheet_read includes drawings, notes and threaded comments summaries and details', async () => {
    const { tool, as, book } = await setup()
    const picFile = await book(pictureBook(), 'pics.xlsx')
    const picOut = (await tool('drive.sheet_read').handler(as('alice'), { file_id: picFile.id })) as {
      sheets: Array<Record<string, unknown>>
      drawings: Array<Record<string, unknown>>
    }
    // The chart frame is listed under charts (drive.sheet_chart_list), the other four under drawings.
    expect(picOut.sheets[0]).toMatchObject({ name: 'Pics', drawings: 4 })
    expect(picOut.drawings).toHaveLength(4)
    expect(picOut.drawings.some((d) => d.kind === 'chart')).toBe(false)
    expect(picOut.drawings.find((d) => d.id === '2')).toMatchObject({
      kind: 'picture',
      name: 'Picture 1',
      alt: 'Company logo',
      rotation: 90,
      anchor_cell: 'B2:D6',
    })

    const noteFile = await book(commentBook(), 'notes.xlsx')
    const noteOut = (await tool('drive.sheet_read').handler(as('alice'), { file_id: noteFile.id })) as {
      sheets: Array<Record<string, unknown>>
      notes: Array<Record<string, unknown>>
      comments: Array<Record<string, unknown>>
    }
    expect(noteOut.sheets[0]).toMatchObject({ name: 'Notes', notes: 1, comments: 1 })
    expect(noteOut.notes).toEqual([
      { ref: 'B2', author: 'Ada Lovelace', text: 'Ada Lovelace:\nCheck this number', visible: true },
    ])
    expect(noteOut.comments).toHaveLength(1)
    expect(noteOut.comments[0]).toMatchObject({ ref: 'C4', resolved: false })
  })
})
