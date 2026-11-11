import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import postgres from 'postgres'
import { registerUser } from './test-helpers'

/**
 * The email platform on the fake transport (playwright.config sets
 * MAIL_TRANSPORT=fake): connect Amazon SES from the Email page → add a domain →
 * see its DNS records → verify (fake) → add a sender → send a test → see it in
 * Logs with its timeline; create a sending key → send with it over HTTP → in
 * Logs; a hard bounce suppresses the address and the next send is suppressed.
 */

const DATABASE_URL = process.env.DATABASE_URL?.trim()
test.skip(!DATABASE_URL, 'DATABASE_URL not set — the journey promotes its user in the dev DB')

let _sql: postgres.Sql | null = null
function sql(): postgres.Sql {
  _sql ??= postgres(DATABASE_URL!, { prepare: false })
  return _sql
}

type Captured = { from: string; to: string; subject: string; text: string; messageId: string }

async function resetMail(request: APIRequestContext): Promise<void> {
  const res = await request.delete('/api/e2e/harness/mail')
  expect(res.status(), await res.text()).toBe(200)
}

async function harness(page: Page, data: Record<string, unknown>) {
  const res = await page.request.post('/api/e2e/harness/mail', { data })
  expect(res.status(), await res.text()).toBe(200)
  return res.json()
}

async function captured(page: Page, to: string): Promise<Captured[]> {
  const res = await page.request.get(`/api/e2e/harness/mail?to=${encodeURIComponent(to)}`)
  expect(res.status(), await res.text()).toBe(200)
  return ((await res.json()) as { mails: Captured[] }).mails
}

test.describe.configure({ mode: 'serial' })

