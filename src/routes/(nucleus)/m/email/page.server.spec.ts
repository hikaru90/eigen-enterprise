import { describe, expect, it, vi } from 'vitest'

vi.mock('./access.server', () => ({ requireMember: vi.fn(async () => ({ userId: 'u1', email: 'me@x.co', isAdmin: false })) }))

const { load } = await import('./+page.server')

const visit = async (url: string) => {
  try {
    await load({ locals: {}, url: new URL(url) } as never)
  } catch (err) {
    return err as { status: number; location: string }
  }
  throw new Error('expected a redirect')
}

describe('Email lands on your inbox (Contribute eb674853, plan/email-inbox.md S6)', () => {
  it('/m/email opens the Inbox', async () => {
    expect(await visit('https://os.example/m/email')).toMatchObject({ status: 303, location: '/m/email/inbox' })
  })
  it('keeps a mailbox, folder or mail in the query (old bookmarks keep working)', async () => {
    expect(await visit('https://os.example/m/email?box=b1&folder=spam')).toMatchObject({
      status: 303,
      location: '/m/email/inbox?box=b1&folder=spam',
    })
  })
})
