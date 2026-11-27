import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import ReputationPage from './+page.svelte'

vi.mock('$app/paths', () => ({
  base: '',
  resolve: (path: string, params?: Record<string, string>) =>
    params ? path.replace(/\[(\w+)\]/g, (_, k: string) => params[k] ?? '') : path,
}))
vi.mock('$app/forms', () => ({ enhance: () => ({ destroy: () => undefined }) }))

const criteria = {
  thresholds: {
    bounce: { watch: 0.02, review: 0.05, pause: 0.1 },
    complaint: { watch: 0.0005, review: 0.001, pause: 0.005 },
  },
  volume: { bounce: 100, complaint: 1000, slice: 50 },
  window: { days: 30, mails: 2000 },
}

const held = {
  configured: true as const,
  reputation: {
    band: 'held',
    sendingHeld: true,
    tracking: true,
    mode: 'own',
    since: '2026-10-28T12:00:00.000Z',
    rates: { recipients: 200, bounces: 12, complaints: 0, bounceRate: 0.06, complaintRate: 0 },
    reasons: ['6.0% of your recent mail bounced (12 of 200). Amazon reviews an account from 5.0% and may pause it from 10.0%.'],
    amazon: { mode: 'own', enforcement: 'HEALTHY', sendingEnabled: true },
    lastCheck: { at: '2026-11-27T12:00:00.000Z', amazonError: null },
    slices: [
      {
        dimension: 'ref',
        value: 'flow:f-1',
        label: 'Flow “Spring sale”',
        band: 'held',
        recipients: 80,
        bounces: 11,
        complaints: 0,
        bounceRate: 0.1375,
        complaintRate: 0,
        reasons: ['13.8% of this flow’s mail bounced (11 of 80).'],
        flowId: 'f-1',
        apiKey: false,
      },
    ],
  },
  history: [
    { id: 'c1', at: '2026-11-27T12:00:00.000Z', band: 'held', recipients: 200, bounceRate: 0.06, complaintRate: 0, amazon: 'HEALTHY', amazonError: null },
  ],
  resumes: [],
  criteria,
}

describe('Email › Setup › Reputation', () => {
  it('shows a hold with its reason, the flagged flow, the history, and lets an admin resume with what was fixed', async () => {
    render(ReputationPage, { data: { ...held, email: { active: true, isAdmin: true } }, form: null } as never)
    await expect.element(page.getByTestId('reputation-state')).toHaveAttribute('data-band', 'held')
    await expect.element(page.getByRole('heading', { name: 'Sending on hold' })).toBeVisible()
    await expect.element(page.getByTestId('reputation-bounce-rate')).toHaveTextContent('6.0%')
    await expect.element(page.getByTestId('reputation-reasons')).toHaveTextContent(/Amazon reviews an account from 5.0%/)
    await expect.element(page.getByRole('link', { name: 'Flow “Spring sale”' })).toHaveAttribute('href', '/m/email/marketing/flows/f-1')
    await expect.element(page.getByTestId('reputation-history')).toHaveTextContent(/Sending on hold/)
    await expect.element(page.getByLabelText('Resume sending')).toBeVisible()
    await expect.element(page.getByRole('button', { name: 'Check now' })).toBeVisible()
  })

  it('a member sees the state but neither Check now nor Resume', async () => {
    render(ReputationPage, { data: { ...held, email: { active: true, isAdmin: false } }, form: null } as never)
    await expect.element(page.getByRole('heading', { name: 'Sending on hold' })).toBeVisible()
    await expect.element(page.getByTestId('reputation-resume')).not.toBeInTheDocument()
    await expect.element(page.getByTestId('reputation-check')).not.toBeInTheDocument()
  })

  it('Amazon pausing the account offers no resume here', async () => {
    const paused = {
      ...held,
      reputation: {
        ...held.reputation,
        band: 'paused',
        reasons: ['Amazon SES paused sending for your account because of bounces or complaints. Check the SES console › Reputation.'],
        amazon: { mode: 'own', enforcement: 'SHUTDOWN', sendingEnabled: true },
        slices: [],
      },
    }
    render(ReputationPage, { data: { ...paused, email: { active: true, isAdmin: true } }, form: null } as never)
    await expect.element(page.getByRole('heading', { name: 'Paused by Amazon' })).toBeVisible()
    await expect.element(page.getByTestId('reputation-amazon')).toHaveTextContent('Paused')
    await expect.element(page.getByTestId('reputation-resume')).not.toBeInTheDocument()
    await expect.element(page.getByTestId('reputation-flagged-empty')).toBeVisible()
  })
})
