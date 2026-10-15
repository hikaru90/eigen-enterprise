import { expect, test, type Page } from '@playwright/test'
import { registerUser } from './test-helpers'

/**
 * The Extension Roadmap (owner-directed): the company's build log, queue, and
 * plan, visible under Settings → Extensions. Read-only mirror of the roadmap
 * module's store — the seeds from drizzle/0084 must render in their three
 * sections, and the top-right settings menu must offer the surface.
 */

async function openExtensions(page: Page): Promise<void> {
  await page.goto('/settings/extensions')
  await expect(page.getByRole('heading', { name: 'Extension Roadmap' })).toBeVisible({
    timeout: 15_000,
  })
}

/**
 * SSR buttons click before Svelte hydration attaches the popover handler —
 * retry the trigger until the menu actually opens (same discipline as the
 * boot wizard's continueToStep).
 */
async function openSettingsMenu(page: Page): Promise<void> {
  const trigger = page.getByTestId('home-settings-trigger')
  const extensions = page.getByRole('link', { name: 'Extensions' })
  for (let attempt = 0; attempt < 5; attempt++) {
    await trigger.click()
    const opened = await extensions
      .waitFor({ state: 'visible', timeout: 2_000 })
      .then(() => true)
      .catch(() => false)
    if (opened) return
  }
  await expect(extensions).toBeVisible()
}

test.describe('extension roadmap', () => {
  test('the settings menu offers Extensions; the page renders the three sections with the seeds', async ({
    page,
    context,
  }) => {
    await registerUser(context, page, { emailDomain: 'test.eigenlabs.dev' })

    // The top-right cog names the surface.
    await page.goto('/')
    await openSettingsMenu(page)
    await page.getByRole('link', { name: 'Extensions' }).click()
    await expect(page.getByRole('heading', { name: 'Extension Roadmap' })).toBeVisible({
      timeout: 15_000,
    })

    // Shipped build log (with dates), the queue, the plan.
    const shipped = page.getByTestId('roadmap-shipped')
    await expect(shipped.getByRole('heading', { name: 'Shipped' })).toBeVisible()
    await expect(shipped.getByText('Founding journey')).toBeVisible()
    await expect(shipped.getByText('Journey hardening')).toBeVisible()
    const queue = page.getByTestId('roadmap-in-progress')
    await expect(queue.getByRole('heading', { name: 'In the queue' })).toBeVisible()
    await expect(queue.getByText('Live journey verification')).toBeVisible()
    const planned = page.getByTestId('roadmap-planned')
    await expect(planned.getByRole('heading', { name: 'Planned' })).toBeVisible()
    await expect(planned.getByText('One-command deploy')).toBeVisible()
    await expect(planned.getByText('Software factory M0')).toBeVisible()
  })

  test('deep-linking to /settings/extensions lands signed-in users on the board', async ({
    page,
    context,
  }) => {
    await registerUser(context, page, { emailDomain: 'test.eigenlabs.dev' })
    await openExtensions(page)
    await expect(page.getByTestId('roadmap-shipped').getByText('Kernel + module system')).toBeVisible()
  })
})
