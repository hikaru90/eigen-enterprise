import { expect, test } from '@playwright/test'
import { assertRedirectsToLogin, loginUser, registerUser, signOut } from './test-helpers'

test.describe('Auth redirects (AC-019)', () => {
  const PROTECTED_ROUTES = ['/capture', '/activity', '/settings', '/settings/llm', '/memory/notes']

  for (const route of PROTECTED_ROUTES) {
    test(`redirects unauthenticated user from ${route} to /login`, async ({ page }) => {
      await assertRedirectsToLogin(page, route)
    })
  }
})

test.describe('Registration and login flow', () => {
  test('new user can register and lands on the nucleus /', async ({ page, context }) => {
    await registerUser(context, page)
    // nucleus: post-auth lands on / (the chatbox), not /capture
    await expect(page).toHaveURL(/:\d+\/$/)
    await expect(page.locator('[data-testid="nucleus-chatbox"]')).toBeVisible()
  })

  test('registered user can sign in and lands on the nucleus /', async ({ page, context }) => {
    const { email } = await registerUser(context, page)

    await signOut(page)

    await loginUser(page, email)
    // nucleus: post-auth lands on / (the chatbox), not /capture
    await expect(page).toHaveURL(/:\d+\/$/)
  })
})

test.describe('Passwordless email codes', () => {
  test('login has no password: email first, then a code', async ({ page }) => {
    await page.goto('/login')
    await expect(page.locator('#password')).toHaveCount(0)
    await page.locator('#email').fill(`code-${Date.now()}@test.eigen`)
    await page.getByRole('button', { name: 'Send code' }).click()
    await expect(page.getByTestId('auth-code-step')).toBeVisible()
  })

  test('a wrong code keeps you on the code step and says why', async ({ page }) => {
    await page.goto('/login')
    await page.locator('#email').fill(`wrong-${Date.now()}@test.eigen`)
    await page.getByRole('button', { name: 'Send code' }).click()
    await page.getByTestId('auth-code-step').waitFor()
    await page.locator('#code').fill('000000')
    await page.getByRole('button', { name: 'Continue' }).click()
    await expect(page.getByTestId('auth-code-error')).toBeVisible()
    await expect(page).toHaveURL(/\/login/)
  })
})

test.describe('Logout', () => {
  test('signed-out user is redirected to /login on protected pages', async ({ page, context }) => {
    await registerUser(context, page)

    await signOut(page)
    await page.goto('/capture')
    await page.waitForURL(/\/login/)
  })
})
