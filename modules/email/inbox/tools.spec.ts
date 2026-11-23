import type { MailboxSendInput } from '../owlery/service'
import type { SendDeps } from './send'
import { describe, expect, it } from 'vitest'
import type { ToolContext, ToolDescriptor } from '$lib/kernel/types'
import { fakeRawMailSource } from './raw-source'
import { BUCKET } from './receipt-fixtures'
import { assignPersonalMailbox, createSharedMailbox, getMessage } from './service'
import { fixture, message } from './test-fixtures'
import { EMAIL_INBOX_READ_TOOLS, EMAIL_INBOX_WRITE_TOOLS } from './tool-names'
import { createInboxTools } from './tools'

/** email.mailbox_* / mail_* / label_* — the agent's hands on the inbox, as the calling person. */

const as = (id: string): ToolContext => ({ principal: { id, kind: 'human', roles: ['member'] }, requestId: 'r' })

async function setup() {
  const f = fixture()
  const ana = await assignPersonalMailbox(f.deps, 'olga', { memberId: 'ana', localPart: 'ana.lind', domainId: 'd-1' })
  const sales = await createSharedMailbox(f.deps, 'olga', { groupId: 'g-sales', localPart: 'sales', domainId: 'd-1' })
  const sent: MailboxSendInput[] = []
  const sendDeps: SendDeps = {
    inbox: f.deps,
    transport: {
      sendMailboxMail: async (input) => {
        sent.push(input)
        return { sesMessageId: `ses-out-${sent.length}` }
      },
    },
    raw: fakeRawMailSource(),
    bucket: async () => BUCKET,
  }
  let syncs = 0
  const cancelled: string[] = []
  const tools = createInboxTools({
    inbox: async () => f.deps,
    send: async () => sendDeps,
    syncReceiving: async () => {
      syncs++
      return null
    },
    cancelScheduled: async (id) => {
      cancelled.push(id)
    },
  })
  const t = (name: string): ToolDescriptor => {
    const found = tools.find((x) => x.name === name)
    if (!found) throw new Error(name)
    return found
  }
  const mail = message(ana.id, { id: '11111111-1111-4111-8111-111111111111' })
  await f.store.insertReceived({ ...mail, sesMessageId: 'ses-1' }, [
    {
      id: 'a-1',
      messageId: mail.id,
      partIndex: 0,
      filename: 'invoice.pdf',
      contentType: 'application/pdf',
      sizeBytes: 10,
      contentId: null,
      checksum: 'x',
      blocked: false,
      createdAt: mail.createdAt,
    },
  ])
  return { ...f, ana, sales, sent, tools, t, mail, syncs: () => syncs, cancelled }
}

describe('createInboxTools', () => {
  it('builds exactly the named tools; every write declares risk and activity', async () => {
    const { tools } = await setup()
    expect(tools.map((t) => t.name).sort()).toEqual([...EMAIL_INBOX_READ_TOOLS, ...EMAIL_INBOX_WRITE_TOOLS].sort())
    for (const tool of tools) {
      if ((EMAIL_INBOX_WRITE_TOOLS as readonly string[]).includes(tool.name)) {
        expect(tool.auditClass, tool.name).not.toBe('read')
        expect(tool.approvalRisk, tool.name).toBeDefined()
        expect(tool.activity, tool.name).toBeDefined()
      } else expect(tool.auditClass, tool.name).toBe('read')
    }
  })
})

describe('reading', () => {
  it('lists only the mailboxes the caller reads', async () => {
    const { t, ana, sales } = await setup()
    expect(((await t('email.mailbox_list').handler(as('ana'), {})) as { mailboxes: { id: string }[] }).mailboxes.map((b) => b.id)).toEqual([ana.id, sales.id])
    expect(((await t('email.mailbox_list').handler(as('ben'), {})) as { mailboxes: unknown[] }).mailboxes).toEqual([])
  })

  it('lists and searches a folder; another person gets not found', async () => {
    const { t, ana, mail } = await setup()
    const out = (await t('email.mail_list').handler(as('ana'), { mailboxId: ana.id, folder: 'inbox', search: 'Hello' })) as {
      messages: { id: string; hasAttachments: boolean }[]
      labels: unknown[]
    }
    expect(out.messages.map((m) => [m.id, m.hasAttachments])).toEqual([[mail.id, true]])
    const none = (await t('email.mail_list').handler(as('ana'), { mailboxId: ana.id, folder: 'inbox', search: 'zzz' })) as { messages: unknown[] }
    expect(none.messages).toEqual([])
    await expect(t('email.mail_list').handler(as('ben'), { mailboxId: ana.id, folder: 'inbox' })).rejects.toMatchObject({ code: 'not_found' })
  })

  it('reads a thread with its attachment metadata', async () => {
    const { t, mail } = await setup()
    const out = (await t('email.mail_read').handler(as('ana'), { messageId: mail.id })) as {
      messages: { id: string; textBody: string; attachments: { filename: string; sizeBytes: number }[] }[]
    }
    expect(out.messages[0]).toMatchObject({ id: mail.id, textBody: 'Hi Ana, how are you?' })
    expect(out.messages[0]!.attachments).toEqual([{ id: 'a-1', filename: 'invoice.pdf', contentType: 'application/pdf', sizeBytes: 10, blocked: false }])
    await expect(t('email.mail_read').handler(as('ben'), { messageId: mail.id })).rejects.toMatchObject({ code: 'not_found' })
  })
})

