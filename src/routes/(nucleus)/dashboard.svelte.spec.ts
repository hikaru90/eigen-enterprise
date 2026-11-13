import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import { CAPABILITIES, type Capabilities } from '$lib/access/capabilities'
import { AssistantController } from '$lib/components/assistant/assistant-controller.svelte'
import type { Dashboard } from '$lib/server/overview/dashboard'
import { buildShellNav } from '$lib/shell/nav'
import Harness from './dashboard-test-harness.svelte'

/**
 * The dashboard with the Assistant on (unchanged) and switched off (round 5:
 * off means off — no way into an assistant that is not there).
 */

const capabilities = Object.fromEntries(CAPABILITIES.map((c) => [c, true])) as Capabilities
const navItems = buildShellNav(
  [{ id: 'website', name: 'Website' }],
  new Map([['website', true]]),
  capabilities,
).items

const dashboard: Dashboard = {
  backup: null,
  overview: {
    modules: [
      {
        id: 'website',
        name: 'Website',
        description: 'Apps.',
        active: true,
        results: [],
        resultsTitle: 'Apps',
        counts: [],
        note: null,
      },
      {
        id: 'drive',
        name: 'Drive',
        description: 'Files.',
        active: false,
        results: [],
        resultsTitle: 'Files',
        counts: [],
        note: null,
      },
    ],
    actions: [],
    approvals: [{ id: 'a1', text: 'Publish the Home page' }],
  },
}

const controller = () =>
  new AssistantController({
    fetch: async () => new Response('{}', { status: 500 }),
    speak: () => {},
    cancelSpeak: () => {},
    storage: () => localStorage,
    viewportWidth: () => 1280,
  })

function renderDashboard(assistant: AssistantController | null) {
  return render(Harness, {
    assistant,
    dashboard,
    greetingName: 'Alex',
    companyName: 'Kindred',
    navItems,
    capabilities,
    providerMissing: false,
  })
}

describe('dashboard.svelte', () => {
  it('with the Assistant on: the ask box, the approval Review, the conversations link and the activity log', async () => {
    renderDashboard(controller())
    await expect.element(page.getByTestId('dashboard-ask')).toBeInTheDocument()
    await expect.element(page.getByTestId('overview-approval-review')).toBeInTheDocument()
    await expect
      .element(page.getByTestId('dashboard-link-assistant'))
      .toHaveAttribute('href', '/assistant')
    await expect
      .element(page.getByText('All activity'))
      .toHaveAttribute('href', '/assistant/activity')
    await expect
      .element(page.getByTestId('overview-modules-hint'))
      .toHaveTextContent('1 switched off — ask the assistant to turn it on')
  })

  it('with the Assistant switched off: no ask box, no Review into the panel, no conversations link — the approvals and the activity log stay', async () => {
    renderDashboard(null)
    await expect.element(page.getByTestId('dashboard')).toBeInTheDocument()
    await expect.element(page.getByTestId('dashboard-ask')).not.toBeInTheDocument()
    await expect.element(page.getByTestId('overview-approval-review')).not.toBeInTheDocument()
    await expect.element(page.getByText('Publish the Home page')).toBeInTheDocument()
    await expect
      .element(page.getByTestId('overview-approvals-assistant-off'))
      .toHaveTextContent('The Assistant is switched off')
    await expect.element(page.getByTestId('dashboard-link-assistant')).not.toBeInTheDocument()
    await expect
      .element(page.getByText('All activity'))
      .toHaveAttribute('href', '/assistant/activity')
    await expect
      .element(page.getByTestId('overview-modules-hint'))
      .toHaveTextContent(/^1 switched off$/)
  })
})
