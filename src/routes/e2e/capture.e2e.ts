import { expect, test } from '@playwright/test'
import { captureThought, gotoHydrated, registerUser } from './test-helpers'

/**
 * Memory › What the brain knows (/m/memory/capture; plan/concept-memory-one-door.md):
 * a read-only list of what the brain took in. Nothing is typed in here — the
 * Ask bar is the one door — so the thoughts are put in through the capture API
 * (as the assistant's memory.capture_thought would) and the page is read.
 * Each visit waits for hydration: the rows are server-rendered, so a click on
 * Delete right after the load reaches markup with no handler yet.
 */
test.describe('What the brain knows (read-only list)', () => {
  test('has no input of its own and points to the Ask bar', async ({ page, context }) => {
    await registerUser(context, page)
    await gotoHydrated(page, '/m/memory/capture')
    await expect(page.getByTestId('brain-knows')).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('#thought')).toHaveCount(0)
    await expect(page.getByTestId('tell-the-brain')).toContainText('Ask bar')
  })

  test('lists a thought the brain took in, with its detail on expand', async ({ page, context }) => {
    await registerUser(context, page)
    const thought = await captureThought(page, 'Expand toggle test thought about the Berlin museum visit')
    await gotoHydrated(page, '/m/memory/capture')

    const row = page.getByTestId('brain-knows-row').filter({ hasText: /Berlin museum visit/ })
    await expect(row).toBeVisible({ timeout: 30_000 })
    await expect(row.getByTestId('brain-knows-source')).toHaveText('Typed or spoken in the app')
    await expect(row.getByTestId('brain-knows-status')).toBeVisible()

    await row.getByRole('button', { name: 'Show details' }).click()
    await expect(row.getByText('Category:')).toBeVisible({ timeout: 30_000 })
    await row.getByRole('button', { name: 'Hide details' }).click()
    await expect(row.getByText('Category:')).toHaveCount(0)
    expect(thought.id).toBeTruthy()
  })

  test('deletes a thought for good after a confirmation', async ({ page, context }) => {
    await registerUser(context, page)
    await captureThought(page, 'A thought about the Q3 budget report to delete')
    await gotoHydrated(page, '/m/memory/capture')

    const row = page.getByTestId('brain-knows-row').filter({ hasText: /Q3 budget report/ })
    await expect(row).toBeVisible({ timeout: 30_000 })
    await row.getByTestId('brain-knows-delete').click()
    const confirm = page.getByTestId('brain-knows-delete-confirm')
    await expect(confirm).toContainText('can’t be undone')
    await confirm.getByRole('button', { name: 'Delete' }).click()
    await expect(row).toHaveCount(0, { timeout: 30_000 })
  })
})
