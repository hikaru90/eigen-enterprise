import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { IngestRejected, ingestReceived, MAX_RAW_BYTES, parseReceipt, type IngestDeps } from './ingest'
import { ALTERNATIVE, HTML_ONLY, LOGO_BYTES, NO_FROM, PDF_BYTES, PLAIN, REPLY, WITH_ATTACHMENT } from './mime-fixtures'
import { fakeRawMailSource } from './raw-source'
import { BUCKET, received } from './receipt-fixtures'
import { addAlias, assignPersonalMailbox, createSharedMailbox, getMessage, setMailboxDisabled } from './service'
import { fixture } from './test-fixtures'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** Ana (ana.lind@, alias ana@), Ben (ben@), and info@ for the Sales group (Ana + Sam). */
async function setup() {
  const f = fixture()
  const ana = await assignPersonalMailbox(f.deps, 'olga', { memberId: 'ana', localPart: 'ana.lind', domainId: 'd-1' })
  await addAlias(f.deps, 'olga', { mailboxId: ana.id, localPart: 'ana', domainId: 'd-1' })
  const ben = await assignPersonalMailbox(f.deps, 'olga', { memberId: 'ben', localPart: 'ben', domainId: 'd-1' })
  const info = await createSharedMailbox(f.deps, 'olga', { groupId: 'g-sales', localPart: 'info', domainId: 'd-1' })
  const raw = fakeRawMailSource()
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = []
  const ingestDeps: IngestDeps = { store: f.store, raw, log: (event, fields) => logs.push({ event, fields }) }
  const put = (key: string, mime: string) => raw.objects.set(`${BUCKET}/${key}`, Buffer.from(mime))
  const ingest = (n: ReturnType<typeof received>) => {
    const parsed = parseReceipt(n)
    if (parsed.kind !== 'received') throw new Error('not a Received notification')
    return ingestReceived(ingestDeps, parsed.notification, BUCKET)
  }
  const rows = () => [...f.store.messages.values()]
  return { ...f, ana, ben, info, raw, put, ingest, rows, logs }
}

describe('ingesting a received mail', () => {
  it('stores a plain mail in the recipient’s inbox with parsed headers, snippet, size and SES ids', async () => {
    const s = await setup()
    s.put('ses-msg-1', PLAIN)
    expect(await s.ingest(received())).toEqual({ stored: 1, duplicates: 0, skipped: 0 })
    const [row] = s.rows()
    expect(row).toMatchObject({
      mailboxId: s.ana.id,
      folder: 'inbox',
      messageId: 'q3-numbers@sender.example',
      sesMessageId: 'ses-msg-1',
      rawS3Key: 'ses-msg-1',
      inReplyTo: null,
      references: [],
      from: { name: 'Mara Voss', address: 'mara@sender.example' },
      to: [{ name: 'Ana Lind', address: 'ana.lind@example.com' }],
      cc: [
        { name: 'Sam', address: 'sam@sender.example' },
        { name: null, address: 'ben@example.com' },
      ],
      subject: 'Quarterly numbers',
      snippet: 'Hi Ana, here are the numbers for Q3. Grüße, Mara',
      htmlBody: null,
      readAt: null,
      starred: false,
      verdicts: { spam: 'PASS', virus: 'PASS', spf: 'PASS', dkim: 'PASS', dmarc: 'PASS' },
      sizeBytes: Buffer.byteLength(PLAIN),
    })
    expect(row!.textBody).toContain('here are the   numbers for Q3.')
    expect(row!.receivedAt.toISOString()).toBe('2026-11-12T09:00:05.000Z')
    expect(row!.threadId).toMatch(UUID)
    expect(row!.id).toMatch(UUID)
    expect(s.store.notified).toEqual([s.ana.id])
  })

  it('logs ids, counts and sizes only — never subjects, addresses or bodies', async () => {
    const s = await setup()
    s.put('ses-msg-1', PLAIN)
    await s.ingest(received())
    const text = JSON.stringify(s.logs)
    expect(s.logs).toEqual([{ event: 'received', fields: { sesMessageId: 'ses-msg-1', stored: 1, duplicates: 0, skipped: 0, sizeBytes: Buffer.byteLength(PLAIN) } }])
    for (const secret of ['Quarterly', 'mara@', 'ana.lind', 'numbers']) expect(text).not.toContain(secret)
  })

  it('keeps the plain part and the HTML of multipart/alternative', async () => {
    const s = await setup()
    s.put('ses-msg-1', ALTERNATIVE)
    await s.ingest(received({ recipients: ['info@example.com'] }))
    expect(s.rows()[0]).toMatchObject({
      mailboxId: s.info.id,
      subject: 'Grüße',
      snippet: 'Plain part.',
      htmlBody: '<p>Plain <b>part</b>.</p>',
      from: { name: 'Mara Voss', address: 'mara@sender.example' },
    })
  })

  it('derives the text of an HTML-only mail from mailparser for body and snippet', async () => {
    const s = await setup()
    s.put('ses-msg-1', HTML_ONLY)
    await s.ingest(received())
    const [row] = s.rows()
    expect(row!.htmlBody).toContain('<h1>Welcome</h1>')
    // mailparser's own HTML → text (headings upper-cased), whitespace collapsed for the snippet.
    expect(row!.textBody).toBe('WELCOME\n\nThis is the November issue.')
    expect(row!.snippet).toBe('WELCOME This is the November issue.')
  })

  it('caps the snippet at 200 characters', async () => {
    const s = await setup()
    s.put('ses-msg-1', PLAIN.replace('Hi Ana,', `Hi Ana, ${'long '.repeat(80)}`))
    await s.ingest(received())
    expect(s.rows()[0]!.snippet).toHaveLength(200)
  })

  it('records attachments (inline ones too) by part, without their bytes', async () => {
    const s = await setup()
    s.put('ses-msg-1', WITH_ATTACHMENT)
    await s.ingest(received())
    const [row] = s.rows()
    const md5 = (b: Buffer) => createHash('md5').update(b).digest('hex')
    const parts = await s.store.listAttachments(row!.id)
    expect(parts.map(({ id: _i, createdAt: _c, ...a }) => a)).toEqual([
      {
        messageId: row!.id,
        partIndex: 0,
        filename: 'logo.gif',
        contentType: 'image/gif',
        sizeBytes: LOGO_BYTES.length,
        contentId: 'logo@sender.example',
        checksum: md5(LOGO_BYTES),
        blocked: false,
      },
      {
        messageId: row!.id,
        partIndex: 1,
        filename: 'contract.pdf',
        contentType: 'application/pdf',
        sizeBytes: PDF_BYTES.length,
        contentId: null,
        checksum: md5(PDF_BYTES),
        blocked: false,
      },
    ])
    expect(JSON.stringify(row)).not.toContain(PDF_BYTES.toString('base64'))
  })

  it('takes the envelope sender when the mail has no From header', async () => {
    const s = await setup()
    s.put('ses-msg-1', NO_FROM)
    await s.ingest(received())
    expect(s.rows()[0]!.from).toEqual({ name: null, address: 'bounce@sender.example' })
  })
})

