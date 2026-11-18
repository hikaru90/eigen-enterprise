import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import postgres from 'postgres'
import { completeProfileViaApi, profileNames, registerUser } from './test-helpers'

/**
 * Quoted replies (Contribute 2a58bcc8, WhatsApp-style "Reply"), two members in
 * two browsers: B replies to A's message from the hover toolbar — the
 * composer shows the quote, the sent reply carries it, live for A; A jumps
 * from the quote to the original (highlighted) and replies from the context
 * menu; once A deletes the original, B's quote reads "Original message
 * deleted" live. Screenshots go to MESSAGES_REPLY_SHOTS.
 */

const DATABASE_URL = process.env.DATABASE_URL?.trim()
test.skip(!DATABASE_URL, 'DATABASE_URL not set — the test sets roles in the test DB')

const SHOTS = process.env.MESSAGES_REPLY_SHOTS ?? 'test-results/messages-reply'
const GATEWAY_BASE_URL = `http://127.0.0.1:${process.env.MOCK_GATEWAY_PORT ?? 5199}/v1`

let _sql: postgres.Sql | null = null
const sql = () => (_sql ??= postgres(DATABASE_URL!, { prepare: false }))
test.afterAll(async () => {
  await _sql?.end()
})

async function newMember(context: BrowserContext, page: Page, name: string) {
  const { email } = await registerUser(context, page, { emailDomain: 'test.eigen' })
  const rows = await sql()`
    update "user" set role = 'member', name = ${name}, account_kind = 'production', onboarding_completed = true
    where email = ${email} returning id`
  if (rows.length !== 1) throw new Error(`could not set up ${email}`)
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
}

const conv = (page: Page, title: string) =>
  page.getByTestId('messages-list').locator(`[data-testid="messages-conversation"][data-title="${title}"]`)
const item = (page: Page, text: string) => page.getByTestId('messages-item').filter({ has: page.getByTestId('messages-body').filter({ hasText: text }) })

async function post(page: Page, text: string) {
  await page.getByTestId('messages-composer').fill(text)
  await page.getByTestId('messages-composer').press('Enter')
  await expect(item(page, text)).toBeVisible()
}

test('reply to a specific message: quote in the composer, on the reply, live, jump, deleted original', async ({ browser }) => {
  test.setTimeout(180_000)
  const suffix = Date.now().toString(36)
  const channel = `reply-${suffix}`

  const ctxA = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const a = await ctxA.newPage()
  await newMember(ctxA, a, `Ada ${suffix}`)
  const ctxB = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const b = await ctxB.newPage()
  await newMember(ctxB, b, `Ben ${suffix}`)

  await a.goto('/messages')
  await expect(a.getByTestId('messages-live')).toHaveAttribute('data-state', 'live')
  await a.getByTestId('messages-new-channel').click()
  await a.locator('#channel-name').fill(channel)
  await a.getByTestId('channel-create').click()
  await expect(a.getByTestId('messages-title')).toContainText(channel)
  await post(a, 'Lunch at noon?')
  await post(a, 'Also: the deck is due Friday')

  await b.goto('/messages')
  await expect(b.getByTestId('messages-live')).toHaveAttribute('data-state', 'live')
  await conv(b, channel).click()
  await expect(item(b, 'Lunch at noon?')).toBeVisible()

  // ── 1. B: hover → Reply → the composer quotes the message; sending carries the quote.
  await item(b, 'Lunch at noon?').hover()
  await item(b, 'Lunch at noon?').getByTestId('messages-quote').click()
  await expect(b.getByTestId('reply-preview')).toContainText(`Replying to Ada ${suffix}`)
  await expect(b.getByTestId('reply-preview')).toContainText('Lunch at noon?')
  await expect(b.getByTestId('messages-composer')).toBeFocused()
  await b.screenshot({ path: `${SHOTS}/01-composer-quote.png` })
  await post(b, 'Noon works for me')
  await expect(b.getByTestId('reply-preview')).toHaveCount(0)
  await expect(item(b, 'Noon works for me').getByTestId('reply-quote')).toContainText('Lunch at noon?')

  // ── 2. A sees the reply live with its quote; clicking the quote highlights the original.
  const replyOnA = item(a, 'Noon works for me')
  await expect(replyOnA.getByTestId('reply-quote')).toContainText(`Ada ${suffix}`)
  await replyOnA.getByTestId('reply-quote').click()
  await expect(item(a, 'Lunch at noon?')).toHaveAttribute('data-highlighted', 'true')
  await a.screenshot({ path: `${SHOTS}/02-jump-to-original.png` })

  // ── 3. A: right-click → Reply (the context menu), Esc cancels, then reply for real.
  await item(a, 'Also: the deck').getByTestId('messages-body').click({ button: 'right' })
  await expect(a.getByTestId('messages-context-menu')).toBeVisible()
  await a.getByTestId('messages-menu-quote').click()
  await expect(a.getByTestId('reply-preview')).toContainText('Also: the deck is due Friday')
  await a.keyboard.press('Escape')
  await expect(a.getByTestId('reply-preview')).toHaveCount(0)

  // ── 4. A deletes the original → B's quote reads "Original message deleted", live.
  await item(a, 'Lunch at noon?').hover()
  await item(a, 'Lunch at noon?').getByTestId('messages-delete').click()
  await a.getByTestId('messages-delete-confirm').click()
  await expect(item(b, 'Noon works for me').getByTestId('reply-quote-deleted')).toHaveText('Original message deleted')
  await b.screenshot({ path: `${SHOTS}/03-original-deleted.png` })

  await ctxA.close()
  await ctxB.close()
})
