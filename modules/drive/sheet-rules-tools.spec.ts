import type { Actor } from './service'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { InMemoryApprovalStore, StaticApprovalPolicy } from '$lib/kernel/approvals'
import { delegatedPrincipal } from '$lib/kernel/principals'
import { KernelRegistry } from '$lib/kernel/registry'
import { cfRulesOf } from '$lib/office/xlsx/cond-format'
import { hyperlinksOf } from '$lib/office/xlsx/hyperlinks'
import { listNames } from '$lib/office/xlsx/names'
import {
  cellProtectionReader,
  sheetProtectionOf,
  workbookProtectionOf,
} from '$lib/office/xlsx/protection'
import { buildXlsx, num, row, str } from '$lib/office/xlsx/test-utils/build-xlsx'
import { validationsOf } from '$lib/office/xlsx/validation'
import { openWorkbook } from '$lib/office/xlsx/workbook'
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

const bookBytes = () =>
  buildXlsx({
    strings: ['Label', 'Yes', 'No'],
    sheets: [
      {
        name: 'Data',
        rows:
          row(1, str('A1', 0) + num('B1', 10) + num('C1', 50)) +
          row(2, str('A2', 1) + num('B2', 120) + num('C2', 200)),
      },
      { name: 'Notes', rows: row(1, num('A1', 1)) },
    ],
  })

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'drive-sheet-rules-'))
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
  const f = await drive.upload(
    alice,
    null,
    { name: 'rules.xlsx', bytes: bookBytes(), mime: XLSX },
    'fail',
  )
  const reread = async () => openWorkbook((await drive.readFile(alice, f.id)).bytes)
  return { drive, tool, as, f, reread }
}

