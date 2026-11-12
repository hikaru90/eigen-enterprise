import { describe, expect, it } from 'vitest'
import { message } from './test-fixtures'
import { folderViews, listItem, readerView } from './view'

const ORIGIN = 'https://os.example.com'

describe('Inbox views', () => {
  it('lists every folder with its label and counts', () => {
    const zero = { total: 0, unread: 0 }
    const v = folderViews({ inbox: { total: 3, unread: 2 }, sent: zero, spam: { total: 1, unread: 1 }, trash: zero, archive: zero })
    expect(v.map((f) => [f.label, f.total, f.unread])).toEqual([
      ['Inbox', 3, 2],
      ['Sent', 0, 0],
      ['Spam', 1, 1],
      ['Trash', 0, 0],
      ['Archive', 0, 0],
    ])
  })

  it('a list item has no body, only the snippet and flags', () => {
    const { textBody: _t, htmlBody: _h, ...summary } = message('b', { id: 'm', starred: true })
    expect(listItem(summary)).toEqual({
      id: 'm',
      from: { name: 'Mara Voss', address: 'mara@sender.example' },
      subject: 'Hello',
      snippet: 'Hi Ana, …',
      receivedAt: '2026-11-12T08:00:00.000Z',
      unread: true,
      starred: true,
    })
  })

  it('the reader shows text as text, HTML sanitized in a srcdoc, and attachments with their download route', () => {
    const text = message('b', { id: 't1', threadId: 't' })
    const html = message('b', {
      id: 'h1',
      threadId: 't',
      textBody: 'fallback',
      htmlBody: '<p onclick="x()">Hi</p><img src="https://track.example/p.gif"><img src="cid:logo@s">',
      readAt: new Date(),
    })
    const attachments = new Map([
      ['t1', []],
      [
        'h1',
        [
          { id: 'a1', messageId: 'h1', partIndex: 0, filename: 'logo.gif', contentType: 'image/gif', sizeBytes: 9, contentId: 'logo@s', checksum: 'c', blocked: false, createdAt: new Date() },
          { id: 'a2', messageId: 'h1', partIndex: 1, filename: null, contentType: 'application/pdf', sizeBytes: 5, contentId: null, checksum: 'd', blocked: true, createdAt: new Date() },
        ],
      ],
    ])
    const v = readerView({ message: html, messages: [text, html], attachments }, { origin: ORIGIN, images: false })
    expect(v).toMatchObject({ id: 'h1', unread: false, remoteImagesBlocked: true, imagesShown: false })
    expect(v.messages[0]!.body).toEqual({ kind: 'text', text: 'Hi Ana, how are you?' })
    const body = v.messages[1]!.body
    if (body.kind !== 'html') throw new Error('expected html')
    expect(body.srcdoc).not.toContain('onclick')
    expect(body.srcdoc).toContain(`${ORIGIN}/m/email/inbox/attachments/a1?inline=1`)
    expect(body.srcdoc).toContain("img-src data: https://os.example.com/m/email/inbox/attachments/\"")
    expect(v.messages[1]!.attachments).toEqual([
      { id: 'a1', filename: 'logo.gif', contentType: 'image/gif', sizeBytes: 9, blocked: false, href: '/m/email/inbox/attachments/a1' },
      { id: 'a2', filename: 'attachment', contentType: 'application/pdf', sizeBytes: 5, blocked: true, href: '/m/email/inbox/attachments/a2' },
    ])
    const shown = readerView({ message: html, messages: [html], attachments }, { origin: ORIGIN, images: true })
    expect(shown).toMatchObject({ remoteImagesBlocked: false, imagesShown: true })
    const shownBody = shown.messages[0]!.body
    expect(shownBody.kind === 'html' && shownBody.srcdoc).toContain('attachments/ https:"')
  })

  it('a mail with no body says so', () => {
    const empty = message('b', { id: 'e', textBody: null, htmlBody: null })
    expect(readerView({ message: empty, messages: [empty], attachments: new Map() }, { origin: ORIGIN, images: false }).messages[0]!.body).toEqual({
      kind: 'empty',
    })
  })
})
