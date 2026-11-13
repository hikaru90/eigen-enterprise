import type { ContactMail } from './service'
import { describe, expect, it, vi } from 'vitest'
import { contactMailPort } from './mail-history'

/** The port asks Email who reads what before any mail is read, and reads only that. */

const item = (id: string): ContactMail => ({
  id,
  direction: 'received',
  via: { kind: 'mailbox', address: 'ana@co.example' },
  subject: id,
  snippet: null,
  at: new Date('2026-11-11T10:00:00Z'),
  href: `/x/${id}`,
})

function sources(boxes: Array<{ id: string; address: string }>, admin: boolean) {
  return {
    readableMailboxes: vi.fn(async () => boxes),
    readsCompanyMail: vi.fn(async () => admin),
    mailbox: vi.fn(async () => [item('mailbox')]),
    company: vi.fn(async () => [item('company')]),
  }
}

describe('contactMailPort', () => {
  it('a member: only the mailboxes Email says they read, no company mail', async () => {
    const src = sources([{ id: 'b1', address: 'ana@co.example' }], false)
    expect((await contactMailPort(src)('ana', ['mara@x.example'])).map((m) => m.id)).toEqual(['mailbox'])
    expect(src.readableMailboxes).toHaveBeenCalledWith('ana')
    expect(src.readsCompanyMail).toHaveBeenCalledWith('ana')
    expect(src.mailbox).toHaveBeenCalledWith([{ id: 'b1', address: 'ana@co.example' }], ['mara@x.example'])
    expect(src.company).not.toHaveBeenCalled()
  })

  it('the owner or an admin with no mailbox of their own: company mail only, no one else’s mailbox', async () => {
    const src = sources([], true)
    expect((await contactMailPort(src)('olga', ['mara@x.example'])).map((m) => m.id)).toEqual(['company'])
    expect(src.mailbox).not.toHaveBeenCalled()
    expect(src.company).toHaveBeenCalledWith(['mara@x.example'])
  })

  it('a failure in Email’s access answer fails the history (no mail without it)', async () => {
    const src = sources([], false)
    src.readableMailboxes.mockRejectedValueOnce(new Error('groups unavailable'))
    await expect(contactMailPort(src)('ana', ['mara@x.example'])).rejects.toThrow('groups unavailable')
    expect(src.mailbox).not.toHaveBeenCalled()
  })
})
