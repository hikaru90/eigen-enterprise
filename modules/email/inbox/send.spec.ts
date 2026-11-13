import type { MailboxSendInput } from '../owlery/service'
import { simpleParser } from 'mailparser'
import { describe, expect, it } from 'vitest'
import { MailSetupError } from '$lib/server/mail/company-mail'
import { ingestReceived, parseReceipt } from './ingest'
import { PDF_BYTES, WITH_ATTACHMENT } from './mime-fixtures'
import { fakeRawMailSource } from './raw-source'
import { BUCKET, received } from './receipt-fixtures'
import { composeDraft, sendInvitation, sendMail, type SendDeps, type SendInput } from './send'
import { addAlias, assignPersonalMailbox, createSharedMailbox, getThread, setMailboxDisabled } from './service'
import { fixture, message } from './test-fixtures'

/** S5: sending from a mailbox — access, the raw mail, the Sent copy, forwards, errors. */

async function setup() {
  const f = fixture()
  const ana = await assignPersonalMailbox(f.deps, 'olga', { memberId: 'ana', localPart: 'ana.lind', domainId: 'd-1' })
  const sales = await createSharedMailbox(f.deps, 'olga', { groupId: 'g-sales', localPart: 'sales', domainId: 'd-1', displayName: 'Acme Sales' })
  const sent: MailboxSendInput[] = []
  let fail: Error | null = null
  const raw = fakeRawMailSource()
  const deps: SendDeps = {
    inbox: f.deps,
    transport: {
      sendMailboxMail: async (input) => {
        if (fail) throw fail
        sent.push(input)
        return { sesMessageId: `ses-out-${sent.length}` }
      },
    },
    raw,
    bucket: async () => BUCKET,
  }
  return { ...f, ana, sales, sent, raw, deps, failWith: (e: Error | null) => (fail = e) }
}

const base = (mailboxId: string, over: Partial<SendInput> = {}): SendInput => ({
  mailboxId,
  mode: 'new',
  parentId: null,
  to: 'Mara Voss <mara@sender.example>',
  cc: '',
  bcc: '',
  subject: 'Hello',
  body: 'Hi Mara',
  uploads: [],
  ...over,
})

async function parsedRaw(input: MailboxSendInput) {
  return simpleParser(Buffer.from(input.raw))
}

describe('sendMail: who may send', () => {
  it('only someone who reads the mailbox — not the owner, not an admin', async () => {
    const { deps, ana, sales, sent } = await setup()
    for (const who of ['olga', 'adam', 'ben', 'sam', 'nobody']) {
      await expect(sendMail(deps, who, base(ana.id))).rejects.toMatchObject({ code: 'not_found' })
    }
    await expect(sendMail(deps, 'ben', base(sales.id))).rejects.toMatchObject({ code: 'not_found' })
    await expect(sendMail(deps, 'sam', base(sales.id))).resolves.toMatchObject({ mailboxId: sales.id })
    expect(sent).toHaveLength(1)
  })

  it('never from a disabled mailbox', async () => {
    const { deps, ana, sent } = await setup()
    await setMailboxDisabled(deps.inbox, 'olga', { mailboxId: ana.id, disabled: true })
    await expect(sendMail(deps, 'ana', base(ana.id))).rejects.toMatchObject({
      code: 'invalid',
      message: 'ana.lind@example.com is disabled, so no mail can be sent from it.',
    })
    expect(sent).toEqual([])
  })

  it('refuses a parent mail from another mailbox', async () => {
    const { deps, store, ana, sales } = await setup()
    await store.insertMessage(message(sales.id, { id: 'p-sales', sesMessageId: 'x' }))
    await expect(sendMail(deps, 'ana', base(ana.id, { mode: 'reply', parentId: 'p-sales' }))).rejects.toMatchObject({ code: 'not_found' })
  })
})

