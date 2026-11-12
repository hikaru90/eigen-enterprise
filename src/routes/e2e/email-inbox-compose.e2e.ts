import { expect, test, type Page } from '@playwright/test'
import { simpleParser } from 'mailparser'
import postgres from 'postgres'
import { registerUser, waitForHydration } from './test-helpers'

/**
 * Email › Inbox, sending (plan/email-inbox.md S5) on the fake transport
 * (playwright.config sets MAIL_TRANSPORT=fake). A member who is also an admin:
 * replies to a seeded mail → the reply is in Sent and in the thread → the fake
 * transport got one raw mail From the mailbox with In-Reply-To + References →
 * the company Mail and Logs views don't list it (no mail_messages row); new
 * mail to two recipients; forward with the original's attachment; a disabled
 * mailbox can't send.
 */

const DATABASE_URL = process.env.DATABASE_URL?.trim()
test.skip(!DATABASE_URL, 'DATABASE_URL not set — the journey promotes its user and checks the sent log in the dev DB')

let _sql: postgres.Sql | null = null
function sql(): postgres.Sql {
  _sql ??= postgres(DATABASE_URL!, { prepare: false })
  return _sql
}

type Seeded = { mailboxId: string; address: string; messages: Array<{ id: string; subject: string; messageId: string }> }
type Captured = { from: string; to: string; subject: string; raw?: string; recipients?: string[] }

async function seed(page: Page, data: Record<string, unknown>): Promise<Seeded> {
  const res = await page.request.post('/api/e2e/harness/inbox', { data })
  expect(res.status(), await res.text()).toBe(200)
  return (await res.json()) as Seeded
}

async function captured(page: Page, to: string): Promise<Captured[]> {
  const res = await page.request.get(`/api/e2e/harness/mail?to=${encodeURIComponent(to)}`)
  expect(res.status(), await res.text()).toBe(200)
  return ((await res.json()) as { mails: Captured[] }).mails
}

const PDF = Buffer.from('%PDF-1.4\n% ee compose e2e\n%%EOF\n')

test.afterAll(async () => {
  await _sql?.end()
})

