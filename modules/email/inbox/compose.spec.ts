import { simpleParser } from 'mailparser'
import { describe, expect, it } from 'vitest'
import {
  buildMime,
  checkAttachments,
  dedupeRecipients,
  forwardedBlock,
  forwardSubject,
  formatRecipients,
  MAX_RECIPIENTS,
  parseRecipients,
  quotedReply,
  replyRecipients,
  replySubject,
  sanitizeFilename,
  textAsHtml,
} from './compose'

/** S5: the pure half of compose — recipients, prefills, limits, raw MIME. */

describe('parseRecipients', () => {
  it('reads names and addresses separated by commas or semicolons, lower-casing addresses', () => {
    expect(parseRecipients(' Mara Voss <Mara@Sender.example>, ben@x.co; "Doe, Jane" <jane@x.co> ', 'To')).toEqual([
      { name: 'Mara Voss', address: 'mara@sender.example' },
      { name: null, address: 'ben@x.co' },
      { name: 'Doe, Jane', address: 'jane@x.co' },
    ])
    expect(parseRecipients('   ', 'Cc')).toEqual([])
  })

  it('refuses anything that is not an address, naming the field', () => {
    expect(() => parseRecipients('ben@x.co, not-an-address', 'Cc')).toThrow(
      '“not-an-address” in Cc isn’t an email address. Write addresses like name@example.com, separated by commas.',
    )
    expect(() => parseRecipients('Mara <>', 'To')).toThrow(/in To isn’t an email address/)
  })

  it('formats back to what the form shows', () => {
    expect(formatRecipients([{ name: 'Doe, Jane', address: 'jane@x.co' }, { name: null, address: 'b@x.co' }])).toBe('"Doe, Jane" <jane@x.co>, b@x.co')
  })
})

describe('dedupeRecipients', () => {
  const p = (address: string) => ({ name: null, address })
  it('keeps each address once (the first field wins) and needs at least one', () => {
    expect(dedupeRecipients({ to: [p('a@x.co'), p('a@x.co')], cc: [p('a@x.co'), p('b@x.co')], bcc: [p('b@x.co')] })).toEqual({
      to: [p('a@x.co')],
      cc: [p('b@x.co')],
      bcc: [],
    })
    expect(() => dedupeRecipients({ to: [], cc: [], bcc: [] })).toThrow('Add at least one recipient in To, Cc or Bcc.')
  })

  it('caps To + Cc + Bcc together', () => {
    const many = Array.from({ length: MAX_RECIPIENTS + 1 }, (_, i) => p(`r${i}@x.co`))
    expect(() => dedupeRecipients({ to: many, cc: [], bcc: [] })).toThrow(/at most 50 addresses/)
  })
})

describe('subjects', () => {
  it('adds Re: / Fwd: once', () => {
    expect(replySubject('Numbers')).toBe('Re: Numbers')
    expect(replySubject('RE: Numbers')).toBe('RE: Numbers')
    expect(replySubject('')).toBe('Re:')
    expect(forwardSubject('Numbers')).toBe('Fwd: Numbers')
    expect(forwardSubject('Fw: Numbers')).toBe('Fw: Numbers')
    expect(forwardSubject('Re: Numbers')).toBe('Fwd: Re: Numbers')
  })
})

describe('quoted text', () => {
  const parent = {
    from: { name: 'Mara Voss', address: 'mara@sender.example' },
    to: [{ name: null, address: 'ana@example.com' }],
    cc: [{ name: 'Ben', address: 'ben@x.co' }],
    receivedAt: new Date('2026-11-12T08:00:00Z'),
    subject: 'Numbers',
    textBody: 'Hi Ana,\r\n\r\nhere they are.\n',
  }

  it('quotes the original below a reply', () => {
    expect(quotedReply(parent)).toBe('\n\nOn Thu, 12 Nov 2026 08:00:00 GMT, Mara Voss <mara@sender.example> wrote:\n> Hi Ana,\n>\n> here they are.\n')
  })

  it('puts a forwarded header block above the original text', () => {
    expect(forwardedBlock(parent)).toBe(
      '\n\n---------- Forwarded message ---------\nFrom: Mara Voss <mara@sender.example>\nDate: Thu, 12 Nov 2026 08:00:00 GMT\nSubject: Numbers\nTo: ana@example.com\nCc: Ben <ben@x.co>\n\nHi Ana,\n\nhere they are.\n',
    )
  })
})