describe('sendMail: new mail', () => {
  it('goes out From the mailbox with the member’s name, To/Cc in the headers, Bcc only in the envelope', async () => {
    const { deps, ana, sent } = await setup()
    await sendMail(deps, 'ana', base(ana.id, { to: 'mara@sender.example, ben@x.co', cc: 'carl@x.co', bcc: 'Boss <boss@x.co>' }))
    expect(sent[0]!.fromAddress).toBe('ana.lind@example.com')
    expect(sent[0]!.recipients).toEqual({ to: ['mara@sender.example', 'ben@x.co'], cc: ['carl@x.co'], bcc: ['boss@x.co'] })
    const mail = await parsedRaw(sent[0]!)
    expect(mail.from?.value).toEqual([{ name: 'Ana Lind', address: 'ana.lind@example.com' }])
    expect(mail.to && !Array.isArray(mail.to) ? mail.to.value.map((v) => v.address) : null).toEqual(['mara@sender.example', 'ben@x.co'])
    expect(mail.bcc).toBeUndefined()
    expect(mail.messageId).toMatch(/^<[0-9a-f-]+@example\.com>$/)
    expect(mail.inReplyTo).toBeUndefined()
    expect(mail.text?.trim()).toBe('Hi Mara')
  })

  it('a shared mailbox uses its own display name', async () => {
    const { deps, sales, sent } = await setup()
    await sendMail(deps, 'sam', base(sales.id))
    expect((await parsedRaw(sent[0]!)).from?.value).toEqual([{ name: 'Acme Sales', address: 'sales@example.com' }])
  })

  it('files a read copy in Sent, in a new thread, with the SES id and no verdicts, and tells open tabs', async () => {
    const { deps, store, ana, sent } = await setup()
    store.notified.length = 0
    const out = await sendMail(deps, 'ana', base(ana.id, { bcc: 'boss@x.co' }))
    const copy = (await store.getMessage(out.id))!
    const mail = await parsedRaw(sent[0]!)
    expect(copy).toMatchObject({
      folder: 'sent',
      threadId: out.threadId,
      sesMessageId: 'ses-out-1',
      messageId: mail.messageId!.slice(1, -1),
      references: [],
      verdicts: null,
      rawS3Key: null,
      subject: 'Hello',
      textBody: 'Hi Mara',
      from: { name: 'Ana Lind', address: 'ana.lind@example.com' },
      to: [{ name: 'Mara Voss', address: 'mara@sender.example' }],
      bcc: [{ name: null, address: 'boss@x.co' }],
    })
    expect(copy.readAt).not.toBeNull()
    // The raw References end with our own id (SES may replace the Message-ID header).
    expect(mail.references).toBe(mail.messageId)
    expect(store.notified).toEqual([ana.id])
  })

  it('keeps sanitized uploads within 25 MB; the Sent copy lists them (metadata only)', async () => {
    const { deps, store, ana, sent } = await setup()
    const out = await sendMail(
      deps,
      'ana',
      base(ana.id, { uploads: [{ filename: '../secret/plan v2.pdf', contentType: 'application/pdf', bytes: new Uint8Array(PDF_BYTES) }] }),
    )
    const mail = await parsedRaw(sent[0]!)
    expect(mail.attachments.map((a) => [a.filename, a.contentType])).toEqual([['plan v2.pdf', 'application/pdf']])
    expect(await store.listAttachments(out.id)).toMatchObject([{ partIndex: 0, filename: 'plan v2.pdf', sizeBytes: PDF_BYTES.byteLength, blocked: false }])
    const big = new Uint8Array(26 * 1024 * 1024)
    await expect(sendMail(deps, 'ana', base(ana.id, { uploads: [{ filename: 'big.bin', contentType: 'x', bytes: big }] }))).rejects.toThrow(
      /at most 25 MB of attachments/,
    )
  })

  it('refuses bad input in plain words and sends nothing', async () => {
    const { deps, ana, sent } = await setup()
    await expect(sendMail(deps, 'ana', base(ana.id, { to: '' }))).rejects.toThrow('Add at least one recipient in To, Cc or Bcc.')
    await expect(sendMail(deps, 'ana', base(ana.id, { cc: 'nope' }))).rejects.toThrow(/“nope” in Cc isn’t an email address/)
    await expect(sendMail(deps, 'ana', base(ana.id, { subject: 'x'.repeat(501) }))).rejects.toThrow(/subject under 500/)
    expect(sent).toEqual([])
  })

  it('stores nothing when Amazon refuses (the error reaches the form as is)', async () => {
    const { deps, store, ana, failWith } = await setup()
    failWith(new MailSetupError('Amazon SES is still in its sandbox, so it only delivers to verified addresses. Request production access in the AWS console.'))
    await expect(sendMail(deps, 'ana', base(ana.id))).rejects.toThrow(/sandbox/)
    expect([...store.messages.values()]).toEqual([])
  })
})