describe('drive.sheet_* rules, links, names and protection tools', () => {
  it('registers all 11 tools with read/mutate audit classes and never logs passwords', async () => {
    const { tool } = await setup()
    const readTools = ['drive.sheet_conditional_format_list', 'drive.sheet_names_list']
    const writeTools = [
      'drive.sheet_conditional_format_set',
      'drive.sheet_conditional_format_delete',
      'drive.sheet_validation_set',
      'drive.sheet_validation_clear',
      'drive.sheet_hyperlink_set',
      'drive.sheet_hyperlink_remove',
      'drive.sheet_names_set',
      'drive.sheet_names_delete',
      'drive.sheet_protect',
    ]
    for (const n of [...readTools, ...writeTools]) {
      expect(DRIVE_SHEET_TOOL_NAMES).toContain(n)
      expect(DRIVE_TOOL_NAMES).toContain(n)
    }
    for (const n of readTools)
      expect(tool(n)).toMatchObject({ module: 'drive', auditClass: 'read' })
    for (const n of writeTools) {
      expect(DRIVE_SHEET_WRITE_TOOLS).toContain(n)
      expect(tool(n)).toMatchObject({
        module: 'drive',
        auditClass: 'mutate',
        approvalRisk: 'internal',
      })
    }
    const line = tool('drive.sheet_protect').activity!(
      { file_id: 'f', action: 'protect_sheet', sheet: 'Data', password: 'TOP_SECRET_PASSWORD' },
      { file: { name: 'rules.xlsx' } },
    )
    expect(line).toBe('Protected sheet Data in rules.xlsx in Drive')
    expect(line).not.toContain('TOP_SECRET_PASSWORD')
  })

  it('adds, lists, updates, reorders and deletes conditional formatting rules', async () => {
    const { drive, tool, as, f, reread } = await setup()
    await tool('drive.sheet_conditional_format_set').handler(as('alice'), {
      file_id: f.id,
      sheet: 'Data',
      range: 'B1:C2',
      rule: {
        type: 'cellIs',
        operator: 'greaterThan',
        formula1: '100',
        style: { fill: '#FFC7CE', bold: true },
      },
    })
    await tool('drive.sheet_conditional_format_set').handler(as('alice'), {
      file_id: f.id,
      sheet: 'Data',
      range: 'B1:B2',
      rule: { type: 'dataBar', bar: { color: '#638EC6', negative_color: '#FF0000' } },
    })
    const listed = (await tool('drive.sheet_conditional_format_list').handler(as('alice'), {
      file_id: f.id,
      sheet: 'Data',
    })) as { rules: Array<Record<string, unknown>> }
    expect(listed.rules).toHaveLength(2)
    expect(listed.rules[0]).toMatchObject({ priority: 1, type: 'dataBar', sqref: 'B1:B2' })
    expect(listed.rules[1]).toMatchObject({ priority: 2, type: 'cellIs', sqref: 'B1:C2' })

    // Reorder priority 2 to 1 and update stop_if_true.
    await tool('drive.sheet_conditional_format_set').handler(as('alice'), {
      file_id: f.id,
      sheet: 'Data',
      priority: 2,
      move_to: 1,
    })
    expect(cfRulesOf(await reread(), 'Data').map((r) => r.type)).toEqual(['cellIs', 'dataBar'])

    await tool('drive.sheet_conditional_format_delete').handler(as('alice'), {
      file_id: f.id,
      sheet: 'Data',
      priority: 1,
    })
    expect(cfRulesOf(await reread(), 'Data')).toHaveLength(1)
    await tool('drive.sheet_conditional_format_delete').handler(as('alice'), {
      file_id: f.id,
      sheet: 'Data',
      range: null,
    })
    expect(cfRulesOf(await reread(), 'Data')).toHaveLength(0)
    expect((await drive.listRevisions(alice, f.id)).length).toBeGreaterThanOrEqual(5)
  })

  it('sets and clears data validation and hyperlinks, visible in drive.sheet_read', async () => {
    const { tool, as, f, reread } = await setup()
    await tool('drive.sheet_validation_set').handler(as('alice'), {
      file_id: f.id,
      sheet: 'Data',
      range: 'A1:A5',
      type: 'list',
      items: ['Yes', 'No'],
      error_style: 'stop',
      error_title: 'Bad',
      error_message: 'Pick Yes or No',
    })
    expect(validationsOf(await reread(), 'Data')).toHaveLength(1)

    await tool('drive.sheet_hyperlink_set').handler(as('alice'), {
      file_id: f.id,
      sheet: 'Data',
      range: 'A1',
      target: 'https://example.com',
      tooltip: 'Home',
    })
    expect(hyperlinksOf(await reread(), 'Data')).toHaveLength(1)

    const read = (await tool('drive.sheet_read').handler(as('alice'), { file_id: f.id })) as {
      validations: unknown[]
      invalid_cells: string[]
      hyperlinks: unknown[]
    }
    expect(read.validations).toHaveLength(1)
    // Circle Invalid Data: A1 holds "Label" (not Yes/No), A2 "Yes" passes.
    expect(read.invalid_cells).toEqual(['A1'])
    expect(read.hyperlinks).toHaveLength(1)

    await tool('drive.sheet_validation_clear').handler(as('alice'), {
      file_id: f.id,
      sheet: 'Data',
      range: 'A1:A5',
    })
    await tool('drive.sheet_hyperlink_remove').handler(as('alice'), {
      file_id: f.id,
      sheet: 'Data',
      range: 'A1',
    })
    const wb = await reread()
    expect(validationsOf(wb, 'Data')).toHaveLength(0)
    expect(hyperlinksOf(wb, 'Data')).toHaveLength(0)
  })

  it('lists, adds, updates/renames and deletes defined names', async () => {
    const { tool, as, f, reread } = await setup()
    await tool('drive.sheet_names_set').handler(as('alice'), {
      file_id: f.id,
      name: 'Rate',
      refers_to: '=0.2',
      comment: 'Tax rate',
    })
    await tool('drive.sheet_names_set').handler(as('alice'), {
      file_id: f.id,
      name: 'LocalItem',
      scope: 'Data',
      refers_to: '=Data!$B$1',
    })
    await tool('drive.sheet_names_set').handler(as('alice'), {
      file_id: f.id,
      name: 'Rate',
      new_name: 'VatRate',
      refers_to: '=0.19',
    })
    const listed = (await tool('drive.sheet_names_list').handler(as('alice'), {
      file_id: f.id,
    })) as { names: Array<{ name: string; scope: string | null }> }
    expect(listed.names.map((n) => [n.name, n.scope])).toEqual([
      ['LocalItem', 'Data'],
      ['VatRate', null],
    ])
    await tool('drive.sheet_names_delete').handler(as('alice'), { file_id: f.id, name: 'VatRate' })
    expect(listNames(await reread()).map((n) => n.name)).toEqual(['LocalItem'])
  })

  it('protects and unprotects sheets, cell lock flags and workbook structure without leaking passwords', async () => {
    const { tool, as, f, reread } = await setup()
    await tool('drive.sheet_protect').handler(as('alice'), {
      file_id: f.id,
      action: 'set_cell_protection',
      sheet: 'Data',
      range: 'B1',
      locked: false,
      hidden: true,
    })
    const res = (await tool('drive.sheet_protect').handler(as('alice'), {
      file_id: f.id,
      action: 'protect_sheet',
      sheet: 'Data',
      password: 'pw1',
      allow: { sort: true },
    })) as Record<string, unknown>
    expect(JSON.stringify(res)).not.toContain('pw1')
    expect(res.sheet_protection).toMatchObject({ has_password: true, allow: { sort: true } })

    // Protected sheet blocks editing locked A1, allows unlocked B1, and refuses wrong password.
    await expect(
      tool('drive.sheet_write').handler(as('alice'), {
        file_id: f.id,
        sheet: 'Data',
        cells: [{ ref: 'A1', value: 'hacked' }],
      }),
    ).rejects.toMatchObject({ code: 'invalid', message: expect.stringMatching(/locked/) })
    await tool('drive.sheet_write').handler(as('alice'), {
      file_id: f.id,
      sheet: 'Data',
      cells: [{ ref: 'B1', value: 99 }],
    })
    await expect(
      tool('drive.sheet_protect').handler(as('alice'), {
        file_id: f.id,
        action: 'unprotect_sheet',
        sheet: 'Data',
        password: 'wrong',
      }),
    ).rejects.toMatchObject({ code: 'invalid', message: expect.stringMatching(/not correct/) })
    await tool('drive.sheet_protect').handler(as('alice'), {
      file_id: f.id,
      action: 'unprotect_sheet',
      sheet: 'Data',
      password: 'pw1',
    })
    await tool('drive.sheet_protect').handler(as('alice'), {
      file_id: f.id,
      action: 'protect_workbook',
      password: 'bookpw',
    })
    await expect(
      tool('drive.sheet_structure').handler(as('alice'), {
        file_id: f.id,
        changes: [{ action: 'add_sheet', name: 'Extra' }],
      }),
    ).rejects.toMatchObject({
      code: 'invalid',
      message: expect.stringMatching(/structure is protected/),
    })
    await tool('drive.sheet_protect').handler(as('alice'), {
      file_id: f.id,
      action: 'unprotect_workbook',
      password: 'bookpw',
    })
    const wb = await reread()
    expect(sheetProtectionOf(wb, 'Data')).toBeNull()
    expect(workbookProtectionOf(wb)).toBeNull()
    expect(cellProtectionReader(wb, 'Data')(0, 1)).toEqual({ locked: false, hidden: true })
  })

  it('an approval of drive.sheet_protect stores no password, and the approved call still protects with it', async () => {
    const { tool, as, f, reread } = await setup()
    const store = new InMemoryApprovalStore()
    const registry = new KernelRegistry({
      approvalPolicy: new StaticApprovalPolicy(new Set(['drive.sheet_protect'])),
      approvalStore: store,
    })
    registry.register(tool('drive.sheet_protect'))
    const call = {
      file_id: f.id,
      action: 'protect_sheet',
      sheet: 'Data',
      password: 'TOP_SECRET_PASSWORD',
    }
    await expect(registry.execute('drive.sheet_protect', call, as('alice'))).rejects.toMatchObject({
      code: 'approval_required',
    })
    const [pending] = await store.listPending()
    expect(JSON.stringify(pending)).not.toContain('TOP_SECRET_PASSWORD')
    expect(pending!.input).toMatchObject({ action: 'protect_sheet', password: '[REDACTED]' })
    await store.decide(pending!.id, 'approved', 'owner')
    await registry.execute('drive.sheet_protect', call, as('alice'))
    expect(sheetProtectionOf(await reread(), 'Data')?.hasPassword).toBe(true)
    // The approved call ran with the real password: it unprotects.
    await tool('drive.sheet_protect').handler(as('alice'), {
      file_id: f.id,
      action: 'unprotect_sheet',
      sheet: 'Data',
      password: 'TOP_SECRET_PASSWORD',
    })
    expect(sheetProtectionOf(await reread(), 'Data')).toBeNull()
  })
})
