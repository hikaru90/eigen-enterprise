import type { NextUpResult } from '../client'
import type { ContactDto, NextUpItem } from '../types'
import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import NextUpStrip from './next-up-strip.svelte'

const contact = (over: Partial<ContactDto> = {}): ContactDto => ({
  id: 'c1',
  name: 'Mara Voss',
  organisation: 'Northwind Capital',
  title: null,
  channels: [{ type: 'email', value: 'mara@northwind.example' }],
  metHow: null,
  whyRelevant: null,
  tags: [],
  lastContactedOn: null,
  nextFollowUpOn: null,
  nextStep: null,
  stage: 'waiting',
  ownerId: 'ana',
  ownerName: 'Ana Lind',
  via: 'email',
  latestStatus: null,
  waitingSince: '2026-11-01',
  shared: false,
  sharedWith: [],
  sharedWithViewer: false,
  own: true,
  createdByName: 'Ana Lind',
  canManage: true,
  createdAt: '2026-11-01T10:00:00Z',
  updatedAt: '2026-11-01T10:00:00Z',
  ...over,
})

const ready = (items: NextUpItem[]): NextUpResult => ({ ok: true, nextUp: { generatedAt: '2026-11-12T09:30:00Z', items } })

const items: NextUpItem[] = [
  { contact: contact(), kind: 'chase', reason: 'Waited 11 days on the deck' },
  { contact: contact({ id: 'c2', name: 'Jon Park', organisation: null, channels: [{ type: 'phone', value: '+49 30 1' }] }), kind: 'write', reason: 'Pricing is 2 days late' },
]

describe('next-up-strip.svelte (who to write to next, picked by the assistant)', () => {
  it('shows each suggestion with its reason and a one-click write (their mail) or open', async () => {
    const load = vi.fn(async () => ready(items))
    render(NextUpStrip, { today: '2026-11-12', load })
    await expect.element(page.getByTestId('next-up-item').first()).toBeVisible()
    expect(load).toHaveBeenCalledWith(false)
    const reasons = page.getByTestId('next-up-reason')
    await expect.element(reasons.nth(0)).toHaveTextContent('Waited 11 days on the deck')
    await expect.element(reasons.nth(1)).toHaveTextContent('Pricing is 2 days late')
    await expect.element(page.getByRole('link', { name: 'Nudge: Mara Voss' })).toHaveAttribute('href', 'mailto:mara@northwind.example')
    // No mail address: "Write" opens the contact instead.
    await expect.element(page.getByRole('link', { name: 'Write: open Jon Park' })).toHaveAttribute('href', '/m/email/people/c2')
    await expect.element(page.getByRole('link', { name: 'Mara Voss', exact: true })).toHaveAttribute('href', '/m/email/people/c1')
    await expect.element(page.getByTestId('next-up-when')).toHaveTextContent(/Suggested by the assistant at/)
  })

  it('"Suggest again" asks the assistant anew', async () => {
    const load = vi.fn(async (refresh: boolean) => ready(refresh ? [items[1]!] : items))
    render(NextUpStrip, { today: '2026-11-12', load })
    await expect.element(page.getByTestId('next-up-item').nth(1)).toBeVisible()
    await page.getByRole('button', { name: 'Suggest again' }).click()
    await expect.element(page.getByRole('link', { name: 'Mara Voss', exact: true })).not.toBeInTheDocument()
    expect(load).toHaveBeenLastCalledWith(true)
  })

  it('"Log contact" opens the log form for that person below the strip', async () => {
    render(NextUpStrip, { today: '2026-11-12', load: async () => ready(items) })
    await page.getByRole('button', { name: 'Log contact with Jon Park' }).click()
    await expect.element(page.getByRole('form', { name: 'Log a contact with Jon Park' })).toBeVisible()
    await expect.element(page.getByLabelText('In touch on')).toHaveValue('2026-11-12')
    await page.getByRole('button', { name: 'Cancel' }).click()
    await expect.element(page.getByRole('form', { name: 'Log a contact with Jon Park' })).not.toBeInTheDocument()
  })

  it('without an AI provider it says so plainly — no list, no refresh', async () => {
    render(NextUpStrip, {
      today: '2026-11-12',
      load: async () => ({ ok: false, unavailable: true, message: 'The company has no AI provider set up yet.' }),
    })
    await expect.element(page.getByTestId('next-up-unavailable')).toHaveTextContent('no AI provider')
    await expect.element(page.getByTestId('next-up-item')).not.toBeInTheDocument()
    await expect.element(page.getByRole('button', { name: 'Suggest again' })).not.toBeInTheDocument()
  })

  it('a failure is an alert you can retry; nobody to suggest says so', async () => {
    const load = vi
      .fn<(refresh: boolean) => Promise<NextUpResult>>()
      .mockResolvedValueOnce({ ok: false, unavailable: false, message: 'The provider refused (HTTP 429).' })
      .mockResolvedValueOnce(ready([]))
    render(NextUpStrip, { today: '2026-11-12', load })
    await expect.element(page.getByRole('alert')).toHaveTextContent('HTTP 429')
    await page.getByRole('button', { name: 'Suggest again' }).click()
    await expect.element(page.getByTestId('next-up-empty')).toHaveTextContent(/Nobody to write to right now/)
  })
})
