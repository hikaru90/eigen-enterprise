import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import postgres from 'postgres'
import { registerUser, signOut } from './test-helpers'

/**
 * E1: the running app on the fake mail transport (playwright.config sets
 * MAIL_TRANSPORT=fake). The onboarding mail step goes through the real
 * endpoint with the owner's session: sender not verified (409) → verified →
 * the test mail is captured; then a sign-in code arrives through the same
 * transport and the owner signs in with the code read from the captured mail.
 */

const DATABASE_URL = process.env.DATABASE_URL?.trim()
test.skip(!DATABASE_URL, 'DATABASE_URL not set — the journey promotes its user in the dev DB')

let _sql: postgres.Sql | null = null
function sql(): postgres.Sql {
  _sql ??= postgres(DATABASE_URL!, { prepare: false })
  return _sql
}

type Captured = { from: string; to: string; subject: string; text: string; html: string; messageId: string }

async function resetMail(request: APIRequestContext): Promise<void> {
  const res = await request.delete('/api/e2e/harness/mail')
  expect(res.status(), await res.text()).toBe(200)
}

async function capturedFor(page: Page, to: string): Promise<Captured[]> {
  const res = await page.request.get(`/api/e2e/harness/mail?to=${encodeURIComponent(to)}`)
  expect(res.status(), await res.text()).toBe(200)
  return ((await res.json()) as { mails: Captured[] }).mails
}

test.describe.configure({ mode: 'serial' })

test.describe('mail on the fake transport', () => {
  test.beforeAll(async ({ request }) => {
    await resetMail(request)
  })

  test.afterAll(async ({ request }) => {
    // Leave the shared test DB unconfigured for every other suite.
    await resetMail(request)
    await _sql?.end()
  })

  test('onboarding mail step: sender not verified (409), then the test mail and a sign-in code arrive in the mock', async ({
    page,
    context,
  }) => {
    const { email } = await registerUser(context, page, { emailDomain: 'test.eigen' })
    const promoted = await sql()`update "user" set role = 'admin' where email = ${email} returning id`
    expect(promoted).toHaveLength(1)

    const emailFrom = `hello-${Date.now()}@kindred.test`
    const setup = { region: 'eu-central-1', accessKeyId: 'AKIAFAKE', secretAccessKey: 'fake-secret', emailFrom }

    // First try: the fake SES has never seen the sender → created pending → 409.
    const pending = await page.request.post('/api/onboarding/mail', { data: setup })
    expect(pending.status()).toBe(409)
    expect(await pending.json()).toMatchObject({ needs: 'verify_sender', emailFrom })
    expect(await capturedFor(page, email)).toEqual([])

    // The owner "clicks Amazon's link".
    const verified = await page.request.post('/api/e2e/harness/mail', { data: { verify: emailFrom } })
    expect(verified.status()).toBe(200)

    const ok = await page.request.post('/api/onboarding/mail', { data: setup })
    expect(ok.status(), await ok.text()).toBe(200)
    expect(await ok.json()).toEqual({ ok: true, testSentTo: email })
    const [testMail] = await capturedFor(page, email)
    expect(testMail).toMatchObject({ from: emailFrom, to: email, subject: 'Email works — Eigen Enterprise' })

    // Sign-in code through the same transport: sign in with the code from the captured mail.
    await signOut(page)
    await page.locator('#email').fill(email)
    await page.getByRole('button', { name: 'Send code' }).click()
    await page.getByTestId('auth-code-step').waitFor({ state: 'visible', timeout: 15_000 })
    let code: string | null = null
    await expect
      .poll(
        async () => {
          const codeMail = (await capturedFor(page, email)).find((m) => m.subject.startsWith('Your Eigen Enterprise code:'))
          code = codeMail?.text.match(/sign-in code is (\d{6})/)?.[1] ?? null
          return codeMail ? { from: codeMail.from, code } : null
        },
        { timeout: 15_000, intervals: [250, 500, 1000] },
      )
      .toEqual({ from: emailFrom, code: expect.stringMatching(/^\d{6}$/) })
    await page.locator('#code').fill(code!)
    await page.getByRole('button', { name: 'Continue' }).click()
    await page.waitForURL(/\/(\?|#|$)/)
  })
})
