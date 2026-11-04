import { expect, test, type Browser, type Page } from '@playwright/test'
import postgres from 'postgres'
import { registerUser } from './test-helpers'

/**
 * P-4: the Roadmap is a Memory project. Memory → Projects pins the company's
 * Roadmap first; it opens as a board (planned · in progress · shipped) of the
 * project's tasks. The migrated roadmap is there (the legacy rows moved into
 * the owner's Memory). An admin adds an item, starts it, ships it and edits
 * it; a member sees the same board read-only. Screenshots go to
 * MEMORY_ROADMAP_SHOTS (default test-results/memory-roadmap).
 */

const DATABASE_URL = process.env.DATABASE_URL?.trim()
test.skip(!DATABASE_URL, 'DATABASE_URL not set — the journey prepares its users in the test DB')

const SHOTS = process.env.MEMORY_ROADMAP_SHOTS ?? 'test-results/memory-roadmap'
const GATEWAY_BASE_URL = `http://127.0.0.1:${process.env.MOCK_GATEWAY_PORT ?? 5199}/v1`

let _sql: postgres.Sql | null = null
const sql = (): postgres.Sql => (_sql ??= postgres(DATABASE_URL!, { prepare: false }))
const emails: string[] = []
let itemTitle = ''

test.afterAll(async () => {
  if (itemTitle) await sql()`delete from thought where normalized_text like ${`${itemTitle}%`}`
  for (const email of emails)
    await sql()`update "user" set role = 'member' where email = ${email} and role = 'admin'`
  await _sql?.end()
})

/** A signed-in person past the first-run flows; `admin` promotes a member to admin. */
async function signIn(browser: Browser, role: 'admin' | 'member'): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 } })
  const page = await context.newPage()
  const { email } = await registerUser(context, page, { emailDomain: 'test.eigen' })
  emails.push(email)
  if (role === 'admin')
    await sql()`update "user" set role = 'admin' where email = ${email} and role = 'member'`
  await sql()`update "user" set onboarding_completed = true where email = ${email}`
  const saved = await page.request.post('/api/onboarding/provider', {
    data: {
      provider: 'openrouter',
      baseUrl: GATEWAY_BASE_URL,
      apiKey: `e2e-key-${Date.now()}`,
      modelChat: 'mock-chat-model',
      modelEmbedding: 'mock-embed-model',
    },
  })
  expect(saved.status()).toBeLessThan(500)
  return page
}