describe('sendMail: reply and forward', () => {
  async function withReceived() {
    const s = await setup()
    s.raw.objects.set(`${BUCKET}/ses-msg-1`, Buffer.from(WITH_ATTACHMENT))
    const parsed = parseReceipt(received())
    if (parsed.kind !== 'received') throw new Error('fixture')
    await ingestReceived({ store: s.store, raw: s.raw, log: () => {}, received: async () => {} }, parsed.notification, BUCKET)
    const parent = [...s.store.messages.values()][0]!
    return { ...s, parent }
  }

  it('a reply threads: In-Reply-To = the parent, References = its chain + it, the copy joins its thread', async () => {
    const { deps, store, ana, parent, sent } = await withReceived()
    // The fixture clock runs from 09:00; the received mail came in before that.
    store.messages.set(parent.id, { ...parent, references: ['root@sender.example'], receivedAt: new Date('2026-11-12T08:00:00Z') })
    const out = await sendMail(deps, 'ana', base(ana.id, { mode: 'reply', parentId: parent.id, subject: 'Re: Contract' }))
    const mail = await parsedRaw(sent[0]!)
    expect(mail.inReplyTo).toBe('<contract-1@sender.example>')
    expect(mail.references).toEqual(['<root@sender.example>', '<contract-1@sender.example>', mail.messageId])
    expect(mail.attachments).toEqual([])
    expect(out.threadId).toBe(parent.threadId)
    expect((await store.getMessage(out.id))!.references).toEqual(['root@sender.example', 'contract-1@sender.example'])
    const thread = await getThread(deps.inbox, 'ana', parent.id)
    expect(thread.messages.map((m) => m.folder)).toEqual(['inbox', 'sent'])
  })

  it('a reply to the Sent copy threads back on ingest', async () => {
    const { deps, store, ana } = await setup()
    const out = await sendMail(deps, 'ana', base(ana.id))
    const ours = (await store.getMessage(out.id))!.messageId!
    expect(await store.threadOf(ana.id, [ours])).toBe(out.threadId)
  })

  it('a forward re-attaches the original’s attachments read again from the raw mail', async () => {
    const { deps, ana, parent, sent, raw } = await withReceived()
    raw.reads.length = 0
    const out = await sendMail(deps, 'ana', base(ana.id, { mode: 'forward', parentId: parent.id, subject: 'Fwd: Contract', to: 'lawyer@x.co' }))
    expect(raw.reads).toEqual([`${BUCKET}/ses-msg-1`])
    const mail = await parsedRaw(sent[0]!)
    expect(mail.inReplyTo).toBeUndefined()
    expect(mail.attachments.map((a) => a.filename).sort()).toEqual(['contract.pdf', 'logo.gif'])
    expect(Buffer.from(mail.attachments.find((a) => a.filename === 'contract.pdf')!.content).equals(PDF_BYTES)).toBe(true)
    expect(out.threadId).toBe(parent.threadId)
  })

  it('never forwards a blocked (virus) attachment', async () => {
    const { deps, store, ana, parent, sent } = await withReceived()
    for (const a of await store.listAttachments(parent.id)) store.attachments.set(a.id, { ...a, blocked: true })
    await sendMail(deps, 'ana', base(ana.id, { mode: 'forward', parentId: parent.id, to: 'lawyer@x.co' }))
    expect((await parsedRaw(sent[0]!)).attachments).toEqual([])
  })
})

describe('composeDraft', () => {
  it('new mail: From is the mailbox you are in, the choices are the ones you may send from', async () => {
    const { deps, ana, sales } = await setup()
    const d = await composeDraft(deps.inbox, 'ana', { mailboxId: sales.id, mode: 'new', parentId: null })
    expect(d).toMatchObject({ fromMailboxId: sales.id, to: '', subject: '', body: '', blocked: null })
    expect(d.fromChoices.map((c) => [c.address, c.name])).toEqual([
      ['ana.lind@example.com', 'Ana Lind'],
      ['sales@example.com', 'Acme Sales'],
    ])
    await setMailboxDisabled(deps.inbox, 'olga', { mailboxId: sales.id, disabled: true })
    const fallback = await composeDraft(deps.inbox, 'ana', { mailboxId: sales.id, mode: 'new', parentId: null })
    expect(fallback.fromMailboxId).toBe(ana.id)
    await setMailboxDisabled(deps.inbox, 'olga', { mailboxId: ana.id, disabled: true })
    const none = await composeDraft(deps.inbox, 'ana', { mailboxId: ana.id, mode: 'new', parentId: null })
    expect(none).toMatchObject({ fromMailboxId: null, blocked: 'ana.lind@example.com is disabled, so no mail can be sent from it.' })
  })

  it('reply all: sender + To + Cc minus our own addresses (aliases too), Re: subject, quoted text', async () => {
    const { deps, store, ana } = await setup()
    await addAlias(deps.inbox, 'olga', { mailboxId: ana.id, localPart: 'ana', domainId: 'd-1' })
    await store.insertMessage(
      message(ana.id, {
        id: 'p1',
        to: [{ name: null, address: 'ana.lind@example.com' }, { name: 'Ben', address: 'ben@x.co' }],
        cc: [{ name: null, address: 'ana@example.com' }],
      }),
    )
    const d = await composeDraft(deps.inbox, 'ana', { mailboxId: ana.id, mode: 'replyAll', parentId: 'p1' })
    expect(d).toMatchObject({ to: 'Mara Voss <mara@sender.example>, Ben <ben@x.co>', cc: '', subject: 'Re: Hello', parentId: 'p1' })
    expect(d.body).toContain('Mara Voss <mara@sender.example> wrote:\n> Hi Ana, how are you?')
    const r = await composeDraft(deps.inbox, 'ana', { mailboxId: ana.id, mode: 'reply', parentId: 'p1' })
    expect(r.to).toBe('Mara Voss <mara@sender.example>')
  })

  it('forward: Fwd: subject, the forwarded block, and which attachments it carries and which it can’t', async () => {
    const { deps, store, ana } = await setup()
    await store.insertReceived({ ...message(ana.id, { id: 'p2', sesMessageId: 's-p2' }), sesMessageId: 's-p2' }, [
      { id: 'a1', messageId: 'p2', partIndex: 0, filename: 'ok.pdf', contentType: 'application/pdf', sizeBytes: 10, contentId: null, checksum: 'x', blocked: false, createdAt: new Date() },
      { id: 'a2', messageId: 'p2', partIndex: 1, filename: 'bad.exe', contentType: 'application/octet-stream', sizeBytes: 5, contentId: null, checksum: 'y', blocked: true, createdAt: new Date() },
    ])
    const d = await composeDraft(deps.inbox, 'ana', { mailboxId: ana.id, mode: 'forward', parentId: 'p2' })
    expect(d).toMatchObject({ subject: 'Fwd: Hello', to: '', forwarded: [{ filename: 'ok.pdf', sizeBytes: 10 }] })
    expect(d.notForwarded).toEqual([{ filename: 'bad.exe', reason: 'Amazon found a virus in this mail' }])
    expect(d.body).toContain('---------- Forwarded message ---------\nFrom: Mara Voss <mara@sender.example>')
  })

  it('is not found for a mail in a mailbox you don’t read', async () => {
    const { deps, store, ana } = await setup()
    await store.insertMessage(message(ana.id, { id: 'p3' }))
    await expect(composeDraft(deps.inbox, 'olga', { mailboxId: ana.id, mode: 'reply', parentId: 'p3' })).rejects.toMatchObject({ code: 'not_found' })
  })
})

