import type { Actor } from './service'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { delegatedPrincipal } from '$lib/kernel/principals'
import { salesBook } from '$lib/office/xlsx/test-utils/chart-fixtures'
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
  const dir = await mkdtemp(join(tmpdir(), 'drive-sheet-charts-'))
  dirs.push(dir)
  const drive = createDriveService({
    store: memoryDriveStore(),
    blobs: diskBlobStore(dir),
    access: memoryDriveAccess({ users: { alice: { role: 'member' }, viewer: { role: 'member' } } }),
    maxUploadBytes: 1 << 22,
    locks: memoryEditLockStore(),
  })
  const tools = createDriveTools({ service: async () => drive })
  const tool = (n: string) => tools.find((t) => t.name === n)!
  const as = (id: string) => ({
    principal: delegatedPrincipal({ id, roles: ['member'] }, 'orchestrator'),
    requestId: 'r',
  })
  const upload = async (bytes = salesBook(), name = 'sales.xlsx') =>
    drive.upload(alice, null, { name, bytes, mime: XLSX }, 'fail')
  const reread = async (id: string) => openWorkbook((await drive.readFile(alice, id)).bytes)
  return { drive, tool, as, upload, reread }
}

describe('drive.sheet_chart_* tools (charts as registry actions)', () => {
  it('are registered Drive tools: list is a read, create/update/delete wait on approval', async () => {
    const { tool } = await setup()
    for (const name of [
      'drive.sheet_chart_list',
      'drive.sheet_chart_create',
      'drive.sheet_chart_update',
      'drive.sheet_chart_delete',
    ])
      expect(DRIVE_SHEET_TOOL_NAMES).toContain(name)
    expect(tool('drive.sheet_chart_list')).toMatchObject({ module: 'drive', auditClass: 'read' })
    for (const name of [
      'drive.sheet_chart_create',
      'drive.sheet_chart_update',
      'drive.sheet_chart_delete',
    ]) {
      expect(DRIVE_SHEET_WRITE_TOOLS).toContain(name)
      expect(tool(name)).toMatchObject({
        module: 'drive',
        auditClass: 'mutate',
        approvalRisk: 'internal',
      })
    }
    const out = { file: { name: 'sales.xlsx' } }
    expect(
      tool('drive.sheet_chart_create').activity!(
        { file_id: 'f', sheet: 'Data', type: 'bar', range: 'A1:C5' },
        out,
      ),
    ).toBe('Created a bar chart in Data of sales.xlsx in Drive')
    expect(
      tool('drive.sheet_chart_update').activity!(
        { file_id: 'f', sheet: 'Data', chart: 'chart1', title: 'New' },
        out,
      ),
    ).toBe('Updated chart chart1 in Data of sales.xlsx in Drive')
    expect(
      tool('drive.sheet_chart_delete').activity!(
        { file_id: 'f', sheet: 'Data', chart: 'chart1' },
        out,
      ),
    ).toBe('Deleted chart chart1 from Data of sales.xlsx in Drive')
  })

  it('drive.sheet_chart_list and drive.sheet_read list charts on worksheets and chart sheets', async () => {
    const { tool, as, upload } = await setup()
    const f = await upload()
    const listed = (await tool('drive.sheet_chart_list').handler(as('alice'), {
      file_id: f.id,
    })) as { charts: Array<Record<string, unknown>> }
    expect(listed.charts).toHaveLength(1)
    expect(listed.charts[0]).toMatchObject({
      id: 'chart1',
      name: 'Chart 1',
      sheet: 'Data',
      types: ['column'],
      title: 'Sales',
      position: 'E2:L16',
    })
    const read = (await tool('drive.sheet_read').handler(as('alice'), { file_id: f.id })) as {
      sheets: Array<Record<string, unknown>>
      charts?: Array<Record<string, unknown>>
    }
    expect(read.sheets[0]).toMatchObject({
      name: 'Data',
      charts: [
        { id: 'chart1', name: 'Chart 1', types: ['column'], title: 'Sales', position: 'E2:L16' },
      ],
    })
    expect(read.charts).toHaveLength(1)
  })

  it('creates a chart from a range, creates a combo chart and a chart sheet, updates, moves, and deletes', async () => {
    const { drive, tool, as, upload, reread } = await setup()
    const f = await upload(salesBook([]))
    const created = (await tool('drive.sheet_chart_create').handler(as('alice'), {
      file_id: f.id,
      sheet: 'Data',
      type: 'column',
      range: 'A1:C5',
      at: 'E2:L16',
      title: 'Revenue',
      legend: 'b',
    })) as { chart: { id: string; title: string; position: string } }
    expect(created.chart).toMatchObject({
      id: 'chart1',
      title: 'Revenue',
      position: 'E2:L16',
    })
    expect(await drive.listRevisions(alice, f.id)).toHaveLength(2)

    const combo = (await tool('drive.sheet_chart_create').handler(as('alice'), {
      file_id: f.id,
      sheet: 'Data',
      type: 'column',
      series: [
        { values: 'B2:B5', categories: 'A2:A5', name_ref: 'B1' },
        { values: 'C2:C5', categories: 'A2:A5', name: 'Target', type: 'line', secondary: true },
      ],
    })) as { chart: { id: string; types: string[] } }
    expect(combo.chart.types).toEqual(['column', 'line'])

    const updated = (await tool('drive.sheet_chart_update').handler(as('alice'), {
      file_id: f.id,
      sheet: 'Data',
      chart: 'chart1',
      type: 'line',
      title: 'Updated Revenue',
      legend: 't',
      axes: {
        category: { title: 'Quarter' },
        value: { title: 'EUR', min: 0, max: 100, gridlines: false },
      },
      labels: { value: true, position: 't' },
      colors: ['#008800', '#AA0000'],
      markers: true,
      position: 'F3:M18',
    })) as { chart: Record<string, unknown> }
    expect(updated.chart).toMatchObject({
      id: 'chart1',
      types: ['line'],
      title: 'Updated Revenue',
      legend: 't',
      position: 'F3:M18',
      labels: true,
    })

    const cs = (await tool('drive.sheet_chart_create').handler(as('alice'), {
      file_id: f.id,
      sheet: 'Data',
      type: 'pie',
      range: 'A1:B5',
      new_sheet: 'Pie View',
    })) as { sheet: string; chart: { position: null } }
    expect(cs.sheet).toBe('Pie View')
    expect(cs.chart.position).toBeNull()
    const readCs = (await tool('drive.sheet_read').handler(as('alice'), {
      file_id: f.id,
      sheet: 'Pie View',
    })) as { sheet: string; charts: unknown[] }
    expect(readCs.sheet).toBe('Pie View')
    expect(readCs.charts).toHaveLength(1)

    const del = (await tool('drive.sheet_chart_delete').handler(as('alice'), {
      file_id: f.id,
      sheet: 'Data',
      chart: 'chart1',
    })) as { deleted: string }
    expect(del.deleted).toBe('chart1')
    const wb = await reread(f.id)
    expect(wb.sheets().map((s) => s.name)).toEqual(['Data', 'Pie View'])
  })

  it('enforces access, edit lock, validation errors, and never overwrites concurrent edits', async () => {
    const { drive, tool, as, upload } = await setup()
    const f = await upload()
    await drive.setGrants(alice, 'file', f.id, [
      { subject: { kind: 'user', userId: 'alice' }, level: 'manage' },
      { subject: { kind: 'user', userId: 'viewer' }, level: 'view' },
    ])
    await expect(
      tool('drive.sheet_chart_list').handler(as('viewer'), { file_id: f.id }),
    ).resolves.toMatchObject({ file: { id: f.id } })
    await expect(
      tool('drive.sheet_chart_delete').handler(as('viewer'), {
        file_id: f.id,
        sheet: 'Data',
        chart: 'chart1',
      }),
    ).rejects.toMatchObject({ code: 'forbidden' })

    await expect(
      tool('drive.sheet_chart_update').handler(as('alice'), {
        file_id: f.id,
        sheet: 'Data',
        chart: 'chart1',
      }),
    ).rejects.toMatchObject({ code: 'invalid' })

    await drive.acquireLock(alice, f.id, 'tab-1')
    await expect(
      tool('drive.sheet_chart_update').handler(as('alice'), {
        file_id: f.id,
        sheet: 'Data',
        chart: 'chart1',
        title: 'Locked',
      }),
    ).rejects.toMatchObject({ code: 'locked' })
  })
})