test.describe('email platform', () => {
  test.beforeAll(async ({ request }) => {
    await resetMail(request)
  })

  test.afterAll(async ({ request }) => {
    await resetMail(request)
    await _sql?.end()
  })

  test('connect SES → domain → DNS → verify → sender → test mail → logs; API key → send → logs; bounce → suppressed', async ({
    page,
    context,
    playwright,
  }) => {
    test.setTimeout(120_000)
    const { email } = await registerUser(context, page, { emailDomain: 'test.eigen' })
    expect(await sql()`update "user" set role = 'admin' where email = ${email} returning id`).toHaveLength(1)
    const stamp = Date.now().toString(36)
    const domain = `k${stamp}.test`
    const sender = `owner-${stamp}@kindred.test`

    // ── Overview: nothing connected, the first step is a form (never a dead "not set up").
    await page.goto('/m/email/setup')
    await expect(page.getByTestId('email-nav')).toBeVisible()
    await expect(page.getByTestId('email-step-connect')).toHaveAttribute('data-done', 'false')
    await page.locator('#ses-from').fill(sender)
    await page.locator('#ses-key-id').fill('AKIAFAKE')
    await page.locator('#ses-secret').fill('fake-secret')
    await page.getByTestId('ses-connect-submit').click()
    await expect(page.getByTestId('ses-verify-sender')).toContainText(sender)
    await harness(page, { verify: sender })
    await page.getByTestId('ses-connect-submit').click()
    await expect(page.getByTestId('email-step-connect')).toHaveAttribute('data-done', 'true')
    // Delivery events are wired (the fake SNS confirms at once).
    await expect(page.getByTestId('email-events')).toHaveAttribute('data-status', 'ready')

    // ── Domains: add → DNS records → verify (fake) → re-check.
    await page.getByTestId('email-step-add-domain').click()
    await expect(page).toHaveURL(/\/m\/email\/domains$/)
    await page.locator('#domain-name').fill(domain.toUpperCase())
    await page.getByRole('button', { name: 'Add domain' }).click()
    await expect(page).toHaveURL(/\/m\/email\/domains\/[0-9a-f-]+$/)
    await expect(page.getByTestId('domain-name')).toHaveText(domain)
    const records = page.getByTestId('dns-records')
    await expect(records.locator('tbody tr')).toHaveCount(4)
    await expect(page.getByTestId('dns-record-dkim').getByTestId('dns-value')).toContainText(/^p=MII/)
    await expect(page.getByTestId('dns-record-mail_from_mx')).toContainText('feedback-smtp.eu-central-1.amazonses.com')
    await expect(page.getByTestId('dns-record-spf')).toContainText('v=spf1 include:amazonses.com ~all')
    await expect(page.getByTestId('dns-record-dkim').getByTestId('dns-status')).toHaveText('Waiting for DNS')
    await harness(page, { verify: domain })
    await page.getByTestId('domain-recheck').click()
    await expect(page.getByTestId('dns-record-dkim').getByTestId('dns-status')).toHaveText('Verified')
    await expect(page.getByTestId('domain-summary')).toContainText('Verified')

    // ── Senders: a named address on the verified domain.
    await page.getByTestId('email-tab-senders').click()
    await page.locator('#sender-address').fill(`news@${domain}`)
    await page.locator('#sender-name').fill('Kindred News')
    await page.getByRole('button', { name: 'Add sender' }).click()
    await expect(page.getByTestId(`sender-row-news@${domain}`)).toContainText('Kindred News')
    await expect(page.getByTestId(`sender-row-${sender}`).getByTestId('sender-default')).toBeVisible()

    // ── Test mail from the new sender → Logs → timeline.
    await page.getByTestId('email-tab-overview').click()
    await page.locator('#test-from').selectOption(`news@${domain}`)
    await page.getByTestId('email-send-test').click()
    await expect(page.getByTestId('email-test-sent')).toContainText(email)
    const [testMail] = await captured(page, email).then((m) => m.filter((x) => x.subject === 'Test email from your company'))
    expect(testMail).toMatchObject({ from: `"Kindred News" <news@${domain}>`, to: email })
    await expect(page.getByTestId('email-step-test')).toHaveAttribute('data-done', 'true')

    await page.getByTestId('email-tab-logs').click()
    const row = page.getByTestId('log-row').filter({ hasText: 'Test email from your company' })
    await expect(row.getByTestId('message-status')).toHaveText('Sent')
    await row.getByRole('link').click()
    await expect(page.getByTestId('log-subject')).toHaveText('Test email from your company')
    await expect(page.getByTestId('log-event-queued')).toBeVisible()
    await expect(page.getByTestId('log-event-sent')).toBeVisible()

    // Amazon reports the delivery (the harness applies the SES event SNS would carry).
    const logId = page.url().split('/').pop()!
    expect(await harness(page, { sesEvent: { eventType: 'Delivery', mail: { messageId: testMail!.messageId, tags: { ee_message: [logId] } } } })).toEqual({
      applied: true,
    })
    await page.reload()
    await expect(page.getByTestId('log-event-delivered')).toBeVisible()
    await expect(page.getByTestId('log-subject').locator('..').getByTestId('message-status')).toHaveText('Delivered')

    // ── API: one button makes a sending key; the curl example holds this server's endpoint + the key.
    await page.getByTestId('email-tab-api').click()
    await page.getByTestId('create-sending-key').click()
    const key = (await page.getByTestId('sending-key-value').textContent())!.trim()
    expect(key).toMatch(/^eigen_[0-9a-f]+$/)
    const curl = page.getByTestId('api-curl')
    await expect(curl).toContainText('/api/mail/send')
    await expect(curl).toContainText(key)
    await expect(curl).toContainText(`"from": "${sender}"`)

    // The curl-equivalent request, from outside the browser session.
    const api = await playwright.request.newContext({ baseURL: page.url().replace(/\/m\/email.*$/, '') })
    const reader = `reader-${stamp}@example.test`
    const sent = await api.post('/api/mail/send', {
      headers: { Authorization: `Bearer ${key}` },
      data: { from: `news@${domain}`, to: reader, subject: 'Order shipped', text: 'On its way.', idempotencyKey: `o-${stamp}` },
    })
    expect(sent.status(), await sent.text()).toBe(200)
    const sentBody = (await sent.json()) as { id: string; status: string }
    expect(sentBody.status).toBe('sent')

    await page.getByTestId('email-tab-logs').click()
    await expect(page.getByTestId('log-row').filter({ hasText: 'Order shipped' })).toContainText('API')

    // ── A permanent bounce suppresses the reader; the next API send is suppressed, not sent.
    const [orderMail] = await captured(page, reader)
    await harness(page, {
      sesEvent: {
        eventType: 'Bounce',
        mail: { messageId: orderMail!.messageId, tags: { ee_message: [sentBody.id] } },
        bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: reader, diagnosticCode: '550 user unknown' }] },
      },
    })
    await page.getByTestId('email-tab-suppression').click()
    await expect(page.getByTestId(`suppressed-${reader}`)).toContainText('Bounced')
    const again = await api.post('/api/mail/send', {
      headers: { Authorization: `Bearer ${key}` },
      data: { to: reader, subject: 'Again', text: 'Hi' },
    })
    expect(((await again.json()) as { status: string }).status).toBe('suppressed')
    expect(await captured(page, reader)).toHaveLength(1)
    await api.dispose()
  })

  // Runs after the journey above: SES stays connected (serial suite, one reset at the end).
  test('layouts + templates: brand layout → template with variables → live preview → test mail → send by templateId', async ({
    page,
    context,
    playwright,
  }) => {
    test.setTimeout(120_000)
    const { email } = await registerUser(context, page, { emailDomain: 'test.eigen' })
    expect(await sql()`update "user" set role = 'admin' where email = ${email} returning id`).toHaveLength(1)
    const stamp = Date.now().toString(36)

    // A layout starts from the Brand starter and previews around a stand-in block.
    await page.goto('/m/email/layouts')
    await expect(page.getByTestId('brand-tokens')).toBeVisible()
    await page.locator('#layout-name').fill(`Brand ${stamp}`)
    await page.getByRole('button', { name: 'Create layout' }).click()
    await expect(page).toHaveURL(/\/m\/email\/layouts\/[0-9a-f-]+$/)
    await expect(page.getByTestId('layout-body')).toHaveValue(/\{\{ content \}\}/)
    await expect(page.getByTestId('layout-preview')).toHaveAttribute('srcdoc', /content goes here/)

    // A template inside it: variables detected, preview renders the sample values.
    await page.getByTestId('email-tab-templates').click()
    await page.locator('#template-name').fill(`Welcome ${stamp}`)
    await page.locator('#template-layout').selectOption({ label: `Brand ${stamp}` })
    await page.getByRole('button', { name: 'Create template' }).click()
    await expect(page).toHaveURL(/\/m\/email\/templates\/[0-9a-f-]+$/)
    const templateId = page.url().split('/').pop()!
    await expect(page.getByTestId('tpl-preview-subject')).toContainText('Welcome, Ada!')
    await expect(page.getByTestId('tpl-var-link')).toHaveValue('https://example.com')
    await page.getByTestId('tpl-subject').fill('Hello {{ firstName }} from {{ brand.companyName | "us" }}')
    await expect(page.getByTestId('tpl-preview-subject')).toContainText('Hello Ada from')
    await page.getByTestId('tpl-save').click()
    await expect(page.getByTestId('tpl-saved')).toBeVisible()

    await page.getByTestId('tpl-test').click()
    await expect(page.getByTestId('tpl-test-sent')).toContainText(email)
    const testMail = (await captured(page, email)).find((m) => m.subject.startsWith('Hello Ada'))
    expect(testMail).toBeTruthy()

    // Send by templateId with a sending key; a missing variable is a 422 naming it.
    const keyRes = await page.request.post('/api/keys', { data: { name: `tpl-${stamp}`, mailSend: true, mcp: false } })
    expect(keyRes.status()).toBe(201)
    const { key } = (await keyRes.json()) as { key: string }
    const api = await playwright.request.newContext({ baseURL: page.url().replace(/\/m\/email.*$/, '') })
    const to = `tpl-${stamp}@example.test`
    const ok = await api.post('/api/mail/send', {
      headers: { Authorization: `Bearer ${key}` },
      data: { to, templateId, variables: { firstName: 'Grace', link: 'https://k.test/go' } },
    })
    expect(ok.status(), await ok.text()).toBe(200)
    const [mail] = await captured(page, to)
    expect(mail!.subject).toMatch(/^Hello Grace from /)
    expect(mail!.text).toContain('https://k.test/go')
    const missing = await api.post('/api/mail/send', {
      headers: { Authorization: `Bearer ${key}` },
      data: { to, templateId, variables: { firstName: 'Grace' } },
    })
    expect(missing.status()).toBe(422)
    expect(await missing.json()).toMatchObject({ error: 'template_invalid', missing: ['link'] })
    await api.dispose()
  })

  test('contacts + flows: double opt-in list → flow (send, wait) → confirm → tick → mail with one-click unsubscribe → unsubscribed', async ({
    page,
    context,
    playwright,
  }) => {
    test.setTimeout(120_000)
    const { email } = await registerUser(context, page, { emailDomain: 'test.eigen' })
    expect(await sql()`update "user" set role = 'admin' where email = ${email} returning id`).toHaveLength(1)
    const stamp = Date.now().toString(36)
    const reader = `sub-${stamp}@example.test`

    // A template for the flow (the standalone starter needs no variables).
    await page.goto('/m/email/templates')
    await page.locator('#template-name').fill(`Flow mail ${stamp}`)
    await page.locator('#template-layout').selectOption('')
    await page.getByRole('button', { name: 'Create template' }).click()
    await expect(page).toHaveURL(/\/m\/email\/templates\/[0-9a-f-]+$/)

    // A double-opt-in list.
    await page.getByTestId('email-tab-contacts').click()
    await page.locator('#list-name').fill(`News ${stamp}`)
    await page.getByTestId('list-doi').check()
    await page.getByRole('button', { name: 'Create list' }).click()
    await expect(page.getByTestId('list-name')).toHaveText(`News ${stamp}`)
    const listUrl = page.url()

    // A flow on it: send the template, then wait two days.
    await page.getByTestId('email-tab-flows').click()
    await page.locator('#flow-name').fill(`Welcome ${stamp}`)
    await page.locator('#flow-list').selectOption({ label: `News ${stamp}` })
    await page.getByRole('button', { name: 'Create flow' }).click()
    await expect(page).toHaveURL(/\/m\/email\/flows\/[0-9a-f-]+$/)
    const flowUrl = page.url()
    await page.getByTestId('flow-add-send').click()
    await page.getByTestId('flow-step-1').getByLabel('Template').selectOption({ label: `Flow mail ${stamp}` })
    await page.getByTestId('flow-add-wait').click()
    await page.getByTestId('flow-save').click()
    await expect(page.getByTestId('flow-saved')).toBeVisible()
    await page.getByTestId('flow-activate').click()
    await expect(page.getByTestId('flow-status')).toHaveText('Running')

    // A new contact must confirm first.
    await page.goto(listUrl)
    await page.locator('#contact-email').fill(reader)
    await page.locator('#contact-first').fill('Ada')
    await page.getByRole('button', { name: 'Add', exact: true }).click()
    await expect(page.getByTestId('contact-added')).toContainText('confirmation mail')
    const [confirmMail] = await captured(page, reader)
    const confirmLink = confirmMail!.text.match(/https?:\/\/\S+\/mail\/confirm\/\S+/)![0]
    await page.goto(confirmLink)
    await page.getByTestId('confirm-subscription').click()
    await expect(page.getByTestId('confirmed')).toContainText(reader)

    // The background pass runs the flow: the mail goes out with one-click unsubscribe headers.
    await harness(page, { tick: true })
    const flowMail = (await captured(page, reader)).find((m) => m.subject === 'Welcome, Ada!')
    expect(flowMail).toBeTruthy()
    const headers = (flowMail as unknown as { headers: { name: string; value: string }[] }).headers
    const oneClick = headers.find((h) => h.name === 'List-Unsubscribe')!.value.slice(1, -1)
    expect(headers).toContainEqual({ name: 'List-Unsubscribe-Post', value: 'List-Unsubscribe=One-Click' })
    await page.goto(flowUrl)
    await expect(page.getByTestId('flow-enrollments').getByTestId('enrollment-state')).toContainText('Waiting until')
    await expect(page.getByTestId('flow-log-email_sent')).toBeVisible()

    // The mailbox provider's one-click POST (no Origin, urlencoded) unsubscribes.
    const provider = await playwright.request.newContext()
    const res = await provider.post(oneClick, { form: { 'List-Unsubscribe': 'One-Click' } })
    expect(res.status(), await res.text()).toBe(200)
    await provider.dispose()
    await page.goto(listUrl)
    await expect(page.getByTestId(`contact-${reader}`).getByTestId('contact-status')).toContainText('Unsubscribed')
    await page.goto(oneClick.replace('/api/mail/unsubscribe/', '/mail/unsubscribe/'))
    await expect(page.getByTestId('unsubscribed')).toContainText(reader)
  })
})
