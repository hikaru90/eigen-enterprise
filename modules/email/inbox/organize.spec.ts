import { describe, expect, it } from 'vitest'
import {
  assignPersonalMailbox,
  createLabel,
  createSharedMailbox,
  deleteLabel,
  listFolder,
  listLabels,
  setMessageLabel,
} from './service'
import { fixture, message } from './test-fixtures'

/**
 * Organising mail (owner, 2026-11-14: "an inbox has a way to sort mail, filter the inbox, categories, folders,
 * labels"): filters (unread, with attachments), sort order, the Starred view across folders, and labels per mailbox.
 */

const at = (iso: string) => new Date(iso)

async function setup() {
  const f = fixture()
  const ana = await assignPersonalMailbox(f.deps, 'olga', { memberId: 'ana', localPart: 'ana.lind', domainId: 'd-1' })
  const sales = await createSharedMailbox(f.deps, 'olga', { groupId: 'g-sales', localPart: 'sales', domainId: 'd-1' })
  const put = (id: string, over: Parameters<typeof message>[1] = {}) =>
    f.store.insertMessage(message(over.mailboxId ?? ana.id, { id, sesMessageId: id, ...over }))
  await put('old', { receivedAt: at('2026-11-01T00:00:00Z'), readAt: at('2026-11-02T00:00:00Z') })
  await put('mid', { receivedAt: at('2026-11-05T00:00:00Z'), starred: true })
  await put('new', { receivedAt: at('2026-11-09T00:00:00Z') })
  await put('arch', { folder: 'archive', starred: true, receivedAt: at('2026-11-03T00:00:00Z') })
  await put('junk', { folder: 'spam', starred: true, receivedAt: at('2026-11-04T00:00:00Z') })
  f.store.attachments.set('att', {
    id: 'att',
    messageId: 'mid',
    partIndex: 0,
    filename: 'a.pdf',
    contentType: 'application/pdf',
    sizeBytes: 10,
    contentId: null,
    checksum: 'x',
    blocked: false,
    createdAt: at('2026-11-05T00:00:00Z'),
  })
  return { ...f, ana, sales }
}

const ids = (list: { id: string }[]) => list.map((m) => m.id)

describe('filters and sort', () => {
  it('newest first by default, oldest first on request', async () => {
    const { deps, ana } = await setup()
    expect(ids(await listFolder(deps, 'ana', { mailboxId: ana.id, folder: 'inbox' }))).toEqual(['new', 'mid', 'old'])
    expect(ids(await listFolder(deps, 'ana', { mailboxId: ana.id, folder: 'inbox', sort: 'oldest' }))).toEqual(['old', 'mid', 'new'])
  })

  it('unread only, and with attachments only', async () => {
    const { deps, ana } = await setup()
    expect(ids(await listFolder(deps, 'ana', { mailboxId: ana.id, folder: 'inbox', filter: 'unread' }))).toEqual(['new', 'mid'])
    expect(ids(await listFolder(deps, 'ana', { mailboxId: ana.id, folder: 'inbox', filter: 'attachments' }))).toEqual(['mid'])
  })

  it('says which listed mail has attachments', async () => {
    const { deps, ana } = await setup()
    const list = await listFolder(deps, 'ana', { mailboxId: ana.id, folder: 'inbox' })
    expect(list.map((m) => [m.id, m.hasAttachments])).toEqual([
      ['new', false],
      ['mid', true],
      ['old', false],
    ])
  })

  it('Starred spans the folders, never Spam or Trash', async () => {
    const { deps, ana } = await setup()
    expect(ids(await listFolder(deps, 'ana', { mailboxId: ana.id, view: 'starred' }))).toEqual(['mid', 'arch'])
  })
})

