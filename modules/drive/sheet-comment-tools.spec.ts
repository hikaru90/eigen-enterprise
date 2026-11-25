import type { Actor } from './service'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { delegatedPrincipal } from '$lib/kernel/principals'
import { readNotes } from '$lib/office/xlsx/notes'
import { budgetBook } from '$lib/office/xlsx/test-utils/build-xlsx'
import { commentBook } from '$lib/office/xlsx/test-utils/drawing-fixtures'
import { MEMBER_PROVIDER, readPersons, readThreads } from '$lib/office/xlsx/threads'
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
  const dir = await mkdtemp(join(tmpdir(), 'drive-sheet-comment-'))
  dirs.push(dir)
  const drive = createDriveService({
    store: memoryDriveStore(),
    blobs: diskBlobStore(dir),
    access: memoryDriveAccess({
      users: {
        alice: { role: 'member', name: 'Alice Smith' },
        bob: { role: 'member', name: 'Bob Jones' },
      },
    }),
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
  await drive.setGrants(alice, 'file', f.id, [
    { subject: { kind: 'user', userId: 'alice' }, level: 'manage' },
    { subject: { kind: 'company' }, level: 'edit' },
  ])
  const reread = async (id = f.id) => openWorkbook((await drive.readFile(alice, id)).bytes)
  return { drive, tool, as, f, reread }
}

describe('drive.sheet_comment_* registry tools', () => {
  it('are registered in Drive manifest with read/write approvals', async () => {
    const { tool } = await setup()
    expect(DRIVE_SHEET_TOOL_NAMES).toContain('drive.sheet_comment_list')
    expect(tool('drive.sheet_comment_list')).toMatchObject({ module: 'drive', auditClass: 'read' })
    for (const name of [
      'drive.sheet_comment_add',
      'drive.sheet_comment_reply',
      'drive.sheet_comment_edit',
      'drive.sheet_comment_resolve',
      'drive.sheet_comment_delete',
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

  it('lists notes and threaded comments on an Excel workbook', async () => {
    const { drive, tool, as } = await setup()
    const cf = await drive.upload(alice, null, { name: 'notes.xlsx', bytes: commentBook(), mime: XLSX }, 'fail')
    const out = (await tool('drive.sheet_comment_list').handler(as('alice'), { file_id: cf.id })) as {
      sheet: string
      notes: Array<Record<string, unknown>>
      comments: Array<Record<string, unknown>>
    }
    expect(out.sheet).toBe('Notes')
    expect(out.notes).toHaveLength(1)
    expect(out.notes[0]).toMatchObject({ ref: 'B2', visible: true })
    expect(out.comments).toHaveLength(1)
    expect(out.comments[0]).toMatchObject({ ref: 'C4', resolved: false })
  })

  it('adds, replies with @mentions, edits, resolves/reopens and deletes threaded comments mapped to company persons', async () => {
    const { tool, as, f, reread } = await setup()
    const added = (await tool('drive.sheet_comment_add').handler(as('alice'), {
      file_id: f.id,
      sheet: 'Budget',
      cell: 'B2',
      text: 'Check @Bob Jones figure',
      mentions: ['bob'],
    })) as { id: string }

    const reply = (await tool('drive.sheet_comment_reply').handler(as('bob'), {
      file_id: f.id,
      sheet: 'Budget',
      thread: added.id,
      text: 'Confirmed',
      mentions: ['alice'],
    })) as { id: string }

    // Non-author cannot edit reply
    await expect(
      tool('drive.sheet_comment_edit').handler(as('alice'), {
        file_id: f.id,
        sheet: 'Budget',
        id: reply.id,
        text: 'Tamper',
      }),
    ).rejects.toMatchObject({ code: 'invalid', message: expect.stringMatching(/Only Bob Jones/) })

    await tool('drive.sheet_comment_edit').handler(as('bob'), {
      file_id: f.id,
      sheet: 'Budget',
      id: reply.id,
      text: 'Confirmed with finance',
    })

    await tool('drive.sheet_comment_resolve').handler(as('alice'), {
      file_id: f.id,
      sheet: 'Budget',
      thread: added.id,
      resolved: true,
    })

    let wb = await reread()
    const persons = readPersons(wb)
    expect(persons.find((p) => p.userId === 'alice')).toMatchObject({
      name: 'Alice Smith',
      providerId: MEMBER_PROVIDER,
    })
    expect(persons.find((p) => p.userId === 'bob')).toMatchObject({
      name: 'Bob Jones',
      providerId: MEMBER_PROVIDER,
    })
    let threads = readThreads(wb, wb.requireWorksheet('Budget'))
    expect(threads[0]).toMatchObject({ ref: 'B2', resolved: true })
    expect(threads[0]!.comments[0]!.mentions[0]).toMatchObject({ memberId: 'bob', name: 'Bob Jones' })
    expect(threads[0]!.comments[1]!.text).toBe('Confirmed with finance')

    // Reopen, delete reply, then delete thread
    await tool('drive.sheet_comment_resolve').handler(as('alice'), {
      file_id: f.id,
      sheet: 'Budget',
      thread: added.id,
      resolved: false,
    })
    await tool('drive.sheet_comment_delete').handler(as('bob'), {
      file_id: f.id,
      sheet: 'Budget',
      id: reply.id,
    })
    await tool('drive.sheet_comment_delete').handler(as('alice'), {
      file_id: f.id,
      sheet: 'Budget',
      id: added.id,
    })
    wb = await reread()
    threads = readThreads(wb, wb.requireWorksheet('Budget'))
    expect(threads).toEqual([])
  })

  it('adds, edits (text + visible) and deletes legacy notes, and rejects unknown mentions or non-member principals', async () => {
    const { tool, as, f, reread } = await setup()
    await tool('drive.sheet_comment_add').handler(as('alice'), {
      file_id: f.id,
      sheet: 'Budget',
      cell: 'D4',
      kind: 'note',
      text: 'Initial note',
      visible: true,
    })
    await tool('drive.sheet_comment_edit').handler(as('alice'), {
      file_id: f.id,
      sheet: 'Budget',
      cell: 'D4',
      text: 'Updated note',
      visible: false,
    })
    let wb = await reread()
    expect(readNotes(wb, wb.requireWorksheet('Budget'))).toEqual([
      { ref: 'D4', row: 3, col: 3, author: 'Alice Smith', text: 'Updated note', visible: false },
    ])

    await tool('drive.sheet_comment_delete').handler(as('alice'), {
      file_id: f.id,
      sheet: 'Budget',
      cell: 'D4',
    })
    wb = await reread()
    expect(readNotes(wb, wb.requireWorksheet('Budget'))).toEqual([])

    // Unknown mention member id rejected
    await expect(
      tool('drive.sheet_comment_add').handler(as('alice'), {
        file_id: f.id,
        sheet: 'Budget',
        cell: 'A1',
        text: 'Ping',
        mentions: ['unknown-person'],
      }),
    ).rejects.toMatchObject({ code: 'invalid', message: expect.stringMatching(/No company member/) })

    // Non-member principal rejected
    await expect(
      tool('drive.sheet_comment_add').handler(
        { principal: { id: 'svc', kind: 'service', roles: ['agent'] }, requestId: 'r' },
        { file_id: f.id, sheet: 'Budget', cell: 'A1', text: 'Hi' },
      ),
    ).rejects.toMatchObject({ code: 'forbidden' })
  })
})
