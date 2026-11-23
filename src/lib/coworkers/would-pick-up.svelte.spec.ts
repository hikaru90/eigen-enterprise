import type { PickupCounts, PickupItem } from './pickup-format'
import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import WouldPickUp from './would-pick-up.svelte'

/**
 * "Would pick up" on a co-worker's profile (plan/phase-ai-coworkers.md C7): the switch for
 * channel messages, the counted outcomes (skipped ones too), the agreement line, and each
 * shadow decision with Jev's choice, its confidence, the link, and Theirs / Not theirs.
 */

const counts: PickupCounts = { observed: 5, queued: 0, failed: 1, skipped_rate_limit: 2, skipped_daily_cap: 1 }
const item: PickupItem = {
  id: 'd1',
  at: '2026-11-23T09:00:00.000Z',
  channel: 'launch',
  privateChannel: false,
  excerpt: 'We need the launch post drafted by Friday.',
  threadUrl: '/messages?c=c1&t=m1',
  jevChoice: 'yes',
  jevConfidence: 0.81,
  humanChoice: null,
}

describe('WouldPickUp', () => {
  it('shows the switch, the counts, agreement and each decision with its mark buttons', async () => {
    render(WouldPickUp, {
      coworkerId: 'cw1',
      noticing: true,
      hourlyLimit: 20,
      lastDay: counts,
      agreement: { agreed: 3, compared: 4 },
      items: [
        item,
        { ...item, id: 'd2', channel: 'leadership', privateChannel: true, excerpt: null, jevChoice: 'no', jevConfidence: 0.66, humanChoice: 'no' },
        { ...item, id: 'd3', jevChoice: null, jevConfidence: null },
      ],
    })
    await expect.element(page.getByTestId('pickup-notice')).toBeChecked()
    await expect.element(page.getByTestId('pickup-counts')).toHaveTextContent(
      'Last 24 hours: 5 judged, 2 skipped over the limit of 20 an hour, 1 skipped because its daily budget was spent, 1 failed.',
    )
    await expect.element(page.getByTestId('pickup-agreement')).toHaveTextContent('Agrees with people’s marks 3 of 4 times.')

    const rows = page.getByTestId('pickup')
    await expect.element(rows.nth(0)).toHaveTextContent(/Would pick up · 81% sure.*#launch.*Open message/)
    await expect.element(rows.nth(0).getByTestId('pickup-excerpt')).toHaveTextContent('We need the launch post drafted by Friday.')
    await expect.element(rows.nth(0).getByTestId('pickup-link')).toHaveAttribute('href', '/messages?c=c1&t=m1')
    await expect.element(rows.nth(0).getByTestId('pickup-label-yes')).toHaveTextContent('Theirs')
    await expect.element(rows.nth(0).getByTestId('pickup-label-no')).toHaveAttribute('aria-pressed', 'false')

    await expect.element(rows.nth(1)).toHaveTextContent(/Would leave it · 66% sure.*#leadership · Private channel/)
    await expect.element(rows.nth(1).getByTestId('pickup-excerpt')).not.toBeInTheDocument()
    await expect.element(rows.nth(1).getByTestId('pickup-labelled')).toHaveTextContent('You marked it not theirs')
    await expect.element(rows.nth(1).getByTestId('pickup-label-no')).toHaveAttribute('aria-pressed', 'true')

    await expect.element(rows.nth(2).getByTestId('pickup-choice')).toHaveTextContent('Jev gave no answer')
    await expect.element(rows.nth(2).getByTestId('pickup-label-yes')).not.toBeInTheDocument()
  })

  it('switched off, nothing noticed yet, no marks yet', async () => {
    render(WouldPickUp, { coworkerId: 'cw1', noticing: false, hourlyLimit: 20, lastDay: { ...counts, observed: 0, failed: 0, skipped_rate_limit: 0, skipped_daily_cap: 0 }, agreement: null, items: [] })
    await expect.element(page.getByTestId('pickup-notice')).not.toBeChecked()
    await expect.element(page.getByTestId('pickup-empty')).toHaveTextContent('Nothing noticed yet.')
    await expect.element(page.getByTestId('pickup-agreement')).toHaveTextContent('No marks yet.')
  })
})
