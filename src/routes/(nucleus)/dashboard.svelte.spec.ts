import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import { CAPABILITIES, type Capabilities } from '$lib/access/capabilities'
import { AssistantController } from '$lib/components/assistant/assistant-controller.svelte'
import type { TileId } from '$lib/dashboard/tiles'
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

function renderDashboard(
  assistant: AssistantController | null,
  tiles: { hiddenTiles?: TileId[]; saveHiddenTiles?: (hidden: TileId[]) => Promise<void> } = {},
  notices: { mailMissing?: boolean } = {},
) {
  return render(Harness, {
    assistant,
    hiddenTiles: tiles.hiddenTiles ?? [],
    saveHiddenTiles: tiles.saveHiddenTiles ?? (async () => {}),
    dashboard,
    greetingName: 'Alex',
    companyName: 'Kindred',
    navItems,
    capabilities,
    providerMissing: false,
    mailMissing: notices.mailMissing ?? false,
  })
}

describe('dashboard.svelte', () => {
  it('without company email: a notice says sign-in codes depend on it and links to the email setup', async () => {
    renderDashboard(controller(), {}, { mailMissing: true })
    await expect.element(page.getByTestId('dashboard-mail-notice')).toHaveTextContent(/Set up company email/)
    await expect.element(page.getByTestId('dashboard-mail-notice')).toHaveTextContent(/sign-in codes/)
    await expect.element(page.getByTestId('dashboard-mail-setup')).toHaveAttribute('href', '/m/email/setup')
  })

  it('with company email set up: no email notice', async () => {
    renderDashboard(controller())
    await expect.element(page.getByTestId('dashboard-mail-notice')).not.toBeInTheDocument()
  })

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

  it('every tile closes with its ×; hidden tiles come back from "Hidden tiles"; each change is saved', async () => {
    const save = vi.fn(async (_hidden: TileId[]) => {})
    renderDashboard(controller(), { hiddenTiles: ['activity'], saveHiddenTiles: save })
    // Hidden for this person (on every device): not on the board, offered back.
    await expect.element(page.getByTestId('dashboard-activity')).not.toBeInTheDocument()
    await expect.element(page.getByTestId('dashboard-hidden-tiles')).toHaveTextContent('Recent activity')

    await page.getByRole('button', { name: 'Hide Apps' }).click()
    await expect.element(page.getByTestId('overview-site-tile')).not.toBeInTheDocument()
    expect(save).toHaveBeenLastCalledWith(['apps', 'activity'])

    await page.getByRole('button', { name: 'Show Recent activity' }).click()
    await expect.element(page.getByTestId('dashboard-activity')).toBeInTheDocument()
    expect(save).toHaveBeenLastCalledWith(['apps'])
    for (const name of ['Assistant', 'Waiting on you', 'Recent activity', 'Approvals and warnings']) {
      await expect.element(page.getByRole('button', { name: `Hide ${name}` })).toBeInTheDocument()
    }
  })

  it('a change that could not be saved is undone and says so', async () => {
    renderDashboard(controller(), { saveHiddenTiles: async () => Promise.reject(new Error('offline')) })
    await page.getByRole('button', { name: 'Hide Apps' }).click()
    await expect.element(page.getByRole('alert')).toHaveTextContent('Could not save your tiles: offline')
    await expect.element(page.getByTestId('overview-site-tile')).toBeInTheDocument()
  })

  it('with the Assistant off, a hidden Assistant tile is not offered back', async () => {
    renderDashboard(null, { hiddenTiles: ['ask'] })
    await expect.element(page.getByTestId('dashboard-hidden-tiles')).not.toBeInTheDocument()
  })
})
