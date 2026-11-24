import { expect, test, type Page } from '@playwright/test'
import postgres from 'postgres'
import { becomeCompanyOwner, type CompanyOwnerSwap } from './company-owner'
import { completeProfileViaApi, gotoHydrated, profileNames, registerUser } from './test-helpers'

/**
 * AI co-workers in a real browser (plan/phase-ai-coworkers.md C5–C7), as the
 * company owner, through the UI:
 *   1. Settings → Co-workers: create one from a template (name, title,
 *      accountabilities, lens, model from the pool, reports-to); it is listed.
 *   2. Org chart: it sits under the owner with its AI mark; people and
 *      co-workers both shown.
 *   3. Its profile: role card, model, daily cap, empty run log and "Would pick
 *      up"; a cap edit (Settings → Co-workers) shows on it; "notice new
 *      messages" saved and still ticked after a reload.
 *   4. Messages: @mentioning it in a channel gets its answer in the thread (the
 *      mock gateway answers the model call), with the AI mark; its run log
 *      then lists the turn.
 *   5. Settings → Members: its row has the AI mark and a link to Co-workers,
 *      no role or remove control, and the role action refuses it.
 * A full-page screenshot of every screen goes to test-results/coworkers/.
 * Any console error or page error fails the journey.
 */

const DATABASE_URL = process.env.DATABASE_URL?.trim()
test.skip(!DATABASE_URL, 'DATABASE_URL not set — the journey sets the owner up in the test DB')

const SHOTS = 'test-results/coworkers'
const GATEWAY_BASE_URL = `http://127.0.0.1:${process.env.MOCK_GATEWAY_PORT ?? 5199}/v1`
const MOCK_ANSWER = 'Hello from mock gateway.'

let _sql: postgres.Sql | null = null
const sql = () => (_sql ??= postgres(DATABASE_URL!, { prepare: false, max: 1 }))
let owner: CompanyOwnerSwap | null = null

test.afterAll(async () => {
  await owner?.restore()
  owner = null
  await _sql?.end()
})

/**
 * A full-page screenshot. The shell scrolls inside its main pane, so `fullPage`
 * alone shows only the viewport: the viewport grows to the pane's content for
 * the shot and is put back after. Messages keeps its viewport (its panes are
 * meant to scroll, and the shared test DB has a long channel list).
 */
async function shot(page: Page, name: string, opts: { grow?: boolean } = {}): Promise<void> {
  const before = page.viewportSize()!
  if (opts.grow !== false) {
    const height = await page.evaluate(() => {
      let h = document.documentElement.scrollHeight
      for (const el of document.querySelectorAll<HTMLElement>('body *')) {
        if (/(auto|scroll)/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight) {
          h = Math.max(h, window.innerHeight + el.scrollHeight - el.clientHeight)
        }
      }
      return h
    })
    if (height > before.height) {
      await page.setViewportSize({ width: before.width, height: Math.min(height, 8000) })
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
    }
  }
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true })
  await page.setViewportSize(before)
}

/**
 * Known noise, not a co-worker screen's:
 * - the presence heartbeat's beat on pagehide / visibility change is cut off by
 *   the journey's full page loads and logs "[presence] heartbeat failed
 *   TypeError: Failed to fetch" (src/lib/messages/self-presence.svelte.ts).
 * - the shared test database holds accounts other worktrees' e2e runs made,
 *   whose pictures live in those worktrees' blob stores: their
 *   /api/people/avatar/<sha> answers 500 "missing on disk" here. Only other
 *   accounts' pictures are excused; this journey's owner's must load.
 * Every other console error, page error and 5xx response fails the journey.
 */
const PRESENCE_NOISE = /^\[presence\] heartbeat failed TypeError: Failed to fetch/
/** The browser's own line for a failed response; the response itself is checked, with its URL, below. */
const RESOURCE_LINE = /^Failed to load resource: the server responded with a status of \d+/