test('Memory → Projects → Roadmap: pinned, migrated, add · start · ship · edit; members read', async ({
  browser,
}) => {
  test.setTimeout(180_000)
  const admin = await signIn(browser, 'admin')

  await test.step('Projects pins the Roadmap first', async () => {
    await admin.goto('/m/memory/projects')
    await expect(admin.getByTestId('memory-tab-projects')).toHaveAttribute('aria-current', 'page')
    const pinned = admin.getByTestId('project-card-roadmap')
    await expect(pinned).toBeVisible()
    await expect(pinned).toContainText('Roadmap')
    await expect(pinned).toContainText('System project')
    await expect(pinned).toContainText(/\d+ shipped/)
    await admin.screenshot({ path: `${SHOTS}/1-projects-pinned.png`, fullPage: true })
    await pinned.click()
    await expect(admin).toHaveURL(/\/m\/memory\/projects\/roadmap$/)
  })

  const planned = admin.getByTestId('roadmap-planned')
  const inProgress = admin.getByTestId('roadmap-in-progress')
  const shipped = admin.getByTestId('roadmap-shipped')

  await test.step('the board holds the migrated roadmap', async () => {
    await expect(admin).toHaveTitle(/^Roadmap · Memory · /)
    await expect(admin.getByTestId('memory-tab-projects')).toHaveAttribute('aria-current', 'page')
    await expect(admin.getByRole('heading', { level: 2, name: 'Roadmap' })).toBeVisible()
    await expect(admin.getByTestId('roadmap-system-badge')).toBeVisible()
    await expect(planned.getByRole('heading', { name: /Planned/ })).toBeVisible()
    await expect(shipped.getByText('Founding journey')).toBeVisible()
    await admin.screenshot({ path: `${SHOTS}/2-board.png`, fullPage: true })
  })

  itemTitle = `Invoice reminders ${Date.now()}`
  await test.step('add an item to Planned', async () => {
    await admin.getByTestId('roadmap-add-open').click()
    const addForm = admin.getByTestId('roadmap-add-form')
    await addForm.getByLabel('Title').fill(itemTitle)
    await addForm.getByLabel('Details').fill('Nudge customers a week before due.')
    await addForm.getByLabel('Kind').selectOption('fix')
    await admin.screenshot({ path: `${SHOTS}/3-add.png`, fullPage: true })
    await addForm.getByRole('button', { name: 'Add to planned' }).click()
    const card = planned.getByTestId('roadmap-item').filter({ hasText: itemTitle })
    await expect(card).toBeVisible()
    await expect(card).toContainText('fix')
    await expect(card).toContainText('Nudge customers a week before due.')
  })

  await test.step('start it, then ship it (survives a reload)', async () => {
    await planned
      .getByTestId('roadmap-item')
      .filter({ hasText: itemTitle })
      .getByRole('button', { name: 'Start' })
      .click()
    const started = inProgress.getByTestId('roadmap-item').filter({ hasText: itemTitle })
    await expect(started).toBeVisible()
    await expect(planned.getByText(itemTitle)).toHaveCount(0)
    await admin.reload()
    await expect(inProgress.getByText(itemTitle)).toBeVisible()
    await started.getByRole('button', { name: 'Mark shipped' }).click()
    const done = shipped.getByTestId('roadmap-item').filter({ hasText: itemTitle })
    await expect(done).toBeVisible()
    await expect(done).toContainText(/Shipped \S+/)
    await expect(inProgress.getByText(itemTitle)).toHaveCount(0)
  })

  await test.step('edit it', async () => {
    await shipped
      .getByTestId('roadmap-item')
      .filter({ hasText: itemTitle })
      .getByRole('button', { name: 'Edit' })
      .click()
    // In edit mode the title lives in the card's one Title field.
    await shipped.getByLabel('Title').fill(`${itemTitle} v2`)
    await shipped.getByRole('button', { name: 'Save' }).click()
    const edited = shipped.getByTestId('roadmap-item').filter({ hasText: `${itemTitle} v2` })
    await expect(edited).toBeVisible()
    await edited.scrollIntoViewIfNeeded()
    await admin.screenshot({ path: `${SHOTS}/4-shipped-edited.png`, fullPage: true })
  })

  await test.step('it is a task of the Roadmap project in Memory', async () => {
    const rows = await sql()`
      select t.category, t.lifecycle_status, t.task_kind, ce.system_key
      from thought t
      join thought_entity te on te.thought_id = t.id
      join canonical_entity ce on ce.id = te.entity_id
      where t.normalized_text = ${`${itemTitle} v2`}`
    expect(rows).toEqual([
      { category: 'task', lifecycle_status: 'completed', task_kind: 'fix', system_key: 'roadmap' },
    ])
  })

  await test.step('a member reads the same board, without edit controls', async () => {
    const member = await signIn(browser, 'member')
    await member.goto('/m/memory/projects')
    await member.getByTestId('project-card-roadmap').click()
    await expect(member).toHaveURL(/\/m\/memory\/projects\/roadmap$/)
    await expect(member.getByTestId('roadmap-shipped').getByText(`${itemTitle} v2`)).toBeVisible()
    await expect(member.getByTestId('roadmap-read-only')).toBeVisible()
    await expect(member.getByTestId('roadmap-add-open')).toHaveCount(0)
    await expect(member.getByRole('button', { name: 'Edit' })).toHaveCount(0)
    await member.screenshot({ path: `${SHOTS}/5-member-read-only.png`, fullPage: true })
    await member.context().close()
  })

  await admin.context().close()
})
