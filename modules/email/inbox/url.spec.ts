import { describe, expect, it } from 'vitest'
import { inboxHref, parseInboxQuery } from './url'

const BOX = '5f0c7f2e-8c1a-4d55-9a57-0d1c2b3a4e5f'
const MSG = '0b6c1e3a-1f2d-4c5b-8a9e-7d6c5b4a3f2e'

describe('the Inbox URL holds the state', () => {
  it('reads box, folder, search, message and images', () => {
    const q = new URLSearchParams({ box: BOX, folder: 'spam', q: ' hello ', m: MSG, images: '1' })
    expect(parseInboxQuery(q)).toEqual({ ok: true, state: { box: BOX, folder: 'spam', q: 'hello', m: MSG, images: true } })
  })

  it('defaults to nothing chosen', () => {
    expect(parseInboxQuery(new URLSearchParams())).toEqual({ ok: true, state: { box: null, folder: null, q: null, m: null, images: false } })
    expect(parseInboxQuery(new URLSearchParams({ q: '   ' }))).toMatchObject({ state: { q: null } })
  })

  it('refuses an unknown folder or an id that is not a uuid (answered "not found")', () => {
    expect(parseInboxQuery(new URLSearchParams({ folder: 'drafts' }))).toEqual({ ok: false })
    expect(parseInboxQuery(new URLSearchParams({ box: 'x' }))).toEqual({ ok: false })
    expect(parseInboxQuery(new URLSearchParams({ m: "1' or 1=1" }))).toEqual({ ok: false })
  })

  it('writes only what is set, in a stable order', () => {
    expect(inboxHref('/m/email/inbox', {})).toBe('/m/email/inbox')
    expect(inboxHref('/m/email/inbox', { box: BOX, folder: 'inbox', q: 'a b', m: MSG, images: true })).toBe(
      `/m/email/inbox?box=${BOX}&folder=inbox&q=a+b&m=${MSG}&images=1`,
    )
    expect(inboxHref('/m/email/inbox', { box: BOX, q: null, images: false })).toBe(`/m/email/inbox?box=${BOX}`)
  })
})