test('owner creates an AI co-worker and meets it in the org chart, its profile, Messages and Members', async ({ page, context }) => {
  test.setTimeout(300_000)
  await page.setViewportSize({ width: 1280, height: 900 })

  let ownerAvatar = ''
  const problems: string[] = []
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return
    const text = msg.text()
    if (PRESENCE_NOISE.test(text) || RESOURCE_LINE.test(text)) return
    problems.push(`console: ${text}`)
  })
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`))
  page.on('response', (res) => {
    if (res.status() < 500) return
    const path = new URL(res.url()).pathname
    const otherAccountsPicture = path.startsWith('/api/people/avatar/') && ownerAvatar !== '' && !path.endsWith(ownerAvatar)
    if (!otherAccountsPicture) problems.push(`${res.status()} ${res.request().method()} ${path}`)
  })

  const suffix = Date.now().toString(36)
  const ownerName = `Olga Owner${suffix}`
  const cwName = `Nova ${suffix}`
  const cwHandle = `nova-${suffix}`
  const cwTitle = 'Head of Positioning'
  const channel = `launch-${suffix}`

  // --- the owner: a production account with a profile, the company's provider on the mock gateway ---
  const { email } = await registerUser(context, page, { emailDomain: 'test.eigen' })
  const rows = await sql()`
    update "user" set name = ${ownerName}, account_kind = 'production', onboarding_completed = true
    where email = ${email} returning id`
  expect(rows).toHaveLength(1)
  const ownerId = rows[0].id as string
  owner = await becomeCompanyOwner(email)
  const picture = await completeProfileViaApi(page, profileNames(ownerName))
  ownerAvatar = new URL(picture, 'http://x').pathname.split('/').pop()!
  expect(ownerAvatar, picture).toMatch(/^[0-9a-f]{64}$/)
  const saved = await page.request.post('/api/onboarding/provider', {
    data: {
      provider: 'openrouter',
      baseUrl: GATEWAY_BASE_URL,
      apiKey: `e2e-key-${Date.now()}`,
      modelChat: 'mock-chat-model',
      modelEmbedding: 'mock-embed-model',
    },
  })
  expect(saved.status(), await saved.text()).toBe(200)

  let cwId = ''
  let familyShown = ''

  await test.step('1. Settings → Co-workers: create one from a template', async () => {
    await gotoHydrated(page, '/settings/coworkers')
    await expect(page.getByRole('heading', { level: 2 })).toBeVisible()
    await shot(page, '01-coworkers-empty-form')

    const form = page.getByTestId('coworker-create-form')
    await form.locator('[data-testid="coworker-template"][value="marketing-manager"]').check()
    // The template fills the card; each field stays editable.
    await expect(form.getByTestId('new-coworker-title')).toHaveValue('Marketing Manager')
    await expect(form.getByTestId('new-coworker-lens')).not.toHaveValue('')
    await form.getByTestId('new-coworker-name').fill(cwName)
    await form.getByTestId('new-coworker-title').fill(cwTitle)
    await form.getByTestId('new-coworker-accountabilities').fill('Own the one-sentence story\nKeep every public word on brand')
    await form.getByTestId('new-coworker-lens').fill('You care that the right people understand, in one sentence, why we win. Push back on vague messaging.')

    // A model from the pool other than the template's: the note under it follows the pick.
    const model = form.getByTestId('new-coworker-model')
    const options = await model.locator('option:not([disabled])').evaluateAll((os) => os.map((o) => ({ value: (o as HTMLOptionElement).value, text: o.textContent ?? '' })))
    expect(options.length, 'the pool offers chat models').toBeGreaterThan(1)
    const current = await model.inputValue()
    const pick = options.find((o) => o.value !== current)!
    await model.selectOption(pick.value)
    familyShown = pick.text.split(' · ')[0]!.trim()
    await expect(form.getByTestId('new-coworker-model-note')).not.toHaveText('')

    await form.getByTestId('new-coworker-manager').selectOption(ownerId)
    await form.getByTestId('new-coworker-cap').fill('3')
    await shot(page, '02-coworkers-form-filled')

    await form.getByTestId('coworker-create').click()
    await expect(page.getByTestId('coworker-create-feedback')).toHaveAttribute('data-kind', 'done', { timeout: 30_000 })

    const card = page.getByTestId('coworker-card').filter({ hasText: cwName })
    await expect(card).toHaveCount(1)
    cwId = (await card.getAttribute('data-id'))!
    expect(cwId).toBeTruthy()
    await expect(card).toContainText(cwTitle)
    await expect(card.getByTestId('ai-mark')).toHaveAttribute('data-family', familyShown)
    await expect(card.getByTestId('coworker-status')).toHaveText(/on/i)
    await expect(card).toContainText(ownerName)
    // The form is cleared for the next one.
    await expect(form.getByTestId('new-coworker-name')).toHaveValue('')
    await shot(page, '03-coworkers-created')
  })

  await test.step('2. Org chart: under the owner, with the AI mark', async () => {
    await gotoHydrated(page, '/settings/org')
    const ownerSeat = page.locator(`[data-testid="org-seat"][data-id="${ownerId}"]`)
    await expect(ownerSeat).toHaveAttribute('data-kind', 'human')
    const seat = ownerSeat.locator(`[data-testid="org-seat"][data-id="${cwId}"]`)
    await expect(seat).toHaveAttribute('data-kind', 'coworker')
    const ownerDepth = Number(await ownerSeat.getAttribute('data-depth'))
    await expect(seat).toHaveAttribute('data-depth', String(ownerDepth + 1))
    await expect(seat.getByTestId('org-seat-name').first()).toHaveText(cwName)
    await expect(seat.getByTestId('org-seat-title').first()).toHaveText(cwTitle)
    await expect(seat.getByTestId('ai-mark').first()).toHaveAttribute('data-family', familyShown)
    await expect(seat.getByTestId('org-seat-accountabilities').first()).toContainText('Own the one-sentence story')
    // A person's seat carries no AI mark.
    await expect(ownerSeat.locator('> article').getByTestId('ai-mark')).toHaveCount(0)
    await shot(page, '04-org-chart')
  })

  await test.step('3. Profile: role card, model, cap; edit the cap; Would pick up saved', async () => {
    await gotoHydrated(page, `/settings/org/${cwId}`)
    const profile = page.getByTestId('seat-profile')
    await expect(profile).toHaveAttribute('data-kind', 'coworker')
    await expect(profile.getByRole('heading', { level: 2 })).toContainText(cwName)
    await expect(profile.getByRole('heading', { level: 2 }).getByTestId('ai-mark')).toHaveAttribute('data-family', familyShown)
    await expect(page.getByTestId('profile-title')).toHaveText(cwTitle)
    await expect(page.getByTestId('profile-accountabilities')).toContainText('Keep every public word on brand')
    await expect(page.getByTestId('profile-manager')).toContainText(ownerName)
    await expect(page.getByTestId('profile-accountable')).toContainText(ownerName)
    await expect(page.getByTestId('profile-model')).toContainText(familyShown)
    await expect(profile).toContainText('3.00')
    await expect(page.getByTestId('profile-lens')).toContainText('Push back on vague messaging')
    // The empty states: no runs yet, nothing it would have picked up.
    await expect(page.getByTestId('run-log-empty')).toBeVisible()
    await expect(page.getByTestId('would-pick-up')).toBeVisible()
    await expect(page.getByTestId('pickup-empty')).toBeVisible()
    await expect(page.getByTestId('pickup-notice')).not.toBeChecked()
    await shot(page, '05-profile')

    // Edit: its daily cap, from the manage link (Settings → Co-workers).
    await page.getByTestId('profile-manage').click()
    await expect(page).toHaveURL(/\/settings\/coworkers$/)
    const card = page.locator(`[data-testid="coworker-card"][data-id="${cwId}"]`)
    await card.getByTestId('coworker-edit').click()
    const edit = card.getByTestId('coworker-edit-form')
    await expect(edit.getByTestId(`coworker-${cwId}-name`)).toHaveValue(cwName)
    await edit.getByTestId(`coworker-${cwId}-cap`).fill('4.5')
    await shot(page, '06-coworkers-edit')
    await edit.getByTestId('coworker-save').click()
    await expect(card.getByTestId('coworker-feedback')).toHaveAttribute('data-kind', 'done', { timeout: 30_000 })
    await expect(edit).toHaveCount(0)
    await expect(card).toContainText('4.50')
    await shot(page, '07-coworkers-saved')

    await gotoHydrated(page, `/settings/org/${cwId}`)
    await expect(page.getByTestId('seat-profile')).toContainText('4.50')

    // "Notice new messages in its channels": saved, and still ticked after a reload.
    await page.getByTestId('pickup-notice').check()
    await page.getByTestId('pickup-save').click()
    await expect(page.getByTestId('pickup-save-feedback')).toHaveAttribute('data-kind', 'done', { timeout: 30_000 })
    await expect(page.getByTestId('pickup-notice')).toBeChecked()
    await shot(page, '08-profile-notice-saved')
    await page.reload()
    await expect(page.locator('body')).toHaveAttribute('data-eigen-hydrated', 'true')
    await expect(page.getByTestId('pickup-notice')).toBeChecked()
  })

  await test.step('4. Messages: @mention it in a channel, it answers in the thread', async () => {
    await gotoHydrated(page, '/messages')
    await expect(page.getByTestId('messages-live')).toHaveAttribute('data-state', 'live')
    await page.getByTestId('messages-new-channel').click()
    await page.locator('#channel-name').fill(channel)
    await page.locator('#channel-topic').fill('The launch')
    await page.getByTestId('channel-create').click()
    await expect(page.getByTestId('messages-title')).toContainText(channel)

    const ask = `@${cwHandle} what is our one-sentence story for the launch?`
    await page.getByTestId('messages-composer').fill(ask)
    await page.getByTestId('messages-composer').press('Enter')
    const root = page.getByTestId('messages-item').filter({ hasText: 'one-sentence story for the launch' })
    await expect(root).toHaveCount(1)
    // The whole handle is highlighted as a mention — the token that asks it, not its first name alone.
    await expect(root.locator('[data-mention]')).toHaveText(`@${cwHandle}`)

    // Its answer arrives in the thread of the asking message, live.
    const threadLink = root.getByTestId('messages-thread-link')
    await expect(threadLink).toBeVisible({ timeout: 90_000 })
    await shot(page, '09-messages-channel', { grow: false })
    await threadLink.click()
    const thread = page.getByTestId('messages-thread')
    await expect(thread).toBeVisible()
    const answer = thread.getByTestId('thread-item').filter({ hasText: MOCK_ANSWER })
    await expect(answer).toHaveCount(1, { timeout: 30_000 })
    await expect(answer.getByTestId('messages-author')).toHaveText(cwName)
    await expect(answer.getByTestId('messages-author-ai')).toBeVisible()
    await shot(page, '10-messages-thread-answer', { grow: false })

    // Its run log now lists the mention turn, with a link back to the thread.
    await gotoHydrated(page, `/settings/org/${cwId}`)
    const run = page.getByTestId('run').first()
    await expect(run).toHaveAttribute('data-trigger', 'mention')
    await expect(run.getByTestId('run-link')).toBeVisible()
    await shot(page, '11-profile-run-log')
  })

  await test.step('5. Settings → Members: the co-worker is managed in Co-workers', async () => {
    await gotoHydrated(page, '/settings/members')
    const row = page.locator('[data-testid="member-row"][data-kind="coworker"]').filter({ hasText: cwName })
    await expect(row).toHaveCount(1)
    await expect(row.getByTestId('ai-mark')).toBeVisible()
    await expect(row.getByTestId('member-coworker-link')).toHaveAttribute('href', '/settings/coworkers')
    await expect(row.getByTestId('member-role-select')).toHaveCount(0)
    await expect(row.getByTestId('member-remove')).toHaveCount(0)
    await expect(row).not.toContainText('coworker.invalid')
    // A person's row keeps its controls.
    await expect(page.locator('[data-testid="member-row"][data-kind="human"]').first()).toBeVisible()
    await shot(page, '12-members')
    // The shared test DB lists many members: the co-worker's row close up.
    await row.screenshot({ path: `${SHOTS}/12b-members-coworker-row.png` })

    // The role action itself refuses it (members.set_role), whatever a client sends.
    const refused = await page.evaluate(async (userId) => {
      const body = new FormData()
      body.set('userId', userId)
      body.set('role', 'admin')
      const res = await fetch('/settings/members?/setRole', { method: 'POST', body, headers: { 'x-sveltekit-action': 'true' } })
      return (await res.json()) as { type: string; data?: string }
    }, cwId)
    expect(refused.type, JSON.stringify(refused)).toBe('failure')
    const [{ role }] = await sql()`select role from "user" where id = ${cwId}`
    expect(role).toBe('member')
  })

  expect(problems, problems.join('\n')).toEqual([])
})
