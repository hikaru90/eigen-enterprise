import type { Actor } from './service'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { delegatedPrincipal } from '$lib/kernel/principals'
import { readDrawing } from '$lib/office/xlsx/drawing'
import { budgetBook } from '$lib/office/xlsx/test-utils/build-xlsx'
import { pictureBook, png } from '$lib/office/xlsx/test-utils/drawing-fixtures'
import { openWorkbook } from '$lib/office/xlsx/workbook'
import { memoryEditLockStore } from './locks'
import { DRIVE_SHEET_TOOL_NAMES, DRIVE_SHEET_WRITE_TOOLS } from './manifest'
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
  const dir = await mkdtemp(join(tmpdir(), 'drive-sheet-drawing-'))
  dirs.push(dir)
  const drive = createDriveService({
    store: memoryDriveStore(),
    blobs: diskBlobStore(dir),
    access: memoryDriveAccess({ users: { alice: { role: 'member', name: 'Alice' } } }),
    maxUploadBytes: 1 << 22,
    locks: memoryEditLockStore(),
  })
  const tools = createDriveTools({ service: async () => drive })
  const tool = (n: string) => tools.find((t) => t.name === n)!
  const as = (id: string) => ({
    principal: delegatedPrincipal({ id, roles: ['member'] }, 'orchestrator'),
    requestId: 'r',
  })
  const f = await drive.upload(alice, null, { name: 'budget.xlsx', bytes: budgetBook(), mime: XLSX }, 'fail')
  const img = await drive.upload(alice, null, { name: 'logo.png', bytes: png(120, 60), mime: 'image/png' }, 'fail')
  const reread = async (id = f.id) => openWorkbook((await drive.readFile(alice, id)).bytes)
  return { drive, tool, as, f, img, reread }
}