describe('sendInvitation (calendar K4: an iMIP REQUEST from the member’s own mailbox)', () => {
  const ics = (organizer: { name: string | null; address: string }) =>
    ['BEGIN:VCALENDAR', 'VERSION:2.0', 'METHOD:REQUEST', 'BEGIN:VEVENT', `ORGANIZER;CN=${organizer.name}:mailto:${organizer.address}`, 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n')
  const invite = (mailboxId: string) => ({
    mailboxId,
    to: [{ name: 'Mara Voss', address: 'mara@sender.example' }],
    subject: 'Invitation: Call with Mara Voss',
    text: 'Ana Lind invites you to: Call with Mara Voss',
    ics,
  })

  it('goes out From the mailbox with a text/calendar; method=REQUEST part built for that organizer, and files a Sent copy', async () => {
    const { deps, store, ana, sent } = await setup()
    const out = await sendInvitation(deps, 'ana', invite(ana.id))
    expect(sent).toHaveLength(1)
    expect(sent[0]!.fromAddress).toBe('ana.lind@example.com')
    expect(sent[0]!.recipients).toEqual({ to: ['mara@sender.example'], cc: [], bcc: [] })
    const raw = Buffer.from(sent[0]!.raw).toString('utf8')
    expect(raw).toMatch(/Content-Type: text\/calendar; charset=utf-8; method=REQUEST/i)
    const mail = await parsedRaw(sent[0]!)
    expect(mail.subject).toBe('Invitation: Call with Mara Voss')
    expect(mail.text?.trim()).toBe('Ana Lind invites you to: Call with Mara Voss')
    expect(raw.replace(/=\r\n/g, '')).toContain('ORGANIZER;CN=Ana Lind:mailto:ana.lind@example.com')
    expect(await store.getMessage(out.id)).toMatchObject({ folder: 'sent', subject: 'Invitation: Call with Mara Voss', to: [{ name: 'Mara Voss', address: 'mara@sender.example' }] })
  })

  it('only from the member’s own personal mailbox, never a shared or disabled one', async () => {
    const { deps, ana, sales, sent } = await setup()
    await expect(sendInvitation(deps, 'sam', invite(sales.id))).rejects.toMatchObject({ code: 'forbidden' })
    await expect(sendInvitation(deps, 'ben', invite(ana.id))).rejects.toMatchObject({ code: 'not_found' })
    await setMailboxDisabled(deps.inbox, 'olga', { mailboxId: ana.id, disabled: true })
    await expect(sendInvitation(deps, 'ana', invite(ana.id))).rejects.toMatchObject({ code: 'invalid' })
    expect(sent).toEqual([])
  })

  it('needs a guest', async () => {
    const { deps, ana } = await setup()
    await expect(sendInvitation(deps, 'ana', { ...invite(ana.id), to: [] })).rejects.toMatchObject({ code: 'invalid' })
  })
})
