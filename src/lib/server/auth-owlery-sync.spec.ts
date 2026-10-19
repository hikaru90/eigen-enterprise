import { afterEach, describe, expect, it, vi } from 'vitest'
import { syncOwleryContactForVerifiedUser } from './auth-owlery-sync'

describe('syncOwleryContactForVerifiedUser', () => {
  afterEach(() => vi.restoreAllMocks())

  it('logs an explicit skip for a verified user (no contact book in the SES module yet)', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    await syncOwleryContactForVerifiedUser({ id: 'u1', email: 'a@b.com', emailVerified: true })
    expect(info).toHaveBeenCalledWith(
      '[auth] contact-book sync skipped: the email module has no contact book yet',
      { userId: 'u1' },
    )
  })

  it('does nothing for an unverified user', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    await syncOwleryContactForVerifiedUser({ id: 'u1', email: 'a@b.com', emailVerified: false })
    expect(info).not.toHaveBeenCalled()
  })
})