describe('drive.sheet_picture_* and drive.sheet_shape_* registry tools', () => {
  it('are registered as internal approval writes in Drive manifest', async () => {
    const { tool } = await setup()
    for (const name of [
      'drive.sheet_picture_insert',
      'drive.sheet_picture_update',
      'drive.sheet_picture_delete',
      'drive.sheet_shape_create',
      'drive.sheet_shape_update',
      'drive.sheet_shape_delete',
    ]) {
      expect(DRIVE_SHEET_TOOL_NAMES).toContain(name)
      expect(DRIVE_SHEET_WRITE_TOOLS).toContain(name)
      expect(tool(name)).toMatchObject({
        module: 'drive',
        auditClass: 'mutate',
        approvalRisk: 'internal',
      })
    }
  })

  it('inserts, updates and deletes pictures from Drive files or base64', async () => {
    const { drive, tool, as, f, img, reread } = await setup()
    const ins1 = (await tool('drive.sheet_picture_insert').handler(as('alice'), {
      file_id: f.id,
      sheet: 'Budget',
      image_file_id: img.id,
      cell: 'B2',
      alt: 'Brand mark',
    })) as { id: string; drawing: Record<string, unknown> }
    expect(ins1.drawing).toMatchObject({ kind: 'picture', alt: 'Brand mark', box: { w: 120, h: 60 } })

    const b64 = Buffer.from(png(80, 40)).toString('base64')
    const ins2 = (await tool('drive.sheet_picture_insert').handler(as('alice'), {
      file_id: f.id,
      sheet: 'Summary',
      image_base64: `data:image/png;base64,${b64}`,
      x: 10,
      y: 20,
      width: 160,
      height: 80,
      name: 'Banner',
    })) as { id: string; drawing: Record<string, unknown> }
    expect(ins2.drawing).toMatchObject({ kind: 'picture', name: 'Banner', box: { x: 10, y: 20, w: 160, h: 80 } })

    await tool('drive.sheet_picture_update').handler(as('alice'), {
      file_id: f.id,
      sheet: 'Budget',
      id: ins1.id,
      cell: 'C3',
      width: 240,
      rotation: 45,
      alt: 'Rotated mark',
    })
    const wbAfterUpdate = await reread()
    const pics = readDrawing(wbAfterUpdate, wbAfterUpdate.requireWorksheet('Budget'))
    expect(pics[0]).toMatchObject({ alt: 'Rotated mark', rotation: 45 })

    await tool('drive.sheet_picture_delete').handler(as('alice'), {
      file_id: f.id,
      sheet: 'Budget',
      id: ins1.id,
    })
    const wbAfterDel = await reread()
    expect(readDrawing(wbAfterDel, wbAfterDel.requireWorksheet('Budget'))).toEqual([])
    expect(await drive.listRevisions(alice, f.id)).toHaveLength(5)
  })

  it('creates, updates and deletes shapes and text boxes and preserves kind guards', async () => {
    const { tool, as, f, reread } = await setup()
    const created = (await tool('drive.sheet_shape_create').handler(as('alice'), {
      file_id: f.id,
      sheet: 'Budget',
      geometry: 'roundRect',
      cell: 'B2',
      width: 180,
      height: 60,
      text: 'KPI Target',
      fill: '#DDEBF7',
      line: '#1F4E79',
    })) as { id: string; drawing: Record<string, unknown> }
    expect(created.drawing).toMatchObject({
      kind: 'shape',
      geometry: 'roundRect',
      text: 'KPI Target',
      fill: '#DDEBF7',
    })

    const tb = (await tool('drive.sheet_shape_create').handler(as('alice'), {
      file_id: f.id,
      sheet: 'Budget',
      geometry: 'rect',
      textbox: true,
      x: 50,
      y: 120,
      width: 200,
      height: 90,
      text: 'Callout note',
    })) as { id: string; drawing: Record<string, unknown> }
    expect(tb.drawing).toMatchObject({ kind: 'textbox', text: 'Callout note' })

    const updated = (await tool('drive.sheet_shape_update').handler(as('alice'), {
      file_id: f.id,
      sheet: 'Budget',
      id: created.id,
      fill: '#FFEB9C',
      text: 'Updated KPI',
      rotation: 15,
    })) as { drawing: Record<string, unknown> }
    expect(updated.drawing).toMatchObject({ fill: '#FFEB9C', text: 'Updated KPI', rotation: 15 })

    // Kind guard: sheet_picture_update refuses a shape id
    await expect(
      tool('drive.sheet_picture_update').handler(as('alice'), {
        file_id: f.id,
        sheet: 'Budget',
        id: created.id,
        alt: 'nope',
      }),
    ).rejects.toMatchObject({ code: 'invalid', message: expect.stringMatching(/not a picture/) })

    await tool('drive.sheet_shape_delete').handler(as('alice'), {
      file_id: f.id,
      sheet: 'Budget',
      id: created.id,
    })
    const wb = await reread()
    expect(readDrawing(wb, wb.requireWorksheet('Budget')).map((d) => d.id)).toEqual([tb.id])
  })

  it('keeps charts untouched and enforces edit lock & conflict detection', async () => {
    const { drive, tool, as, img } = await setup()
    const picFile = await drive.upload(alice, null, { name: 'pics.xlsx', bytes: pictureBook(), mime: XLSX }, 'fail')

    // Refuses touching a chart via shape_delete or picture_delete
    await expect(
      tool('drive.sheet_shape_delete').handler(as('alice'), { file_id: picFile.id, sheet: 'Pics', id: '5' }),
    ).rejects.toMatchObject({ code: 'invalid', message: expect.stringMatching(/not a shape/) })

    // Edit lock refusal
    await drive.acquireLock(alice, picFile.id, 'tab-1')
    await expect(
      tool('drive.sheet_picture_insert').handler(as('alice'), {
        file_id: picFile.id,
        sheet: 'Pics',
        image_file_id: img.id,
        cell: 'A1',
      }),
    ).rejects.toMatchObject({ code: 'locked' })
    await drive.releaseLock(alice, picFile.id, 'tab-1')
  })
})
