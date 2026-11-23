import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import AiUsageMeter from './ai-usage-meter.svelte'

const member = {
  role: 'member' as const,
  capUsd: 0.5,
  capApplies: true,
  spentUsd: 0.1,
  remainingUsd: 0.4,
  resetsAt: '2026-11-24T00:00:00.000Z',
}

describe('ai-usage-meter.svelte', () => {
  it('a member below 80 % of the cap: the amount, the bar and what is left', async () => {
    render(AiUsageMeter, { usage: member })
    const meter = page.getByTestId('ai-usage-meter')
    await expect.element(meter).toHaveAttribute('data-zone', 'ok')
    await expect.element(meter).toHaveTextContent(/\$0\.10 of \$0\.50/)
    await expect.element(page.getByRole('meter')).toHaveAttribute('aria-valuemax', '0.5')
    await expect.element(page.getByTestId('ai-usage-meter-note')).toHaveTextContent(/\$0\.40 left today/)
  })

  it('from 80 % of the cap it is the red zone; at the cap it says so', async () => {
    render(AiUsageMeter, { usage: { ...member, spentUsd: 0.42, remainingUsd: 0.08 } })
    await expect.element(page.getByTestId('ai-usage-meter')).toHaveAttribute('data-zone', 'near')
    render(AiUsageMeter, { usage: { ...member, spentUsd: 0.5, remainingUsd: 0 }, testid: 'over' })
    await expect.element(page.getByTestId('over')).toHaveAttribute('data-zone', 'over')
    await expect.element(page.getByTestId('over-note')).toHaveTextContent(/daily cap is reached/)
  })

  it('no cap, and owner/admins exempt, are said plainly', async () => {
    render(AiUsageMeter, { usage: { ...member, capUsd: null, capApplies: false, remainingUsd: null } })
    await expect.element(page.getByTestId('ai-usage-meter-note')).toHaveTextContent('The company has no daily AI cap per member.')
    render(AiUsageMeter, { usage: { ...member, role: 'owner', capApplies: false, remainingUsd: null }, testid: 'owner' })
    await expect.element(page.getByTestId('owner-note')).toHaveTextContent('Owners and admins have no daily cap. Members can use up to $0.50 a day.')
  })

  it('compact: a pill with spent / cap, the whole sentence for screen readers', async () => {
    render(AiUsageMeter, { usage: { ...member, spentUsd: 0.45, remainingUsd: 0.05 }, variant: 'compact' })
    const pill = page.getByTestId('ai-usage-meter')
    await expect.element(pill).toHaveAttribute('data-zone', 'near')
    await expect.element(pill).toHaveTextContent(/\$0\.45 \/ \$0\.50/)
    await expect.element(pill).toHaveAttribute('title', 'Your AI use today: $0.45 of $0.50 ($0.05 left until midnight UTC).')
  })
})
