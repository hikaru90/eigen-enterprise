import { expect, test, type Page } from '@playwright/test'
import { registerUser, waitForHydration } from './test-helpers'

/**
 * Email › Inbox (plan/email-inbox.md S4) against the throwaway harness. Mail is
 * seeded through the dev-only inbox harness (straight into the inbox store, no
 * SES/SNS/S3): a member opens their Inbox → reads a mail (it becomes read) →
 * Spam → finds it under Spam → Not spam → back in the Inbox; an HTML mail
 * keeps remote images blocked until "Show images"; new mail arrives live; a
 * second member gets "not found" for the first member's mail.
 */

type Seeded = { mailboxId: string; address: string; messages: Array<{ id: string; subject: string }> }

async function seed(page: Page, email: string, messages: unknown[]): Promise<Seeded> {
  const res = await page.request.post('/api/e2e/harness/inbox', { data: { email, messages } })
  expect(res.status(), await res.text()).toBe(200)
  return (await res.json()) as Seeded
}

const REMOTE_IMAGE = 'https://images.inbox-e2e.invalid/pixel.png'

test.describe('email inbox', () => {
  test('read → spam → not spam; remote images blocked until asked; live mail; nobody else reads it', async ({ page, context, browser }) => {
    test.setTimeout(120_000)
    const stamp = Date.now().toString(36)
    const { email } = await registerUser(context, page)
    const plainSubject = `Quarterly numbers ${stamp}`
    const htmlSubject = `Newsletter ${stamp}`
    const seeded = await seed(page, email, [
      { subject: plainSubject, from: { name: 'Mara Voss', address: 'mara@sender.example' }, text: 'Hi, here are the numbers for Q3.' },
      {
        subject: htmlSubject,
        from: { name: 'News Desk', address: 'news@sender.example' },
        text: 'Welcome to the November issue.',
        html: `<h1>November issue</h1><p onclick="alert(1)">Welcome.</p><img src="${REMOTE_IMAGE}" alt="pixel"><script>alert(2)</script>`,
      },
    ])
    const [plain, html] = seeded.messages as [Seeded['messages'][number], Seeded['messages'][number]]

    const remoteRequests: string[] = []
    page.on('request', (r) => {
      if (r.url().startsWith('https://images.inbox-e2e.invalid/')) remoteRequests.push(r.url())
    })

    // ── Inbox first: both mails, unread.
    await page.goto('/m/email/inbox')
    await waitForHydration(page)
    await expect(page.getByTestId('email-tab-inbox')).toHaveAttribute('aria-current', 'page')
    await expect(page.getByTestId('inbox-address')).toHaveText(seeded.address)
    await expect(page.getByTestId('inbox')).toHaveAttribute('data-live', 'live')
    const plainItem = page.getByTestId(`inbox-item-${plain.id}`)
    await expect(plainItem).toContainText(plainSubject)
    await expect(plainItem).toHaveAttribute('data-unread', 'true')
    await expect(page.getByTestId(`inbox-item-${html.id}`)).toContainText(htmlSubject)
    await expect(page.getByTestId('inbox-folder-inbox-unread')).toHaveText('2 unread')

    // ── Open it: the reader shows it, focus moves to it, it is read now.
    await plainItem.click()
    await expect(page).toHaveURL(new RegExp(`[?&]m=${plain.id}`))
    const heading = page.getByRole('heading', { name: plainSubject })
    await expect(heading).toBeFocused()
    await expect(page.getByTestId('inbox-text-body')).toContainText('here are the numbers for Q3.')
    await expect(plainItem).toHaveAttribute('data-unread', 'false')
    await expect(page.getByTestId('inbox-folder-inbox-unread')).toHaveText('1 unread')

    // ── Spam: gone from the Inbox, found under Spam.
    await page.getByTestId('inbox-move-spam').click()
    await expect(page.getByTestId('inbox-reader')).toHaveCount(0)
    await expect(plainItem).toHaveCount(0)
    await page.getByTestId('inbox-folder-spam').click()
    await expect(page).toHaveURL(/[?&]folder=spam/)
    await expect(plainItem).toContainText(plainSubject)

    // ── Not spam: back in the Inbox.
    await plainItem.click()
    await page.getByTestId('inbox-move-inbox').click()
    await expect(page.getByTestId('inbox-list-empty')).toHaveText('Nothing in Spam.')
    await page.getByTestId('inbox-folder-inbox').click()
    await expect(plainItem).toContainText(plainSubject)

    // ── HTML mail: sandboxed, sanitized, remote images blocked until "Show images".
    await page.getByTestId(`inbox-item-${html.id}`).click()
    const frame = page.getByTestId('inbox-html-body')
    await expect(frame).toHaveAttribute('sandbox', 'allow-popups allow-popups-to-escape-sandbox')
    const srcdoc = (await frame.getAttribute('srcdoc')) ?? ''
    expect(srcdoc).toContain('<h1>November issue</h1>')
    expect(srcdoc).not.toContain('<script')
    expect(srcdoc).not.toContain('onclick')
    expect(srcdoc).toMatch(/img-src data: http:\/\/localhost:\d+\/m\/email\/inbox\/attachments\/"/)
    await expect(page.frameLocator('[data-testid="inbox-html-body"]').getByRole('heading', { name: 'November issue' })).toBeVisible()
    await expect(page.getByTestId('inbox-images-blocked')).toBeVisible()
    expect(remoteRequests).toEqual([])
    await page.getByTestId('inbox-show-images').click()
    await expect(page).toHaveURL(/[?&]images=1/)
    await expect(page.getByTestId('inbox-images-blocked')).toHaveCount(0)
    await expect(page.getByTestId('inbox-html-body')).toHaveAttribute('srcdoc', /img-src data: \S+ https:"/)

    // ── New mail arrives while the page is open (live stream → reload of the list).
    const late = await seed(page, email, [{ subject: `Late news ${stamp}`, from: { name: null, address: 'late@sender.example' }, text: 'Just now.' }])
    await expect(page.getByTestId(`inbox-item-${late.messages[0]!.id}`)).toContainText(`Late news ${stamp}`)

    // ── Another member: their own mailbox, and "not found" for the first member's mail.
    const otherContext = await browser.newContext()
    const other = await otherContext.newPage()
    try {
      const { email: otherEmail } = await registerUser(otherContext, other)
      await seed(other, otherEmail, [])
      const res = await other.goto(`/m/email/inbox?m=${plain.id}`)
      expect(res?.status()).toBe(404)
      await expect(other.getByText(plainSubject)).toHaveCount(0)
      const attempt = await other.request.post(`/m/email/inbox?/read`, {
        form: { messageId: plain.id },
        headers: { 'x-sveltekit-action': 'true', origin: new URL(other.url()).origin },
      })
      expect(await attempt.text()).toContain('No such mail.')
      await other.goto('/m/email/inbox')
      await expect(other.getByTestId('inbox-list-empty')).toHaveText('No mail in your inbox.')
    } finally {
      await otherContext.close()
    }
  })
})