describe('working mail', () => {
  it('marks read, stars, moves and labels through the service', async () => {
    const { t, deps, mail, ana } = await setup()
    await t('email.mail_mark_read').handler(as('ana'), { messageId: mail.id, read: true })
    await t('email.mail_star').handler(as('ana'), { messageId: mail.id, starred: true })
    await t('email.mail_move').handler(as('ana'), { messageId: mail.id, folder: 'archive' })
    const label = (await t('email.label_create').handler(as('ana'), { mailboxId: ana.id, name: 'Invoices', color: 'sky' })) as { id: string }
    await t('email.mail_label').handler(as('ana'), { messageId: mail.id, labelId: label.id, on: true })
    const after = await getMessage(deps, 'ana', mail.id)
    expect([after.readAt !== null, after.starred, after.folder]).toEqual([true, true, 'archive'])
    expect(await deps.store.messageLabelIds(mail.id)).toEqual([label.id])
    await t('email.label_delete').handler(as('ana'), { labelId: label.id })
    expect(await deps.store.listLabels(ana.id)).toEqual([])
  })

  it('never more than the caller: another member cannot touch the mail', async () => {
    const { t, mail } = await setup()
    await expect(t('email.mail_star').handler(as('ben'), { messageId: mail.id, starred: true })).rejects.toMatchObject({ code: 'not_found' })
  })

  it('sends from a mailbox with a base64 attachment', async () => {
    const { t, ana, sent } = await setup()
    const out = (await t('email.mail_send').handler(as('ana'), {
      mailboxId: ana.id,
      to: 'mara@sender.example',
      subject: 'Report',
      body: 'Attached.',
      attachments: [{ filename: 'a.txt', contentType: 'text/plain', contentBase64: Buffer.from('hello').toString('base64') }],
    })) as { id: string; mailboxId: string }
    expect(out.mailboxId).toBe(ana.id)
    expect(sent).toHaveLength(1)
    expect(Buffer.from(sent[0]!.raw).toString()).toContain('a.txt')
  })

  it('refuses malformed base64', async () => {
    const { t, ana } = await setup()
    expect(
      t('email.mail_send').inputSchema.safeParse({
        mailboxId: ana.id,
        to: 'x@y.co',
        subject: 's',
        body: 'b',
        attachments: [{ filename: 'a', contentType: 'text/plain', contentBase64: '!!not base64' }],
      }).success,
    ).toBe(false)
  })
})

describe('mailbox administration', () => {
  it('admins assign, create shared, alias and disable — and receiving is synced', async () => {
    const { t, syncs } = await setup()
    const box = (await t('email.mailbox_assign').handler(as('adam'), { memberId: 'ben', localPart: 'ben', domainId: 'd-1' })) as { id: string; address: string }
    expect(box.address).toBe('ben@example.com')
    await t('email.mailbox_create_shared').handler(as('adam'), { groupId: 'g-dev', localPart: 'dev', domainId: 'd-1' })
    await t('email.mailbox_alias_add').handler(as('adam'), { mailboxId: box.id, localPart: 'b', domainId: 'd-1' })
    await t('email.mailbox_alias_remove').handler(as('adam'), { address: 'b@example.com' })
    const off = (await t('email.mailbox_set_disabled').handler(as('adam'), { mailboxId: box.id, disabled: true })) as { disabled: boolean }
    expect(off.disabled).toBe(true)
    expect(syncs()).toBe(5)
    const admin = (await t('email.mailbox_admin').handler(as('adam'), {})) as { mailboxes: unknown[] }
    expect(admin.mailboxes).toHaveLength(4)
  })

  it('a member cannot administer mailboxes', async () => {
    const { t } = await setup()
    await expect(t('email.mailbox_assign').handler(as('ana'), { memberId: 'ben', localPart: 'ben', domainId: 'd-1' })).rejects.toMatchObject({ code: 'forbidden' })
    await expect(t('email.mailbox_admin').handler(as('ana'), {})).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('create_mine gives the caller (owner/admin) their own mailbox', async () => {
    const { t } = await setup()
    const box = (await t('email.mailbox_create_mine').handler(as('olga'), { localPart: 'olga', domainId: 'd-1' })) as { address: string }
    expect(box.address).toBe('olga@example.com')
  })

  it('cancels a queued mail', async () => {
    const { t, cancelled } = await setup()
    await t('email.log_cancel').handler(as('adam'), { id: '22222222-2222-4222-8222-222222222222' })
    expect(cancelled).toEqual(['22222222-2222-4222-8222-222222222222'])
  })
})
