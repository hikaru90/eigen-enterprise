import { expect, test } from '@playwright/test'
import { completeOnboardingOverlay, registerUser } from './release-helpers'
import { gotoHydrated } from './test-helpers'

const TEST_PROJECT = 'QA Test Project'
const UNASSIGNED_TASK = 'Remember to buy milk and eggs from the grocery store'

/**
 * Memory › Projects: a task in no project is listed under "No project" with
 * Assign; choosing a project in the dialog files it there at once.
 *
 * The task comes in through Memory › Tasks' own "Add a task" field (the person
 * says it is a task, so no model has to classify it — the mock gateway cannot),
 * and onboarding is the first-run tour on What the brain knows. Platform
 * credits and the PayPal top-up are gone from the product (no /api/billing),
 * so the spec no longer buys any.
 */
test.describe('Projects: unassigned task assignment @qa', () => {
  test.describe.configure({ mode: 'serial', timeout: 300_000 })

  test('assign task from No project section removes it and shows under project', async ({
    page,
    context,
  }) => {
    await test.step('register and onboard', async () => {
      await registerUser(context, page, { emailDomain: 'example.com' })
      // nucleus: post-auth lands on /
      await expect(page).toHaveURL(/:\d+\/$/)
      await gotoHydrated(page, '/m/memory/capture')
      await completeOnboardingOverlay(page)
    })

    await test.step('create a project via API', async () => {
      const res = await page.request.post('/api/timeline/projects', {
        data: { label: TEST_PROJECT, status: 'active' },
      })
      expect(res.ok(), await res.text()).toBeTruthy()
    })

    await test.step('add a task in no project from Memory › Tasks', async () => {
      await gotoHydrated(page, '/m/memory/tasks')
      const field = page.getByTestId('timeline-add-task').getByRole('textbox')
      await field.fill(UNASSIGNED_TASK)
      await field.press('Enter')
      await expect(page.getByRole('button', { name: `Mark done: ${UNASSIGNED_TASK}` })).toBeVisible(
        { timeout: 30_000 },
      )
    })

    const unassigned = page.getByTestId('unassigned-tasks')
    const row = unassigned.getByRole('listitem').filter({ hasText: UNASSIGNED_TASK })

    await test.step('the No project section lists it with Assign', async () => {
      await gotoHydrated(page, '/m/memory/projects')
      await expect(unassigned.getByRole('heading', { name: /No project \(\d+\)/ })).toBeVisible({
        timeout: 30_000,
      })
      await expect(row.getByRole('button', { name: 'Assign' })).toBeVisible()
    })

    await test.step('Assign → pick the project in the dialog', async () => {
      await row.getByRole('button', { name: 'Assign' }).click()
      const dialog = page.getByRole('dialog')
      await expect(dialog).toBeVisible()
      // Choosing a project files the task at once and closes the dialog.
      await dialog.getByRole('button', { name: new RegExp(TEST_PROJECT) }).click()
      await expect(dialog).toBeHidden({ timeout: 10_000 })
    })

    await test.step('it leaves No project and belongs to the project', async () => {
      await expect(row).toHaveCount(0, { timeout: 10_000 })
      const res = await page.request.get('/api/temporal-events?author=user')
      expect(res.ok()).toBeTruthy()
      const body = (await res.json()) as {
        items?: Array<{ semanticSummary: string; projectEntityId: string | null }>
      }
      const task = body.items?.find((t) => t.semanticSummary?.includes('buy milk'))
      expect(task, JSON.stringify(body.items?.map((t) => t.semanticSummary))).toBeTruthy()
      expect(task!.projectEntityId).toBeTruthy()
    })
  })
})
