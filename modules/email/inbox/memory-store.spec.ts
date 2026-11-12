import type { AttachmentRow, MailboxRow } from './store'
import { describe, expect, it } from 'vitest'
import { memoryInboxStore } from './memory-store'
import { message } from './test-fixtures'

/** The S3 additions of the in-memory store; db-store.pg.spec.ts holds Postgres to the same behaviour. */

const box = (id: string, over: Partial<MailboxRow> = {}): MailboxRow => ({
  id,
  kind: 'personal',
  ownerUserId: `owner-${id}`,
  groupId: null,
  displayName: null,
  disabledAt: null,
  createdBy: 'spec',
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
})

const attachment = (messageId: string, partIndex: number): AttachmentRow => ({
  id: `${messageId}-a${partIndex}`,
  messageId,
  partIndex,
  filename: `f${partIndex}.pdf`,
  contentType: 'application/pdf',
  sizeBytes: 10,
  contentId: null,
  checksum: 'md5',
  blocked: false,
  createdAt: new Date(),
})

async function seeded() {
  const store = memoryInboxStore()
  await store.insertMailbox(box('mb-a'), { address: 'ana@example.com', mailboxId: 'mb-a', domainId: 'd', primary: true, createdBy: 's', createdAt: new Date() })
  await store.insertAddress({ address: 'a@example.com', mailboxId: 'mb-a', domainId: 'd', primary: false, createdBy: 's', createdAt: new Date() })
  await store.insertMailbox(box('mb-b', { disabledAt: new Date() }), {
    address: 'ben@example.com',
    mailboxId: 'mb-b',
    domainId: 'd',
    primary: true,
    createdBy: 's',
    createdAt: new Date(),
  })
  return store
}

describe('memory inbox store: received mail', () => {
  it('stores a mail with its attachments once and notifies the mailbox', async () => {
    const store = await seeded()
    const m = message('mb-a', { id: 'm-1', sesMessageId: 'ses-1' }) as ReturnType<typeof message> & { sesMessageId: string }
    expect(await store.insertReceived(m, [attachment('m-1', 1), attachment('m-1', 0)])).toEqual({ stored: true })
    expect(await store.insertReceived({ ...m, id: 'm-2' }, [attachment('m-2', 0)])).toEqual({ stored: false })
    expect([...store.messages.keys()]).toEqual(['m-1'])
    expect((await store.listAttachments('m-1')).map((a) => a.partIndex)).toEqual([0, 1])
    expect(await store.listAttachments('m-2')).toEqual([])
    expect(store.notified).toEqual(['mb-a'])
  })

  it('stores the same SES mail once per mailbox', async () => {
    const store = await seeded()
    const m = message('mb-a', { id: 'm-1', sesMessageId: 'ses-1' }) as ReturnType<typeof message> & { sesMessageId: string }
    await store.insertReceived(m, [])
    expect(await store.insertReceived({ ...m, id: 'm-2', mailboxId: 'mb-b' }, [])).toEqual({ stored: true })
  })

  it('finds a thread by RFC Message-ID within one mailbox only, earliest first', async () => {
    const store = await seeded()
    await store.insertMessage(message('mb-a', { id: 'x1', messageId: 'one@s', threadId: 't-old', receivedAt: new Date('2026-11-01') }))
    await store.insertMessage(message('mb-a', { id: 'x2', messageId: 'two@s', threadId: 't-new', receivedAt: new Date('2026-11-02') }))
    await store.insertMessage(message('mb-b', { id: 'x3', messageId: 'three@s', threadId: 't-b', receivedAt: new Date('2026-11-01') }))
    expect(await store.threadOf('mb-a', ['two@s', 'one@s'])).toBe('t-old')
    expect(await store.threadOf('mb-a', ['two@s'])).toBe('t-new')
    expect(await store.threadOf('mb-a', ['three@s'])).toBeNull()
    expect(await store.threadOf('mb-a', [])).toBeNull()
  })

  it('looks up exact addresses to their mailbox, disabled ones included', async () => {
    const store = await seeded()
    const out = await store.mailboxesFor(['a@example.com', 'ben@example.com', 'nobody@example.com', 'ana@example.com'])
    expect(out.map((x) => [x.address, x.mailbox.id, x.mailbox.disabledAt !== null])).toEqual([
      ['a@example.com', 'mb-a', false],
      ['ben@example.com', 'mb-b', true],
      ['ana@example.com', 'mb-a', false],
    ])
  })
})