describe('replyRecipients', () => {
  const own = new Set(['ana@example.com', 'ana.alias@example.com'])
  const parent = {
    from: { name: 'Mara', address: 'Mara@Sender.example' },
    to: [{ name: null, address: 'ana@example.com' }, { name: 'Ben', address: 'ben@x.co' }],
    cc: [{ name: null, address: 'ANA.ALIAS@example.com' }, { name: null, address: 'carl@x.co' }, { name: null, address: 'mara@sender.example' }],
  }

  it('reply goes to the sender only', () => {
    expect(replyRecipients(parent, own, 'reply')).toEqual({ to: [{ name: 'Mara', address: 'mara@sender.example' }], cc: [] })
  })

  it('reply all: sender + To + Cc, minus our own addresses, each once', () => {
    expect(replyRecipients(parent, own, 'replyAll')).toEqual({
      to: [{ name: 'Mara', address: 'mara@sender.example' }, { name: 'Ben', address: 'ben@x.co' }],
      cc: [{ name: null, address: 'carl@x.co' }],
    })
  })

  it('replying to our own sent mail goes to its recipients', () => {
    const sent = { from: { name: null, address: 'ana@example.com' }, to: [{ name: null, address: 'mara@sender.example' }], cc: [{ name: null, address: 'carl@x.co' }] }
    expect(replyRecipients(sent, own, 'reply')).toEqual({ to: [{ name: null, address: 'mara@sender.example' }], cc: [] })
    expect(replyRecipients(sent, own, 'replyAll')).toEqual({ to: [{ name: null, address: 'mara@sender.example' }], cc: [{ name: null, address: 'carl@x.co' }] })
  })
})

describe('sanitizeFilename', () => {
  it('drops paths and control characters, keeps the extension when shortening', () => {
    expect(sanitizeFilename('C:\\Users\\ana\\report.pdf')).toBe('report.pdf')
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd')
    expect(sanitizeFilename('a\u0000b\r\nc.txt')).toBe('abc.txt')
    expect(sanitizeFilename('..hidden')).toBe('hidden')
    expect(sanitizeFilename('   ')).toBe('attachment')
    const long = sanitizeFilename(`${'x'.repeat(300)}.pdf`)
    expect(long).toHaveLength(200)
    expect(long.endsWith('.pdf')).toBe(true)
  })
})

describe('checkAttachments', () => {
  it('caps attachments at 25 MB together', () => {
    const big = 13 * 1024 * 1024
    expect(() => checkAttachments([big])).not.toThrow()
    expect(() => checkAttachments(Array.from({ length: 21 }, () => 1))).toThrow('A mail can carry at most 20 attachments.')
    expect(() => checkAttachments([big, big])).toThrow('The attachments come to 26.0 MB. A mail can carry at most 25 MB of attachments — leave some out and send again.')
  })
})

describe('buildMime', () => {
  it('builds a mail that parses back with its threading headers, no Bcc, an escaped HTML alternative and the attachments', async () => {
    const raw = await buildMime({
      from: { name: 'Ana Lind', address: 'ana@example.com' },
      to: [{ name: 'Mara Voss', address: 'mara@sender.example' }],
      cc: [{ name: null, address: 'ben@x.co' }],
      subject: 'Re: Zahlen für Q3',
      text: 'Danke!\n<b>not bold</b>',
      messageId: 'abc-123@example.com',
      inReplyTo: 'orig@sender.example',
      references: ['root@sender.example', 'orig@sender.example', 'abc-123@example.com'],
      date: new Date('2026-11-12T10:00:00Z'),
      attachments: [{ filename: 'notes.txt', contentType: 'text/plain', content: Buffer.from('hello') }],
    })
    expect(raw.toString('utf8')).not.toMatch(/^bcc:/im)
    const mail = await simpleParser(raw)
    expect(mail.messageId).toBe('<abc-123@example.com>')
    expect(mail.inReplyTo).toBe('<orig@sender.example>')
    expect(mail.references).toEqual(['<root@sender.example>', '<orig@sender.example>', '<abc-123@example.com>'])
    expect(mail.subject).toBe('Re: Zahlen für Q3')
    expect(mail.from?.value).toEqual([{ name: 'Ana Lind', address: 'ana@example.com' }])
    expect(mail.text?.trim()).toBe('Danke!\n<b>not bold</b>')
    expect(mail.html).toContain('Danke!<br>\n&lt;b&gt;not bold&lt;/b&gt;')
    expect(mail.attachments.map((a) => [a.filename, a.contentType, a.content.toString()])).toEqual([['notes.txt', 'text/plain', 'hello']])
  })

  it('escapes every HTML special character in the alternative', () => {
    expect(textAsHtml(`a & "b" 'c'`)).toContain('a &amp; &quot;b&quot; &#39;c&#39;')
  })
})
