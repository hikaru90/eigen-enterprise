import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import postgres from 'postgres'
import { registerUser } from './test-helpers'

/**
 * The workspace fixes from the multi-member proof run (plan/phase-workspace.md),
 * driven with real members in separate browsers:
 *  1. the name typed in the onboarding ("What should I call you?") is the
 *     account name even after "Skip for now" — the shell shows it, not the email;
 *  2. a member who joins by invite lands in Messages, never the company onboarding;
 *  3. a Drive file opened from a message attachment: exactly one sidebar item current;
 *  4. opening a file is reading it — no lock, nobody sees "is editing" — until typing;
 *  5. the path names whose tree it is ("Messages / #…", "Shared with me");
 *  6. size/changed time follow the saves;
 *  7. a restored revision says "Restored from <author>, <time>";
 *  8. no empty first revision; one revision per editing session;
 *  9. typing and leaving at once through an in-app link keeps the text.
 * Screenshots go to WS_FIXES_SHOTS (default test-results/ws-fixes) — look at them.
 */

const DATABASE_URL = process.env.DATABASE_URL?.trim()
test.skip(!DATABASE_URL, 'DATABASE_URL not set — the test prepares its users in the test DB')

const SHOTS = process.env.WS_FIXES_SHOTS ?? 'test-results/ws-fixes'
const GATEWAY_BASE_URL = `http://127.0.0.1:${process.env.MOCK_GATEWAY_PORT ?? 5199}/v1`

let _sql: postgres.Sql | null = null
const sql = () => (_sql ??= postgres(DATABASE_URL!, { prepare: false }))
test.afterAll(async () => {
  await _sql?.end()
})

async function saveProvider(page: Page) {
  const saved = await page.request.post('/api/onboarding/provider', {
    data: { provider: 'openrouter', baseUrl: GATEWAY_BASE_URL, apiKey: `e2e-key-${Date.now()}`, modelChat: 'mock-chat-model', modelEmbedding: 'mock-embed-model' },
  })
  expect(saved.status()).toBe(200)
}

async function newMember(context: BrowserContext, page: Page, role: 'admin' | 'member', name: string) {
  const { email } = await registerUser(context, page, { emailDomain: 'test.eigen' })
  const rows = await sql()`update "user" set role = ${role}, name = ${name}, account_kind = 'production', onboarding_completed = true where email = ${email} returning id`
  if (rows.length !== 1) throw new Error(`could not prepare ${email}`)
  await saveProvider(page)
  return { id: String(rows[0]!.id), email }
}

const item = (page: Page, text: string) => page.getByTestId('messages-item').filter({ hasText: text })
const mode = (page: Page) => page.getByTestId('drive-editor-mode')
const saveState = (page: Page) => page.getByTestId('drive-save-state')
async function expectSaved(page: Page) {
  await expect(saveState(page)).toHaveAttribute('data-status', 'saved', { timeout: 20_000 })
}
const rawText = async (page: Page, id: string) => ((await (await page.request.get(`/api/drive/files/${id}/text`)).json()) as { content: string }).content
const revisionsOf = async (page: Page, id: string) =>
  ((await (await page.request.get(`/api/drive/files/${id}/revisions`)).json()) as { revisions: Array<{ authorId: string; size: number; restoredFrom?: { authorId: string } }> }).revisions
/** Sidebar entries painted as current: aria-current, or a non-transparent background while the mouse is elsewhere. */
/** The New menu (retried: a click before hydration opens nothing). */
async function newItem(page: Page, kind: 'folder' | 'document', name: string) {
  await expect(async () => {
    await page.getByTestId('drive-new').click()
    await expect(page.getByTestId(`drive-new-${kind}`)).toBeVisible({ timeout: 2000 })
  }).toPass()
  await page.getByTestId(`drive-new-${kind}`).click()
  await page.getByTestId('drive-name-input').fill(name)
  await page.getByTestId('drive-name-save').click()
}
async function highlightedNav(page: Page) {
  await page.mouse.move(1000, 850)
  return page.getByTestId('shell-nav').locator('a').evaluateAll((links) =>
    links
      .filter((a) => a.getAttribute('aria-current') === 'page' || getComputedStyle(a).backgroundColor !== 'rgba(0, 0, 0, 0)')
      .map((a) => a.getAttribute('data-testid')),
  )
}

