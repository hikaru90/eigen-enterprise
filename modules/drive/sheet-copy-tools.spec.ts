import type { Actor } from './service'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OFFICE_MIME } from '$lib/office/kinds'
import { createSheetEditor } from '$lib/office/xlsx/editor'
import { sheetValues } from '$lib/office/xlsx/read'
import { odsBook, xlsBook } from '$lib/office/xlsx/test-utils/legacy-fixtures'
import { memoryEditLockStore } from './locks'
import { DRIVE_SHEET_COPY_TOOL_NAMES, DRIVE_TOOL_NAMES } from './manifest'
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

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'drive-sheet-copy-'))
  dirs.push(dir)
  const access = memoryDriveAccess({
    users: { alice: { role: 'member' }, bob: { role: 'member' } },
  })
  const drive = createDriveService({
    store: memoryDriveStore(),
    blobs: diskBlobStore(dir, Buffer.alloc(32, 7)),
    access,
    maxUploadBytes: 1 << 22,
    locks: memoryEditLockStore(),
  })
  const tools = createDriveTools({ service: async () => drive })
  const tool = (n: string) => tools.find((t) => t.name === n)!
  const me = {
    principal: { id: 'alice', kind: 'human' as const, roles: ['member'] },
    requestId: 'r',
  }
  return { drive, tool, me }
}

describe('drive.create_document kind "xlsx" (New → Spreadsheet)', () => {
  it('makes an empty Excel workbook with one sheet, as the first revision; drive.read shows it', async () => {
    const { drive, tool, me } = await setup()
    const out = (await tool('drive.create_document').handler(me, {
      name: 'Forecast',
      kind: 'xlsx',
    })) as {
      file: { id: string; name: string; mime: string }
    }
    expect(out.file).toMatchObject({ name: 'Forecast.xlsx', mime: OFFICE_MIME.xlsx })
    const { bytes } = await drive.readFile(alice, out.file.id)
    expect(
      createSheetEditor(bytes)
        .wb.sheets()
        .map((s) => s.name),
    ).toEqual(['Sheet1'])
    expect(await drive.listRevisions(alice, out.file.id)).toHaveLength(1)
    expect(await drive.readText(alice, out.file.id)).toMatchObject({
      content: '## Sheet: Sheet1\n\n(Empty.)\n',
    })
    // drive.sheet_write works on it straight away.
    await tool('drive.sheet_write').handler(me, {
      file_id: out.file.id,
      sheet: 'Sheet1',
      cells: [{ ref: 'A1', value: 7 }],
    })
    const again = createSheetEditor((await drive.readFile(alice, out.file.id)).bytes)
    expect(sheetValues(again, 'Sheet1', null, 'en').rows).toEqual([['7']])
  })

  it('a spreadsheet starts empty: content is refused, never dropped', async () => {
    const { tool, me } = await setup()
    await expect(
      tool('drive.create_document').handler(me, { name: 'x', kind: 'xlsx', content: 'a,b' }),
    ).rejects.toMatchObject({
      code: 'invalid',
    })
  })
})

describe('drive.make_xlsx_copy (.xls / .ods shown read-only)', () => {
  it('is a registered Drive write', async () => {
    const { tool } = await setup()
    for (const n of DRIVE_SHEET_COPY_TOOL_NAMES) expect(DRIVE_TOOL_NAMES).toContain(n)
    expect(tool('drive.make_xlsx_copy')).toMatchObject({
      module: 'drive',
      auditClass: 'mutate',
      approvalRisk: 'internal',
    })
    expect(
      tool('drive.make_xlsx_copy').activity!(
        { file_id: 'f' },
        { file: { name: 'b.xlsx' }, source: { name: 'b.ods' } },
      ),
    ).toBe('Made an editable copy b.xlsx of b.ods in Drive')
  })

  it('saves an .xlsx next to the original, which stays as it is, and lists what is not kept', async () => {
    const { drive, tool, me } = await setup()
    const folder = await drive.createFolder(alice, null, 'Finance')
    const ods = await drive.upload(
      alice,
      folder.id,
      { name: 'budget.ods', bytes: odsBook(), mime: null },
      'fail',
    )
    const before = (await drive.readFile(alice, ods.id)).file.sha256
    const out = (await tool('drive.make_xlsx_copy').handler(me, { file_id: ods.id })) as {
      file: { id: string; name: string; parentId: string | null }
      not_kept: Array<{ feature: string; text: string }>
    }
    expect(out.file).toMatchObject({ name: 'budget.xlsx', parentId: folder.id })
    expect(out.not_kept.map((l) => l.feature)).toContain('cell_styles')
    expect(out.not_kept.find((l) => l.feature === 'macros')?.text).toBe('macros')
    const copy = createSheetEditor((await drive.readFile(alice, out.file.id)).bytes)
    expect(sheetValues(copy, 'Budget', null, 'en').rows.at(-1)).toEqual(['Total', '1650'])
    expect((await drive.readFile(alice, ods.id)).file.sha256).toBe(before)
    // A second copy never takes the first one's place.
    const again = (await tool('drive.make_xlsx_copy').handler(me, { file_id: ods.id })) as {
      file: { name: string }
    }
    expect(again.file.name).toBe('budget (2).xlsx')
  })

  it('converts an .xls; refuses an .xlsx and anything else', async () => {
    const { drive, tool, me } = await setup()
    const xls = await drive.upload(
      alice,
      null,
      { name: 'old.xls', bytes: await xlsBook(), mime: null },
      'fail',
    )
    const out = (await tool('drive.make_xlsx_copy').handler(me, { file_id: xls.id })) as {
      file: { name: string }
    }
    expect(out.file.name).toBe('old.xlsx')
    const xlsx = await drive.createDocument(alice, null, 'xlsx', 'new')
    await expect(tool('drive.make_xlsx_copy').handler(me, { file_id: xlsx.id })).rejects.toThrow(
      /already an Excel workbook/,
    )
    const md = await drive.createDocument(alice, null, 'md', 'notes')
    await expect(
      tool('drive.make_xlsx_copy').handler(me, { file_id: md.id }),
    ).rejects.toMatchObject({ code: 'invalid' })
  })

  it('a broken .ods is refused with the reason', async () => {
    const { drive, tool, me } = await setup()
    const bad = await drive.upload(
      alice,
      null,
      { name: 'bad.ods', bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2]), mime: null },
      'fail',
    )
    await expect(tool('drive.make_xlsx_copy').handler(me, { file_id: bad.id })).rejects.toThrow(
      /could not be converted/,
    )
  })

  it('.xls and .ods are never saved in place', async () => {
    const { drive } = await setup()
    const ods = await drive.upload(
      alice,
      null,
      { name: 'budget.ods', bytes: odsBook(), mime: null },
      'fail',
    )
    await expect(drive.writeBytes(alice, ods.id, odsBook())).rejects.toThrow(/never saved in place/)
    const xls = await drive.upload(
      alice,
      null,
      { name: 'old.xls', bytes: await xlsBook(), mime: null },
      'fail',
    )
    await expect(drive.writeBytes(alice, xls.id, await xlsBook())).rejects.toMatchObject({
      code: 'invalid',
    })
  })

  it('drive.read gives an .xls as Markdown tables', async () => {
    const { drive, tool, me } = await setup()
    const xls = await drive.upload(
      alice,
      null,
      { name: 'old.xls', bytes: await xlsBook(), mime: null },
      'fail',
    )
    const out = (await tool('drive.read').handler(me, { file_id: xls.id })) as { content: string }
    expect(out.content).toContain('| Total | 1650 |')
  })
})
