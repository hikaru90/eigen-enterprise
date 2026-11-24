import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import CallNowButton from './call-now-button.svelte'
import { CallRequestError, type ScheduleResult } from './client'
import { fakeCall } from './fake-room'

const result = (): ScheduleResult => ({
  call: fakeCall(),
  invitations: [],
  mailConfigured: true,
})

describe('call-now-button.svelte', () => {
  it('one click starts an instant call with nobody invited yet (invite later, now, no other link)', async () => {
    const schedule = vi.fn(async () => result())
    render(CallNowButton, { schedule })
    await page.getByTestId('calls-call-now').click()
    expect(schedule).toHaveBeenCalledTimes(1)
    expect(schedule).toHaveBeenCalledWith(
      expect.objectContaining({
        guests: [],
        userIds: [],
        startsAt: null,
        externalUrl: null,
        inviteLater: true,
      }),
    )
  })

  it('a refusal (e.g. already in a call) is shown, and the button works again', async () => {
    const schedule = vi
      .fn()
      .mockRejectedValueOnce(
        new CallRequestError({ kind: 'failed', message: "You're already in a call.", agent: null }),
      )
      .mockResolvedValueOnce(result())
    render(CallNowButton, { schedule })
    await page.getByTestId('calls-call-now').click()
    await expect
      .element(page.getByTestId('calls-call-now-error'))
      .toHaveTextContent('already in a call')
    await page.getByTestId('calls-call-now').click()
    expect(schedule).toHaveBeenCalledTimes(2)
    expect(page.getByTestId('calls-call-now-error').elements()).toHaveLength(0)
  })
})
