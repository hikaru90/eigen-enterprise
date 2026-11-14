import { describe, expect, it } from 'vitest'
import { inboxHref, parseInboxQuery } from './url'

const BOX = '5f0c7f2e-8c1a-4d55-9a57-0d1c2b3a4e5f'
const MSG = '0b6c1e3a-1f2d-4c5b-8a9e-7d6c5b4a3f2e'

describe('the Inbox URL holds the state', () => {
  it('reads box, folder, search, message and images', () => {
    const q = new URLSearchParams({ box: BOX, folder: 'spam', q: ' hello ', m: MSG, images: '1' })
    expect(parseInboxQuery(q)).toEqual({ ok: true, state: { box: BOX, folder: 'spam', q: 'hello', m: MSG, images: true, compose: null, sent: false, view: null, label: null, filter: null, sort: null } })
  })

  it('defaults to nothing chosen', () => {
    expect(parseInboxQuery(new URLSearchParams())).toEqual({ ok: true, state: { box: null, folder: null, q: null, m: null, images: false, compose: null, sent: false, view: null, label: null, filter: null, sort: null } })
    expect(parseInboxQuery(new URLSearchParams({ q: '   ' }))).toMatchObject({ state: { q: null } })
  })

  it('refuses an unknown folder or an id that is not a uuid (answered "not found")', () => {
    expect(parseInboxQuery(new URLSearchParams({ folder: 'drafts' }))).toEqual({ ok: false })
    expect(parseInboxQuery(new URLSearchParams({ box: 'x' }))).toEqual({ ok: false })
    expect(parseInboxQuery(new URLSearchParams({ m: "1' or 1=1" }))).toEqual({ ok: false })
  })

  it('reads the compose form (S5): new mail, or a reply/forward of the opened mail; and the Sent confirmation', () => {
    expect(parseInboxQuery(new URLSearchParams({ compose: 'new', box: BOX }))).toMatchObject({ ok: true, state: { compose: 'new', m: null } })
    expect(parseInboxQuery(new URLSearchParams({ compose: 'replyAll', m: MSG }))).toMatchObject({ ok: true, state: { compose: 'replyAll', m: MSG } })
    expect(parseInboxQuery(new URLSearchParams({ compose: 'reply' }))).toEqual({ ok: false })
    expect(parseInboxQuery(new URLSearchParams({ compose: 'draft' }))).toEqual({ ok: false })
    expect(parseInboxQuery(new URLSearchParams({ m: MSG, sent: '1' }))).toMatchObject({ state: { sent: true } })
    expect(inboxHref('/m/email/inbox', { m: MSG, compose: 'forward' })).toBe(`/m/email/inbox?m=${MSG}&compose=forward`)
    expect(inboxHref('/m/email/inbox', { box: BOX, folder: 'sent', m: MSG, sent: true })).toBe(`/m/email/inbox?box=${BOX}&folder=sent&m=${MSG}&sent=1`)
  })

  it('writes only what is set, in a stable order', () => {
    expect(inboxHref('/m/email/inbox', {})).toBe('/m/email/inbox')
    expect(inboxHref('/m/email/inbox', { box: BOX, folder: 'inbox', q: 'a b', m: MSG, images: true })).toBe(
      `/m/email/inbox?box=${BOX}&folder=inbox&q=a+b&m=${MSG}&images=1`,
    )
    expect(inboxHref('/m/email/inbox', { box: BOX, q: null, images: false })).toBe(`/m/email/inbox?box=${BOX}`)
  })
  it('reads the organising state: Starred or a label instead of a folder, a filter, oldest first', () => {
    const r = parseInboxQuery(new URLSearchParams({ label: BOX, filter: 'unread', sort: 'oldest' }))
    expect(r).toMatchObject({ ok: true, state: { folder: null, view: null, label: BOX, filter: 'unread', sort: 'oldest' } })
    expect(parseInboxQuery(new URLSearchParams({ view: 'starred' }))).toMatchObject({ ok: true, state: { view: 'starred' } })
    expect(parseInboxQuery(new URLSearchParams({ view: 'starred', folder: 'inbox' }))).toEqual({ ok: false })
    expect(parseInboxQuery(new URLSearchParams({ label: BOX, view: 'starred' }))).toEqual({ ok: false })
    expect(parseInboxQuery(new URLSearchParams({ view: 'drafts' }))).toEqual({ ok: false })
    expect(parseInboxQuery(new URLSearchParams({ label: 'x' }))).toEqual({ ok: false })
    expect(parseInboxQuery(new URLSearchParams({ filter: 'big' }))).toEqual({ ok: false })
    expect(parseInboxQuery(new URLSearchParams({ sort: 'newest' }))).toEqual({ ok: false })
    expect(inboxHref('/i', { box: BOX, view: 'starred', filter: 'attachments', sort: 'oldest' })).toBe(
      `/i?box=${BOX}&view=starred&filter=attachments&sort=oldest`,
    )
  })
})
