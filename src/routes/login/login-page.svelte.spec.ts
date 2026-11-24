import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import LoginPage from './+page.svelte'

vi.mock('$app/forms', () => ({
  enhance: () => ({ destroy: () => {} }),
}))

vi.mock('$app/paths', () => ({
  resolve: (p: string) => p,
}))

vi.mock('$lib/auth-client', () => ({
  authClient: { signIn: { passkey: vi.fn() } },
}))

function baseData(over: Record<string, unknown> = {}) {
  return {
    socialProviders: [],
    oauthError: null,
    mailConfigured: true,
    unclaimed: null,
    demoGuest: null,
    teamSignIn: false,
    signupOpen: false,
    openJoin: false,
    ...over,
  }
}

describe('login page — one-click demo welcome card', () => {
  it('shows the one-click Explore welcome card and tucks Team sign in underneath when demoGuest is active', async () => {
    render(LoginPage, {
      data: baseData({
        demoGuest: {
          companyName: 'Northwind Studio',
          guestName: 'Sophie Wagner',
          aiCallsPerIp: 2,
        },
      }) as never,
      form: null as never,
    })

    await expect.element(page.getByTestId('demo-welcome-card')).toBeInTheDocument()
    await expect.element(page.getByRole('button', { name: 'Explore Northwind Studio' })).toBeInTheDocument()
    await expect.element(page.getByText(/Sophie Wagner/)).toBeInTheDocument()
    await expect.element(page.getByText(/up to 2 AI calls per\s+day/)).toBeInTheDocument()
    await expect.element(page.getByTestId('team-sign-in-toggle')).toBeInTheDocument()
  })

  it('shows the normal Sign in form with no demo card when demoGuest is null', async () => {
    render(LoginPage, {
      data: baseData() as never,
      form: null as never,
    })

    await expect.element(page.getByTestId('demo-welcome-card')).not.toBeInTheDocument()
    await expect.element(page.getByRole('button', { name: 'Send code' })).toBeInTheDocument()
  })
})
