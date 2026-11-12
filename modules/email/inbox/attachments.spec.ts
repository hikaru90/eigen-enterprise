import { describe, expect, it } from 'vitest'
import { attachmentHeaders, downloadAttachment, type DownloadDeps } from './attachments'
import { ingestReceived } from './ingest'
import { parseReceipt } from './ingest'
import { LOGO_BYTES, PDF_BYTES, WITH_ATTACHMENT } from './mime-fixtures'
import { fakeRawMailSource } from './raw-source'
import { BUCKET, received } from './receipt-fixtures'
import { assignPersonalMailbox } from './service'
import { fixture, message } from './test-fixtures'

/** Attachment bytes are read again from the raw mail in S3, found by part index and proven by checksum. */

async function setup(verdicts: { virus?: string } = {}) {
  const f = fixture()
  await assignPersonalMailbox(f.deps, 'olga', { memberId: 'ana', localPart: 'ana.lind', domainId: 'd-1' })
  const raw = fakeRawMailSource()
  raw.objects.set(`${BUCKET}/ses-msg-1`, Buffer.from(WITH_ATTACHMENT))
  const parsed = parseReceipt(received({ verdicts }))
  if (parsed.kind !== 'received') throw new Error('fixture')
  await ingestReceived({ store: f.store, raw, log: () => {} }, parsed.notification, BUCKET)
  raw.reads.length = 0
  const deps: DownloadDeps = { inbox: f.deps, raw, bucket: async () => BUCKET }
  const parts = [...f.store.attachments.values()].sort((a, b) => a.partIndex - b.partIndex)
  const pdf = parts.find((a) => a.contentType === 'application/pdf')!
  const logo = parts.find((a) => a.contentType === 'image/gif')!
  return { ...f, raw, deps, pdf, logo }
}

describe('downloadAttachment', () => {
  it('gives a reader the attachment’s bytes from the raw mail, as a download', async () => {
    const { deps, pdf, raw } = await setup()
    const file = await downloadAttachment(deps, 'ana', pdf.id, { inline: false })
    expect(Buffer.from(file.bytes).equals(PDF_BYTES)).toBe(true)
    expect(file).toMatchObject({ filename: 'contract.pdf', contentType: 'application/pdf', inline: false })
    expect(raw.reads).toEqual([`${BUCKET}/ses-msg-1`])
  })

  it('shows an inline cid: image inline only when asked, and never a non-image inline', async () => {
    const { deps, pdf, logo } = await setup()
    const img = await downloadAttachment(deps, 'ana', logo.id, { inline: true })
    expect(Buffer.from(img.bytes).equals(LOGO_BYTES)).toBe(true)
    expect(img.inline).toBe(true)
    expect((await downloadAttachment(deps, 'ana', logo.id, { inline: false })).inline).toBe(false)
    expect((await downloadAttachment(deps, 'ana', pdf.id, { inline: true })).inline).toBe(false)
  })

  it('is not found for anyone but the reader, the owner included, without reading S3', async () => {
    const { deps, pdf, raw } = await setup()
    for (const who of ['olga', 'adam', 'ben', 'nobody']) {
      await expect(downloadAttachment(deps, who, pdf.id, { inline: false })).rejects.toMatchObject({ code: 'not_found' })
    }
    await expect(downloadAttachment(deps, 'ana', 'no-such-id', { inline: false })).rejects.toMatchObject({ code: 'not_found' })
    expect(raw.reads).toEqual([])
  })

  it('refuses a blocked attachment (Amazon found a virus) without reading S3', async () => {
    const { deps, pdf, raw } = await setup({ virus: 'FAIL' })
    await expect(downloadAttachment(deps, 'ana', pdf.id, { inline: false })).rejects.toMatchObject({
      code: 'blocked',
      message: 'Blocked: Amazon found a virus in this mail. The attachment can’t be downloaded.',
    })
    expect(raw.reads).toEqual([])
  })

  it('fails loud when the raw mail no longer holds the same part', async () => {
    const { deps, store, pdf } = await setup()
    store.attachments.set(pdf.id, { ...pdf, checksum: 'not-the-same' })
    await expect(downloadAttachment(deps, 'ana', pdf.id, { inline: false })).rejects.toThrow(/does not match/)
    store.attachments.set(pdf.id, { ...pdf, partIndex: 9 })
    await expect(downloadAttachment(deps, 'ana', pdf.id, { inline: false })).rejects.toThrow(/no part 9/)
  })
})

describe('downloadAttachment: mail sent from here (S5)', () => {
  it('says plainly that its attachments are not kept, without reading S3', async () => {
    const { deps, store, raw } = await setup()
    const ana = [...store.messages.values()][0]!.mailboxId
    await store.insertReceived(
      { ...message(ana, { id: 'sent-1', folder: 'trash', sesMessageId: 'out-1', verdicts: null, rawS3Key: null }), sesMessageId: 'out-1' },
      [{ id: 'sa-1', messageId: 'sent-1', partIndex: 0, filename: 'plan.pdf', contentType: 'application/pdf', sizeBytes: 3, contentId: null, checksum: 'c', blocked: false, createdAt: new Date() }],
    )
    await expect(downloadAttachment(deps, 'ana', 'sa-1', { inline: false })).rejects.toMatchObject({
      code: 'not_kept',
      message: 'Attachments of mail sent from here aren’t kept, so they can’t be downloaded yet.',
    })
    expect(raw.reads).toEqual([])
  })
})

describe('attachmentHeaders', () => {
  it('downloads with the file name, no sniffing, and a sandbox CSP', () => {
    expect(attachmentHeaders({ filename: 'Vertrag März.pdf', contentType: 'application/pdf', inline: false, bytes: new Uint8Array(3) })).toEqual({
      'content-type': 'application/pdf',
      'content-length': '3',
      'content-disposition': `attachment; filename="Vertrag M_rz.pdf"; filename*=UTF-8''Vertrag%20M%C3%A4rz.pdf`,
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'cache-control': 'private, no-store',
    })
  })

  it('inline images go inline; a nameless part gets a plain name', () => {
    const h = attachmentHeaders({ filename: null, contentType: 'image/gif', inline: true, bytes: new Uint8Array(1) })
    expect(h['content-disposition']).toBe(`inline; filename="attachment"; filename*=UTF-8''attachment`)
  })

  it('never lets a quote or line break out of the header', () => {
    const h = attachmentHeaders({ filename: 'a"b\r\nc.txt', contentType: 'text/plain', inline: false, bytes: new Uint8Array(0) })
    expect(h['content-disposition']).toBe(`attachment; filename="a_b__c.txt"; filename*=UTF-8''a%22b%0D%0Ac.txt`)
  })
})
