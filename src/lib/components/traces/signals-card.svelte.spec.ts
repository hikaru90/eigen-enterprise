import type { TracesSettingsView } from '../../../../modules/traces/service'
import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import SignalsCard from './signals-card.svelte'

vi.mock('$app/forms', () => ({ enhance: () => ({ destroy: () => undefined }) }))
vi.mock('$app/paths', () => ({ resolve: (path: string) => path }))

const status = (over: Partial<TracesSettingsView> = {}): TracesSettingsView => ({
  enabled: true,
  hubConfigured: true,
  hubMessage: null,
  lastSentAt: '2026-11-20T10:00:00.000Z',
  lastError: null,
  updatedAt: '2026-11-20T10:00:00.000Z',
  fields: ['kind', 'tool', 'model', 'duration_ms'],
  ...over,
})

describe('signals-card.svelte (plan/traces-phone-home.md T4)', () => {
  it('says it is on, lists the only fields, links to what was sent; the owner can switch it off', async () => {
    render(SignalsCard, { status: status(), canSwitch: true, result: null })
    await expect.element(page.getByTestId('signals-enabled')).toHaveTextContent('On')
    await expect.element(page.getByTestId('signals-fields')).toHaveTextContent('kind · tool · model · duration_ms')
    await expect.element(page.getByTestId('signals-sent-link')).toHaveAttribute('href', '/settings/company/signals')
    await expect.element(page.getByTestId('signals-toggle')).toHaveTextContent('Turn product signals off')
  })

  it('an admin sees it read-only: no switch', async () => {
    render(SignalsCard, { status: status(), canSwitch: false, result: null })
    await expect.element(page.getByTestId('signals-toggle')).not.toBeInTheDocument()
  })

  it('shows why nothing is sent', async () => {
    render(SignalsCard, { status: status({ hubConfigured: false, hubMessage: 'CONTRIBUTE_HUB_URL is not set', lastError: 'HTTP 400' }), canSwitch: true, result: null })
    await expect.element(page.getByTestId('signals-not-configured')).toHaveTextContent('CONTRIBUTE_HUB_URL is not set')
    await expect.element(page.getByTestId('signals-last-error')).toHaveTextContent('HTTP 400')
  })
})