test('reply threads and stays out of the company log; new mail to two; forward with attachment; disabled can’t send', async ({ page, context }) => {
  test.setTimeout(150_000)
  const stamp = Date.now().toString(36)
  const { email } = await registerUser(context, page)
  expect(await sql()`update "user" set role = 'admin' where email = ${email} returning id`).toHaveLength(1)
  const mara = `mara-${stamp}@sender.example`
  const seeded = await seed(page, {
    email,
    connectMail: true,
    messages: [
      { subject: `Numbers ${stamp}`, from: { name: 'Mara Voss', address: mara }, text: 'Hi, here are the numbers for Q3.' },
      {
        subject: `Contract ${stamp}`,
        from: { name: 'Mara Voss', address: mara },
        text: 'The contract is attached.',
        attachments: [{ filename: 'contract.pdf', contentType: 'application/pdf', contentBase64: PDF.toString('base64') }],
      },
    ],
  })
  const [numbers, contract] = seeded.messages as [Seeded['messages'][number], Seeded['messages'][number]]

  // ── Reply: prefilled, sent, the copy in Sent and in the thread.
  await page.goto(`/m/email/inbox?m=${numbers.id}`)
  await waitForHydration(page)
  await page.getByTestId('inbox-reply').click()
  await expect(page.getByTestId('compose')).toHaveAttribute('data-mode', 'reply')
  await expect(page.getByTestId('compose-to')).toHaveValue(`Mara Voss <${mara}>`)
  await expect(page.getByTestId('compose-subject')).toHaveValue(`Re: Numbers ${stamp}`)
  await expect(page.getByTestId('compose-from')).toContainText(seeded.address)
  await expect(page.getByTestId('compose-body')).toBeFocused()
  await expect(page.getByTestId('compose-body')).toHaveValue(/> Hi, here are the numbers for Q3\./)
  await page.keyboard.type('Thanks, Mara!')
  await page.getByTestId('compose-send').click()
  await expect(page.getByTestId('inbox-sent-confirmation')).toHaveText('Sent. Your copy is in Sent.')
  await expect(page).toHaveURL(/[?&]folder=sent/)
  const sentId = new URL(page.url()).searchParams.get('m')!
  await expect(page.getByTestId(`inbox-thread-${numbers.id}`)).toBeVisible()
  await expect(page.getByTestId(`inbox-thread-${sentId}`)).toContainText('Thanks, Mara!')
  await expect(page.getByTestId(`inbox-item-${sentId}`)).toContainText(`Re: Numbers ${stamp}`)

  // ── The fake transport got exactly one raw mail, From the mailbox, threaded.
  const [replyMail, ...moreToMara] = await captured(page, mara)
  expect(moreToMara).toEqual([])
  expect(replyMail!.raw, 'a raw send').toBeTruthy()
  const reply = await simpleParser(replyMail!.raw!)
  expect(reply.from?.value[0]?.address).toBe(seeded.address)
  expect(reply.inReplyTo).toBe(`<${numbers.messageId}>`)
  expect(reply.references).toEqual(expect.arrayContaining([`<${numbers.messageId}>`]))
  expect(reply.text).toContain('Thanks, Mara!')

  // ── Not in the company log: no mail_messages row, not on Company mail, not in Logs.
  expect(await sql()`select id from mail_messages where subject like ${`%Numbers ${stamp}%`}`).toHaveLength(0)
  await page.goto('/m/email/company')
  await expect(page.getByTestId('email-sent-header').or(page.getByTestId('email-not-connected'))).toBeVisible()
  await expect(page.getByText(`Re: Numbers ${stamp}`)).toHaveCount(0)
  await page.goto('/m/email/logs')
  await expect(page.getByTestId('logs-filter')).toBeVisible()
  await expect(page.getByTestId('log-row').filter({ hasText: `Numbers ${stamp}` })).toHaveCount(0)
  await expect(page.getByText(mara)).toHaveCount(0)

  // ── New mail to two recipients.
  await page.goto('/m/email/inbox')
  await waitForHydration(page)
  await page.getByTestId('inbox-new-mail').click()
  await expect(page.getByTestId('compose')).toHaveAttribute('data-mode', 'new')
  await expect(page.getByTestId('compose-to')).toBeFocused()
  const one = `one-${stamp}@x.example`
  const two = `two-${stamp}@x.example`
  await page.getByTestId('compose-to').fill(`${one}, Two <${two}>`)
  await page.getByTestId('compose-subject').fill(`Hello both ${stamp}`)
  await page.getByTestId('compose-body').fill('One mail, two people.')
  await page.getByTestId('compose-send').click()
  await expect(page.getByTestId('inbox-sent-confirmation')).toBeVisible()
  const [both] = await captured(page, two)
  expect(both!.recipients).toEqual([one, two])
  expect(both!.subject).toBe(`Hello both ${stamp}`)

  // ── Forward with the original's attachment.
  await page.goto(`/m/email/inbox?m=${contract.id}`)
  await waitForHydration(page)
  await page.getByTestId('inbox-forward').click()
  await expect(page.getByTestId('compose-subject')).toHaveValue(`Fwd: Contract ${stamp}`)
  await expect(page.getByTestId('compose-forwarded')).toContainText('contract.pdf')
  const lawyer = `lawyer-${stamp}@x.example`
  await page.getByTestId('compose-to').fill(lawyer)
  await page.getByTestId('compose-send').click()
  await expect(page.getByTestId('inbox-sent-confirmation')).toBeVisible()
  const [fwdMail] = await captured(page, lawyer)
  const fwd = await simpleParser(fwdMail!.raw!)
  expect(fwd.attachments.map((a) => a.filename)).toEqual(['contract.pdf'])
  expect(Buffer.from(fwd.attachments[0]!.content).equals(PDF)).toBe(true)
  expect(fwd.text).toContain('---------- Forwarded message ---------')

  // ── A disabled mailbox can't send: the form says why, and a direct POST is refused.
  await seed(page, { email, messages: [], disabled: true })
  await page.goto(`/m/email/inbox?box=${seeded.mailboxId}&compose=new`)
  await waitForHydration(page)
  await expect(page.getByTestId('compose-blocked')).toHaveText(`${seeded.address} is disabled, so no mail can be sent from it.`)
  await expect(page.getByTestId('compose-send')).toBeDisabled()
  const attempt = await page.request.post('/m/email/inbox?/send', {
    multipart: { mailboxId: seeded.mailboxId, mode: 'new', parentId: '', to: `nobody-${stamp}@x.example`, cc: '', bcc: '', subject: 'x', body: 'x' },
    headers: { 'x-sveltekit-action': 'true', origin: new URL(page.url()).origin },
  })
  expect(await attempt.text()).toContain('is disabled, so no mail can be sent from it.')
  expect(await captured(page, `nobody-${stamp}@x.example`)).toEqual([])
})