test('workspace fixes: name, invite landing, sidebar, read-first editing, paths, revisions, leave-while-typing', async ({ browser }) => {
  test.setTimeout(420_000)
  const suffix = Date.now().toString(36)
  const vp = { viewport: { width: 1440, height: 900 } }

  // ── 1. The founder names themselves in the onboarding, then skips ──────────
  const ctxO = await browser.newContext(vp)
  const o = await ctxO.newPage()
  const { email: oEmail } = await registerUser(ctxO, o, { emailDomain: 'test.eigen' })
  await sql()`update "user" set role = 'admin', account_kind = 'production' where email = ${oEmail}`
  await o.goto('/')
  const nameAsk = o.getByRole('textbox', { name: 'Your name' })
  await expect(nameAsk).toBeVisible({ timeout: 20_000 })
  await nameAsk.fill(`Olivia Owner`)
  await o.screenshot({ path: `${SHOTS}/01-owner-names-herself.png` })
  await nameAsk.press('Enter')
  await o.getByTestId('skip-onboarding').click()
  await expect.poll(async () => (await sql()`select name from "user" where email = ${oEmail}`)[0]?.name).toBe('Olivia Owner')
  await saveProvider(o)
  await o.goto('/messages')
  await expect(o.getByTestId('shell-user')).toHaveText('Olivia Owner')
  await o.screenshot({ path: `${SHOTS}/02-owner-name-in-shell.png` })

  // ── 2. Ben joins by invite → Messages, no company onboarding ───────────────
  const benEmail = `ben-${suffix}@test.eigen`
  await o.goto('/settings/members')
  await o.locator('#invite-email').fill(benEmail)
  await o.locator('#invite-role').selectOption('member')
  await o.getByRole('button', { name: 'Create invite link' }).click()
  const inviteUrl = await o.getByTestId('invite-link-url').inputValue()
  const ctxB = await browser.newContext(vp)
  const b = await ctxB.newPage()
  await b.goto(inviteUrl)
  await b.locator('#invite-name').fill('Ben')
  await b.getByTestId('invite-join').click()
  await expect(b.getByTestId('invite-passkey-step')).toBeVisible()
  await expect(async () => {
    await b.getByTestId('invite-skip-passkey').click()
    await expect(b.getByTestId('invite-skip-warning')).toBeVisible({ timeout: 2000 })
  }).toPass()
  await b.getByTestId('invite-skip-confirm').click()
  await expect(b).toHaveURL(/\/messages/)
  await expect(b.getByTestId('skip-onboarding')).toHaveCount(0)
  await expect(b.getByText('Connect your AI provider.')).toHaveCount(0)
  await b.screenshot({ path: `${SHOTS}/03-ben-lands-in-messages.png` })
  // The dev harness classifies @test.eigen sign-ups as test accounts; a real invite makes a production member.
  await sql()`update "user" set account_kind = 'production' where email = ${benEmail}`
  // Coming back to / later: the chat, never the setup wizard.
  await b.goto('/')
  await expect(b.getByTestId('shell-sidebar')).toBeVisible()
  await expect(b.getByTestId('skip-onboarding')).toHaveCount(0)
  await expect(b.getByText('Connect your AI provider.')).toHaveCount(0)
  await b.screenshot({ path: `${SHOTS}/04-ben-home-no-onboarding.png` })

  const ctxA = await browser.newContext(vp)
  const a = await ctxA.newPage()
  const { id: annaId } = await newMember(ctxA, a, 'member', 'Anna')

  // ── 3–5. An attachment in #general, opened from the message ────────────────
  const general = `general-${suffix}`
  await o.goto('/messages')
  await expect(o.getByTestId('messages-live')).toHaveAttribute('data-state', 'live')
  await o.getByTestId('messages-new-channel').click()
  await o.locator('#channel-name').fill(general)
  await o.getByTestId('channel-create').click()
  await expect(o.getByTestId('messages-title')).toContainText(general)
  await o.getByTestId('messages-file-input').setInputFiles([{ name: 'agenda.md', mimeType: 'text/markdown', buffer: Buffer.from('# Weekly agenda\n\n- Kickoff\n') }])
  await expect(o.locator('[data-testid="messages-pending-file"][data-status="ready"]')).toHaveCount(1)
  await o.getByTestId('messages-composer').fill('Files for the week')
  await o.getByTestId('messages-composer').press('Enter')
  await expect(item(o, 'Files for the week')).toBeVisible()

  await b.goto('/messages')
  await expect(b.getByTestId('messages-live')).toHaveAttribute('data-state', 'live')
  await b.getByTestId('messages-list').locator(`[data-testid="messages-conversation"][data-title="${general}"]`).click()
  const card = item(b, 'Files for the week').locator('[data-testid="messages-attachment-file"][data-name="agenda.md"]')
  await expect(card).toBeVisible()
  await card.click()
  await expect(b).toHaveURL(/\/drive\/file\//)
  const agendaId = b.url().split('/').pop()!
  await expect(mode(b)).toHaveAttribute('data-mode', 'reading')
  // 3. One current sidebar item: Drive.
  expect(await highlightedNav(b)).toEqual(['shell-nav-drive'])
  // 5. The path: Messages / #general, never "My drive".
  await expect(b.getByTestId('drive-path-root')).toHaveText('Messages')
  await expect(b.getByTestId('drive-path')).toHaveText(new RegExp(`^\\s*Messages\\s*/\\s*#${general}\\s*$`))
  await b.screenshot({ path: `${SHOTS}/05-ben-opens-attachment-reading.png` })

  // 4. Olivia opens it too: nobody is editing — no banner, no lock.
  await o.goto(`/drive/file/${agendaId}`)
  await expect(mode(o)).toHaveAttribute('data-mode', 'reading')
  await expect(o.getByTestId('drive-lock-banner')).toHaveCount(0)
  expect(await (await o.request.get(`/api/drive/files/${agendaId}/lock`)).json()).toEqual({ state: 'free' })
  // Ben starts typing → he edits; Olivia sees "Ben is editing" (next heartbeat).
  await b.getByTestId('drive-md-editable').locator('li').last().click()
  await b.keyboard.press('End')
  await b.keyboard.type(' with Anna')
  await expect(mode(b)).toHaveAttribute('data-mode', 'editing')
  await expectSaved(b)
  await expect(o.getByTestId('drive-lock-holder')).toHaveText('Ben', { timeout: 30_000 })
  await o.screenshot({ path: `${SHOTS}/06-owner-sees-ben-editing.png` })
  // 6. Ben's header shows the saved size.
  const agendaBytes = new TextEncoder().encode(await rawText(b, agendaId)).byteLength
  await expect(b.getByTestId('drive-file')).toContainText(`${agendaBytes} B · changed`)
  await b.getByTestId('drive-stop-editing').click()
  await expect(mode(b)).toHaveAttribute('data-mode', 'reading')
  expect(await (await b.request.get(`/api/drive/files/${agendaId}/lock`)).json()).toEqual({ state: 'free' })

  // ── 5. Shared with me reads "Shared with me" ───────────────────────────────
  await o.goto('/drive')
  await newItem(o, 'folder', 'Projects')
  await expect(o.getByTestId('drive-row').filter({ hasText: 'Projects' })).toBeVisible()
  const projects = (await sql()`select id from drive_folder where name = 'Projects' and owner_id = (select id from "user" where email = ${oEmail})`)[0]!.id as string
  const benId = (await sql()`select id from "user" where email = ${benEmail}`)[0]!.id as string
  expect(
    (
      await o.request.put(`/api/drive/items/folder/${projects}/grants`, {
        data: { grants: [{ subject: { kind: 'user', userId: annaId }, level: 'edit' }, { subject: { kind: 'user', userId: benId }, level: 'edit' }] },
      })
    ).status(),
  ).toBe(200)
  await a.goto('/drive/shared')
  await expect(a.getByTestId('drive-path-root')).toHaveText('Shared with me')
  await a.getByRole('link', { name: 'Projects' }).click()
  await expect(a.getByTestId('drive-path-root')).toHaveText('Shared with me')
  await expect(a.getByTestId('drive-path')).not.toContainText('My drive')
  await a.screenshot({ path: `${SHOTS}/07-anna-shared-folder-path.png` })

  // ── 8. Anna writes plan.md: no empty first revision, one per session ───────
  await newItem(a, 'document', 'plan')
  await expect(a).toHaveURL(/\/drive\/file\//)
  const planId = a.url().split('/').pop()!
  await expect(a.getByTestId('drive-revision')).toHaveCount(0)
  await expect(a.getByTestId('drive-path')).toContainText('Shared with me')
  await a.getByTestId('drive-md-editable').click()
  await a.keyboard.type('Q4 plan')
  await expectSaved(a)
  await a.keyboard.press('Enter')
  await a.keyboard.type('Call the top 10 customers')
  await expectSaved(a)
  await a.keyboard.press('Enter')
  await a.keyboard.type('Update the price list')
  await expectSaved(a)
  await expect(a.getByTestId('drive-revision')).toHaveCount(1)
  expect((await revisionsOf(a, planId)).map((r) => r.authorId)).toEqual([annaId])
  // 6. The header follows the save (never "0 B").
  const planBytes = new TextEncoder().encode(await rawText(a, planId)).byteLength
  await expect(a.getByTestId('drive-file')).toContainText(`${planBytes} B · changed`)
  await a.screenshot({ path: `${SHOTS}/08-anna-one-revision.png`, fullPage: true })

  // Ben takes over (a new revision), Anna keeps her draft view.
  await b.goto(`/drive/file/${planId}`)
  await expect(b.getByTestId('drive-lock-holder')).toHaveText('Anna')
  await b.getByTestId('drive-takeover').click()
  await expect(mode(b)).toHaveAttribute('data-mode', 'editing')
  await b.getByTestId('drive-md-editable').locator('p').first().click()
  await b.keyboard.press('End')
  await b.keyboard.type(' (draft)')
  await expectSaved(b)
  await b.keyboard.type('!')
  await expectSaved(b)
  await expect(b.getByTestId('drive-revision')).toHaveCount(2)

  // ── 7. Ben restores Anna's version: "Restored from Anna, <time>" ───────────
  await b.getByTestId('drive-revision').nth(1).getByTestId('drive-revision-restore').click()
  await expect(b.getByTestId('drive-revision')).toHaveCount(3)
  await expect(b.getByTestId('drive-revision').first().getByTestId('drive-revision-restored-from')).toHaveText(/^Restored from Anna, /)
  expect((await revisionsOf(b, planId))[0]!.restoredFrom?.authorId).toBe(annaId)
  await expect(b.getByTestId('drive-md-editable')).not.toContainText('(draft)')
  await b.screenshot({ path: `${SHOTS}/09-ben-restored-from-anna.png`, fullPage: true })

  // ── 9. Type and leave at once through an in-app link: nothing lost ─────────
  await b.getByTestId('drive-md-editable').locator('p').last().click()
  await b.keyboard.press('End')
  await b.keyboard.type(' — typed and left')
  await b.getByTestId('shell-nav-messages').click()
  await expect(b).toHaveURL(/\/messages/)
  expect(await rawText(b, planId)).toContain('typed and left')
  // A brand-new document, typed into and left right away (the lock is still being taken).
  await b.goto('/drive')
  await newItem(b, 'document', `quick-${suffix}`)
  await expect(b).toHaveURL(/\/drive\/file\//)
  const quickId = b.url().split('/').pop()!
  await b.getByTestId('drive-md-editable').click()
  await b.keyboard.type('Remember the milk')
  await b.getByTestId('shell-nav-drive').click()
  await expect(b).toHaveURL(/\/drive$/)
  expect(await rawText(b, quickId)).toContain('Remember the milk')
  // 6. The list shows the saved size, not "0 B".
  const quickRow = b.locator('tr', { hasText: `quick-${suffix}.md` })
  await expect(quickRow).toContainText(`${new TextEncoder().encode(await rawText(b, quickId)).byteLength} B`)
  await b.screenshot({ path: `${SHOTS}/10-ben-list-after-leave.png`, fullPage: true })

  await ctxO.close()
  await ctxA.close()
  await ctxB.close()
})
