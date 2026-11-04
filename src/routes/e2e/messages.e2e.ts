import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import postgres from 'postgres'
import { completeProfileViaApi, profileNames, registerUser } from './test-helpers'

/**
 * Phase-workspace C1 proof: two members in two browsers. The owner (admin)
 * creates #general → member B sees it and posts → the owner sees it live
 * without a reload and its unread badge clears on open → the owner opens a
 * DM with B → B gets it live. A private #leadership never reaches B.
 * Screenshots go to MESSAGES_SHOTS (default test-results/messages).
 */

const DATABASE_URL = process.env.DATABASE_URL?.trim()
test.skip(!DATABASE_URL, 'DATABASE_URL not set — the test sets roles in the test DB')

const SHOTS = process.env.MESSAGES_SHOTS ?? 'test-results/messages'
const GATEWAY_BASE_URL = `http://127.0.0.1:${process.env.MOCK_GATEWAY_PORT ?? 5199}/v1`

let _sql: postgres.Sql | null = null
const sql = () => (_sql ??= postgres(DATABASE_URL!, { prepare: false }))
test.afterAll(async () => {
  await _sql?.end()
})

/** A signed-in company member (production account so they are in the people pickers). */
async function newMember(context: BrowserContext, page: Page, role: 'admin' | 'member', name: string) {
  const { email } = await registerUser(context, page, { emailDomain: 'test.eigen' })
  const rows = await sql()`
    update "user" set role = ${role}, name = ${name}, account_kind = 'production', onboarding_completed = true
    where email = ${email} returning id`
  if (rows.length !== 1) throw new Error(`could not set up ${email}`)
  // P-5: a production member has a complete profile (names + picture) before any shell page.
  await completeProfileViaApi(page, profileNames(name))
  const saved = await page.request.post('/api/onboarding/provider', {
    data: {
      provider: 'openrouter',
      baseUrl: GATEWAY_BASE_URL,
      apiKey: `e2e-key-${Date.now()}`,
      modelChat: 'mock-chat-model',
      modelEmbedding: 'mock-embed-model',
    },
  })
  expect(saved.status()).toBe(200)
  return { email, id: rows[0].id as string }
}

const conv = (page: Page, title: string) =>
  page.getByTestId('messages-list').locator(`[data-testid="messages-conversation"][data-title="${title}"]`)