describe('routing on the envelope recipients', () => {
  it('drops a mail to an address nobody holds without fetching it', async () => {
    const s = await setup()
    expect(await s.ingest(received({ recipients: ['nobody@example.com'] }))).toEqual({ stored: 0, duplicates: 0, skipped: 1 })
    expect(s.rows()).toEqual([])
    expect(s.raw.reads).toEqual([])
  })

  it('delivers to a Bcc’d recipient (in the envelope, not in To/Cc)', async () => {
    const s = await setup()
    s.put('ses-msg-1', PLAIN) // To: ana.lind@, Cc: ben@ — info@ only in the envelope
    await s.ingest(received({ recipients: ['info@example.com'] }))
    expect(s.rows().map((r) => r.mailboxId)).toEqual([s.info.id])
  })

  it('stores one row when a primary address and an alias of the same mailbox both receive it (any case)', async () => {
    const s = await setup()
    s.put('ses-msg-1', PLAIN)
    expect(await s.ingest(received({ recipients: ['Ana.Lind@Example.com', 'ana@example.com'] }))).toMatchObject({ stored: 1 })
    expect(s.rows().map((r) => r.mailboxId)).toEqual([s.ana.id])
  })

  it('stores one row per mailbox, each its own message and thread', async () => {
    const s = await setup()
    s.put('ses-msg-1', PLAIN)
    expect(await s.ingest(received({ recipients: ['ana.lind@example.com', 'ben@example.com', 'nobody@example.com'] }))).toEqual({
      stored: 2,
      duplicates: 0,
      skipped: 1,
    })
    const [a, b] = s.rows()
    expect([a!.mailboxId, b!.mailboxId].sort()).toEqual([s.ana.id, s.ben.id].sort())
    expect(a!.id).not.toBe(b!.id)
    expect(a!.threadId).not.toBe(b!.threadId)
    expect(s.raw.reads).toEqual([`${BUCKET}/ses-msg-1`])
  })

  it('skips a disabled mailbox', async () => {
    const s = await setup()
    await setMailboxDisabled(s.deps, 'olga', { mailboxId: s.ben.id, disabled: true })
    s.put('ses-msg-1', PLAIN)
    expect(await s.ingest(received({ recipients: ['ben@example.com', 'ana.lind@example.com'] }))).toEqual({ stored: 1, duplicates: 0, skipped: 1 })
    expect(s.rows().map((r) => r.mailboxId)).toEqual([s.ana.id])
  })

  it('is idempotent: the same notification again stores nothing new', async () => {
    const s = await setup()
    s.put('ses-msg-1', PLAIN)
    await s.ingest(received({ recipients: ['ana.lind@example.com', 'ben@example.com'] }))
    expect(await s.ingest(received({ recipients: ['ana.lind@example.com', 'ben@example.com'] }))).toEqual({
      stored: 0,
      duplicates: 2,
      skipped: 0,
    })
    expect(s.rows()).toHaveLength(2)
    expect(s.store.notified).toHaveLength(2)
  })

  it('keeps the S1 access rule: the owner cannot open a member’s ingested mail', async () => {
    const s = await setup()
    s.put('ses-msg-1', PLAIN)
    await s.ingest(received())
    const id = s.rows()[0]!.id
    await expect(getMessage(s.deps, 'olga', id)).rejects.toMatchObject({ code: 'not_found' })
    await expect(getMessage(s.deps, 'ana', id)).resolves.toMatchObject({ subject: 'Quarterly numbers' })
  })
})

