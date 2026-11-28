import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import type { CoworkerProfilePayload } from './profile'
import CoworkerProfilePanel from './coworker-profile-panel.svelte'

/** Wish 7c6db153: a co-worker's profile inside Messages; wish acdb941e: its AI usage for owner/admins. */

const coworker = {
  id: 'cw1',
  name: 'Mara',
  email: 'm@x.invalid',
  slug: 'mara',
  image: null,
  title: 'Marketing Manager',
  accountabilities: ['Pipeline', 'Launch posts'],
  lens: 'Cares about reach.',
  modelId: 'google/gemini-3.8-flash',
  enabled: true,
  dailyCapUsd: 2,
  templateId: null,
  reportsToUserId: null,
  reportsToUserIds: [],
  accountableHuman: { id: 'o', name: 'Olga', reason: 'owner' },
  accountableHumans: [{ id: 'o', name: 'Olga', reason: 'owner' }],
  agentId: 'coworker-cw1',
  createdBy: 'o',
  createdAt: '2026-11-23T10:00:00.000Z',
  updatedAt: '2026-11-23T10:00:00.000Z',
  removedAt: null,
} as unknown as CoworkerProfilePayload['coworker']

describe('coworker-profile-panel', () => {
  it('an admin reads everything, its usage per period, and gets the edit path', async () => {
    const load = vi.fn(async (_id: string, period: '7' | '30' | '90' | 'all') => ({
      coworker,
      canManage: true,
      usage: { amounts: { costUsd: period === '7' ? 0.1 : 0.5, calls: 2, promptTokens: 80, completionTokens: 20, cachedTokens: 0 }, billing: null, period },
    }))
    render(CoworkerProfilePanel, { coworkerId: 'cw1', onclose: () => {}, load })
    await expect.element(page.getByTestId('coworker-profile-name')).toHaveTextContent('Mara')
    await expect.element(page.getByTestId('coworker-profile-title')).toHaveTextContent('Marketing Manager')
    await expect.element(page.getByTestId('coworker-profile-accountabilities')).toHaveTextContent('Launch posts')
    await expect.element(page.getByTestId('coworker-profile-lens')).toHaveTextContent('Cares about reach.')
    await expect.element(page.getByTestId('coworker-profile-usage-cost')).toHaveTextContent('$0.50')
    await page.getByRole('button', { name: 'Last 7 days' }).click()
    await expect.element(page.getByTestId('coworker-profile-usage-cost')).toHaveTextContent('$0.10')
    expect(load.mock.calls.map((c) => c[1])).toEqual(['30', '7'])
    await expect.element(page.getByTestId('coworker-profile-edit')).toHaveAttribute('href', '/settings/coworkers#coworker-cw1')
  })

  it('a member reads the profile without usage or the edit path', async () => {
    render(CoworkerProfilePanel, { coworkerId: 'cw1', onclose: () => {}, load: async () => ({ coworker, canManage: false, usage: null }) })
    await expect.element(page.getByTestId('coworker-profile-name')).toHaveTextContent('Mara')
    await expect.element(page.getByTestId('coworker-profile-open')).toBeVisible()
    expect(page.getByTestId('coworker-profile-edit').query()).toBeNull()
    expect(page.getByTestId('coworker-profile-usage').query()).toBeNull()
  })

  it('a failed read says so, with the agent instructions', async () => {
    render(CoworkerProfilePanel, { coworkerId: 'cw1', onclose: () => {}, load: async () => { throw new Error('The profile could not be loaded (HTTP 500).') } })
    await expect.element(page.getByRole('alert')).toHaveTextContent('HTTP 500')
  })
})