test('two members chat live: channel, unread, DM, private channel stays private', async ({ browser }) => {
  test.setTimeout(180_000)
  const suffix = Date.now().toString(36)
  const general = `general-${suffix}`
  const leadership = `leadership-${suffix}`

  const ctxA = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const a = await ctxA.newPage()
  const owner = await newMember(ctxA, a, 'admin', `Olga ${suffix}`)
  const ctxB = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const b = await ctxB.newPage()
  const bea = await newMember(ctxB, b, 'member', `Bea ${suffix}`)

  // Nav: Messages first, the agent chat is "Assistant".
  await a.goto('/messages')
  await expect(a).toHaveTitle(/^Messages · eigenEnterprise$/)
  await expect(a.getByTestId('shell-nav-messages')).toHaveAttribute('aria-current', 'page')
  await expect(a.getByTestId('shell-nav-chat')).toHaveText(/Assistant/)
  await expect(a.getByTestId('messages-live')).toHaveAttribute('data-state', 'live')

  // Owner creates a public #general and a private #leadership.
  await a.getByTestId('messages-new-channel').click()
  await a.locator('#channel-name').fill(general)
  await a.locator('#channel-topic').fill('Everything, everyone')
  await a.getByTestId('channel-create').click()
  await expect(a.getByTestId('messages-title')).toContainText(general)
  await a.getByTestId('messages-new-channel').click()
  await a.locator('#channel-name').fill(leadership)
  await a.getByTestId('channel-private').check()
  await a.getByTestId('channel-create').click()
  await expect(a.getByTestId('messages-title')).toContainText(leadership)
  await a.getByTestId('messages-composer').fill('Board meeting notes')
  await a.getByTestId('messages-composer').press('Enter')
  await expect(a.getByTestId('messages-body').filter({ hasText: 'Board meeting notes' })).toBeVisible()
  await a.screenshot({ path: `${SHOTS}/01-owner-channels.png` })

  // B sees #general (not #leadership) and posts; the API refuses the private one too.
  await b.goto('/messages')
  await expect(b.getByTestId('messages-live')).toHaveAttribute('data-state', 'live')
  await expect(conv(b, general)).toBeVisible()
  await expect(conv(b, leadership)).toHaveCount(0)
  const leadId = (await sql()`select id from message_conversations where name = ${leadership}`)[0].id as string
  expect((await b.request.get(`/api/messages/conversations/${leadId}/messages`)).status()).toBe(404)
  expect(
    (await b.request.post(`/api/messages/conversations/${leadId}/messages`, { data: { body: 'let me in' } })).status(),
  ).toBe(404)

  // Owner switches to #leadership so #general's new message counts as unread.
  await conv(a, leadership).click()
  await expect(a.getByTestId('messages-title')).toContainText(leadership)

  await conv(b, general).click()
  await b.getByTestId('messages-composer').fill('Hi **team**\nsecond line')
  await b.getByTestId('messages-composer').press('Shift+Enter') // newline, not send
  await b.getByTestId('messages-composer').press('Enter')
  await expect(b.getByTestId('messages-body').filter({ hasText: 'Hi team' })).toBeVisible()
  await expect(b.getByTestId('messages-body').locator('strong')).toHaveText('team')
  await b.screenshot({ path: `${SHOTS}/02-member-posted.png` })

  // Owner sees it live: unread badge on #general, no reload.
  await expect(conv(a, general).getByTestId('messages-unread')).toHaveText('1')
  await a.screenshot({ path: `${SHOTS}/03-owner-unread-live.png` })
  await conv(a, general).click()
  await expect(a.getByTestId('messages-body').filter({ hasText: 'Hi team' })).toBeVisible()
  await expect(conv(a, general).getByTestId('messages-unread')).toHaveCount(0)
  // And live while open: B posts again, A sees it in the log.
  await b.getByTestId('messages-composer').fill('Live while open')
  await b.getByTestId('messages-composer').press('Enter')
  await expect(a.getByTestId('messages-body').filter({ hasText: 'Live while open' })).toBeVisible()
  await expect(conv(a, general).getByTestId('messages-unread')).toHaveCount(0)
  await a.screenshot({ path: `${SHOTS}/04-owner-open-live.png` })

  // Owner opens a DM with B; B gets it live.
  await a.getByTestId('messages-new-dm').click()
  await a.locator(`[data-testid="dm-person"][data-email="${bea.email}"]`).check()
  await a.getByTestId('dm-start').click()
  await expect(a.getByTestId('messages-title')).toContainText(`Bea ${suffix}`)
  await a.getByTestId('messages-composer').fill('Quick question, just for you')
  await a.getByTestId('messages-composer').press('Enter')
  await expect(conv(b, `Olga ${suffix}`)).toBeVisible()
  await expect(conv(b, `Olga ${suffix}`).getByTestId('messages-unread')).toHaveText('1')
  await b.screenshot({ path: `${SHOTS}/05-member-dm-live.png` })
  await conv(b, `Olga ${suffix}`).click()
  await expect(b.getByTestId('messages-body').filter({ hasText: 'Quick question' })).toBeVisible()
  await b.screenshot({ path: `${SHOTS}/06-member-dm-open.png` })

  // Reload keeps history and stays private.
  // Reload (the push deep link /messages?c=…) reopens the DM with its history; still private.
  await b.reload()
  await expect(b.getByTestId('messages-title')).toContainText(`Olga ${suffix}`)
  await expect(b.getByTestId('messages-body').filter({ hasText: 'Quick question' })).toBeVisible()
  await expect(conv(b, leadership)).toHaveCount(0)
  expect(owner.id).toBeTruthy()

  // Phone: list first, then the conversation with a back button.
  await b.setViewportSize({ width: 390, height: 844 })
  await b.goto('/messages')
  await expect(b.getByTestId('messages-list')).toBeVisible()
  await b.screenshot({ path: `${SHOTS}/07-phone-list.png` })
  await conv(b, general).click()
  await expect(b.getByTestId('messages-list')).toBeHidden()
  await expect(b.getByTestId('messages-back')).toBeVisible()
  await b.screenshot({ path: `${SHOTS}/08-phone-conversation.png` })
  await b.getByTestId('messages-back').click()
  await expect(b.getByTestId('messages-list')).toBeVisible()

  await ctxA.close()
  await ctxB.close()
})