describe('spam, virus and DMARC verdicts', () => {
  const folderFor = async (o: Parameters<typeof received>[0]) => {
    const s = await setup()
    s.put('ses-msg-1', WITH_ATTACHMENT)
    await s.ingest(received(o))
    const [row] = s.rows()
    return { folder: row!.folder, verdicts: row!.verdicts, blocked: (await s.store.listAttachments(row!.id)).map((a) => a.blocked) }
  }

  it('files spam FAIL in Spam', async () => {
    expect(await folderFor({ verdicts: { spam: 'FAIL' } })).toMatchObject({ folder: 'spam', blocked: [false, false] })
  })

  it('files virus FAIL in Spam and blocks every attachment', async () => {
    expect(await folderFor({ verdicts: { virus: 'FAIL' } })).toMatchObject({
      folder: 'spam',
      blocked: [true, true],
      verdicts: { spam: 'PASS', virus: 'FAIL', spf: 'PASS', dkim: 'PASS', dmarc: 'PASS' },
    })
  })

  it('files DMARC FAIL in Spam when the sender’s policy is quarantine or reject, not none', async () => {
    expect((await folderFor({ verdicts: { dmarc: 'FAIL' }, dmarcPolicy: 'reject' })).folder).toBe('spam')
    expect((await folderFor({ verdicts: { dmarc: 'FAIL' }, dmarcPolicy: 'quarantine' })).folder).toBe('spam')
    expect((await folderFor({ verdicts: { dmarc: 'FAIL' }, dmarcPolicy: 'none' })).folder).toBe('inbox')
  })

  it('keeps GRAY, PROCESSING_FAILED and SPF/DKIM failures in the Inbox', async () => {
    expect((await folderFor({ verdicts: { spam: 'GRAY', virus: 'PROCESSING_FAILED', spf: 'FAIL', dkim: 'FAIL' } })).folder).toBe('inbox')
  })
})

describe('threading', () => {
  it('joins the thread of an earlier mail named in References / In-Reply-To, in the same mailbox only', async () => {
    const s = await setup()
    s.put('first', PLAIN)
    await s.ingest(received({ sesMessageId: 'first' }))
    const original = s.rows()[0]!
    s.put('second', REPLY)
    await s.ingest(received({ sesMessageId: 'second', recipients: ['ana.lind@example.com', 'ben@example.com'] }))
    const reply = s.rows().find((r) => r.sesMessageId === 'second' && r.mailboxId === s.ana.id)!
    const benCopy = s.rows().find((r) => r.sesMessageId === 'second' && r.mailboxId === s.ben.id)!
    expect(reply).toMatchObject({
      threadId: original.threadId,
      messageId: 'q3-reply@sender.example',
      inReplyTo: 'q3-ana-answer@example.com',
      references: ['q3-numbers@sender.example', 'q3-ana-answer@example.com'],
    })
    expect(benCopy.threadId).not.toBe(original.threadId)
  })
})

describe('refusals', () => {
  it('accepts only the S3 action into the stored bucket', async () => {
    const s = await setup()
    s.put('ses-msg-1', PLAIN)
    await expect(s.ingest(received({ actionType: 'SNS' }))).rejects.toBeInstanceOf(IngestRejected)
    await expect(s.ingest(received({ bucket: 'someone-elses-bucket' }))).rejects.toBeInstanceOf(IngestRejected)
    expect(s.raw.reads).toEqual([])
    expect(s.rows()).toEqual([])
  })

  it('refuses malformed notifications', () => {
    expect(() => parseReceipt({ notificationType: 'Received', mail: {} })).toThrow(IngestRejected)
    expect(() => parseReceipt(received({ verdicts: { spam: 'MAYBE' } }))).toThrow(IngestRejected)
    expect(() => parseReceipt('nope')).toThrow(IngestRejected)
  })

  it('reports a non-Received notification (SES setup test) as nothing to store', () => {
    expect(parseReceipt({ notificationType: 'AMAZON_SES_SETUP_NOTIFICATION' })).toEqual({ kind: 'other', notificationType: 'AMAZON_SES_SETUP_NOTIFICATION' })
  })

  it('refuses raw mail over the 40 MB SES cap', async () => {
    const s = await setup()
    s.raw.objects.set(`${BUCKET}/ses-msg-1`, new Uint8Array(MAX_RAW_BYTES + 1))
    await expect(s.ingest(received())).rejects.toBeInstanceOf(IngestRejected)
  })

  it('lets a raw fetch failure throw (the route answers 5xx so SNS retries)', async () => {
    const s = await setup()
    await expect(s.ingest(received())).rejects.toThrow(/no object/)
    expect(s.rows()).toEqual([])
  })
})