describe('labels', () => {
  it('are created per mailbox, listed by name, and refuse a duplicate name', async () => {
    const { deps, ana, sales } = await setup()
    await createLabel(deps, 'ana', { mailboxId: ana.id, name: '  Invoices ', color: 'coral' })
    await createLabel(deps, 'ana', { mailboxId: ana.id, name: 'Clients', color: 'slate' })
    expect((await listLabels(deps, 'ana', ana.id)).map((l) => [l.name, l.color])).toEqual([
      ['Clients', 'slate'],
      ['Invoices', 'coral'],
    ])
    await expect(createLabel(deps, 'ana', { mailboxId: ana.id, name: 'invoices', color: 'sage' })).rejects.toMatchObject({
      code: 'invalid',
      message: 'There is already a label called “Invoices”.',
    })
    // Another mailbox has its own labels.
    expect(await listLabels(deps, 'sam', sales.id)).toEqual([])
  })

  it('refuse an empty or overlong name and an unknown colour', async () => {
    const { deps, ana } = await setup()
    await expect(createLabel(deps, 'ana', { mailboxId: ana.id, name: '  ', color: 'coral' })).rejects.toMatchObject({ code: 'invalid' })
    await expect(createLabel(deps, 'ana', { mailboxId: ana.id, name: 'x'.repeat(41), color: 'coral' })).rejects.toMatchObject({
      code: 'invalid',
    })
    await expect(createLabel(deps, 'ana', { mailboxId: ana.id, name: 'Ok', color: 'neon' })).rejects.toMatchObject({ code: 'invalid' })
  })

  it('go on and off a mail; the label view lists its mail across folders (not Spam or Trash)', async () => {
    const { deps, ana } = await setup()
    const label = await createLabel(deps, 'ana', { mailboxId: ana.id, name: 'Clients', color: 'slate' })
    await setMessageLabel(deps, 'ana', { messageId: 'old', labelId: label.id, on: true })
    await setMessageLabel(deps, 'ana', { messageId: 'arch', labelId: label.id, on: true })
    await setMessageLabel(deps, 'ana', { messageId: 'junk', labelId: label.id, on: true })
    // Twice on is still on once.
    await setMessageLabel(deps, 'ana', { messageId: 'old', labelId: label.id, on: true })
    expect(ids(await listFolder(deps, 'ana', { mailboxId: ana.id, labelId: label.id }))).toEqual(['arch', 'old'])
    const inbox = await listFolder(deps, 'ana', { mailboxId: ana.id, folder: 'inbox' })
    expect(inbox.find((m) => m.id === 'old')!.labelIds).toEqual([label.id])
    await setMessageLabel(deps, 'ana', { messageId: 'old', labelId: label.id, on: false })
    expect(ids(await listFolder(deps, 'ana', { mailboxId: ana.id, labelId: label.id }))).toEqual(['arch'])
  })

  it('removing a label takes it off every mail, the mail stays', async () => {
    const { deps, ana } = await setup()
    const label = await createLabel(deps, 'ana', { mailboxId: ana.id, name: 'Clients', color: 'slate' })
    await setMessageLabel(deps, 'ana', { messageId: 'old', labelId: label.id, on: true })
    await deleteLabel(deps, 'ana', { labelId: label.id })
    expect(await listLabels(deps, 'ana', ana.id)).toEqual([])
    const inbox = await listFolder(deps, 'ana', { mailboxId: ana.id, folder: 'inbox' })
    expect(inbox.find((m) => m.id === 'old')!.labelIds).toEqual([])
  })

  it('are not found for anyone who may not read the mailbox, and never cross mailboxes', async () => {
    const { deps, ana, sales, store } = await setup()
    const label = await createLabel(deps, 'ana', { mailboxId: ana.id, name: 'Clients', color: 'slate' })
    await expect(listLabels(deps, 'ben', ana.id)).rejects.toMatchObject({ code: 'not_found' })
    await expect(createLabel(deps, 'ben', { mailboxId: ana.id, name: 'X', color: 'slate' })).rejects.toMatchObject({ code: 'not_found' })
    await expect(deleteLabel(deps, 'ben', { labelId: label.id })).rejects.toMatchObject({ code: 'not_found' })
    await expect(setMessageLabel(deps, 'ben', { messageId: 'old', labelId: label.id, on: true })).rejects.toMatchObject({
      code: 'not_found',
    })
    // A sales mail can't carry Ana's label, even for someone who reads both.
    await store.insertMessage(message(sales.id, { id: 'sale', sesMessageId: 'sale' }))
    await expect(setMessageLabel(deps, 'ana', { messageId: 'sale', labelId: label.id, on: true })).rejects.toMatchObject({
      code: 'not_found',
    })
  })
})
