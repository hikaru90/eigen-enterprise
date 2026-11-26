import { expect, test, type BrowserContext, type Page } from './e2e-test'
import postgres from 'postgres'
import { registerUser, waitForHydration } from './test-helpers'

/**
 * Phase-cohesion C3 (Memory): one Memory module page in the shell. Open it
 * from the navigation (it lands on Tasks: no Overview any more), walk every
 * sub-page (each its own URL under /m/memory), see that nothing is typed in on
 * Memory (the Ask bar is the one door, plan/concept-memory-one-door.md), find
 * a thought the brain took in under What the brain knows and its task under
 * Tasks, complete it, and see the old URLs gone. Screenshots go to MEMORY_PAGE_SHOTS
 * (default test-results/memory-page) and are meant to be looked at.
 */

const DATABASE_URL = process.env.DATABASE_URL?.trim()
test.skip(!DATABASE_URL, 'DATABASE_URL not set — the walk prepares its user in the dev DB')

const SHOTS = process.env.MEMORY_PAGE_SHOTS ?? 'test-results/memory-page'
const GATEWAY_BASE_URL = `http://127.0.0.1:${process.env.MOCK_GATEWAY_PORT ?? 5199}/v1`

let _sql: postgres.Sql | null = null
const sql = () => (_sql ??= postgres(DATABASE_URL!, { prepare: false }))
test.afterAll(async () => {
  await _sql?.end()
})

async function newOwner(context: BrowserContext, page: Page): Promise<string> {
  const { email } = await registerUser(context, page, { emailDomain: 'test.eigen' })
  // Admin + capture onboarding done: the page under test, not the first-run tour.
  const updated = await sql()`
    update "user" set role = 'admin', onboarding_completed = true where email = ${email} returning id`
  if (updated.length !== 1) throw new Error(`could not prepare ${email}`)
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
  return String(updated[0]!.id)
}

async function expectMemoryTab(page: Page, tab: string, title: RegExp): Promise<void> {
  await expect(page.getByTestId('app-shell')).toBeVisible()
  await expect(page.getByTestId('shell-sidebar').getByTestId('shell-nav-memory')).toHaveAttribute(
    'aria-current',
    'page',
  )
  await expect(page.getByTestId(`memory-tab-${tab}`)).toHaveAttribute('aria-current', 'page')
  await expect(page.getByTestId('memory-nav').locator('[aria-current="page"]')).toHaveCount(1)
  await expect(page.getByTestId('module-status')).toHaveText(/Active/)
  await expect(page).toHaveTitle(title)
}

test('Memory is one module page: nav → Tasks → sub-pages → what the brain knows → task → complete it', async ({
  page,
  context,
}) => {
  test.setTimeout(240_000)
  await page.setViewportSize({ width: 1280, height: 860 })
  const ownerId = await newOwner(context, page)

  await test.step('open Memory from the navigation: Active, it lands on Tasks', async () => {
    await page.goto('/')
    const navEntry = page.getByTestId('shell-sidebar').getByTestId('shell-nav-memory')
    await expect(navEntry).toHaveAttribute('href', '/m/memory')
    await navEntry.click()
    await expect(page).toHaveURL(/\/m\/memory\/tasks$/)
    await expectMemoryTab(page, 'tasks', /^Tasks · Memory · eigenEnterprise$/)
    await expect(page.getByTestId('module-status')).toHaveText('Active')
    await expect(page.getByText('Not active')).toHaveCount(0)
    await expect(page.getByTestId('memory-tab-overview')).toHaveCount(0)
    await expect(page.getByTestId('memory-tab-description')).toHaveText('One step someone does.')
    await page.screenshot({ path: `${SHOTS}/tasks-landing.png`, fullPage: true })
  })

  await test.step('open Settings from the header (right) and save one', async () => {
    await page.getByTestId('memory-settings-link').click()
    await expect(page).toHaveURL(/\/m\/memory\/settings$/)
    // Typed before hydration, the value is reset by hydration and Save sends the old one.
    await waitForHydration(page)
    const settings = page.getByTestId('memory-settings')
    await settings.getByLabel('Minutes before').fill('25')
    await settings.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByTestId('memory-settings-message')).toContainText('saved')
    await page.reload()
    await waitForHydration(page)
    await expect(page.getByTestId('memory-settings').getByLabel('Minutes before')).toHaveValue('25')
  })

  for (const [tab, path, title] of [
    ['tasks', '/m/memory/tasks', /^Tasks · Memory · eigenEnterprise$/],
    ['projects', '/m/memory/projects', /^Projects · Memory · eigenEnterprise$/],
    ['documents', '/m/memory/notes', /^Documents · Memory · eigenEnterprise$/],
    ['reminders', '/m/memory/reminders', /^Reminders · Memory · eigenEnterprise$/],
    ['questions', '/m/memory/questions', /^Questions · Memory · eigenEnterprise$/],
    ['knows', '/m/memory/capture', /^What the brain knows · Memory · eigenEnterprise$/],
  ] as const) {
    await test.step(`sub-page ${tab}`, async () => {
      await page.getByTestId(`memory-tab-${tab}`).click()
      await expect(page).toHaveURL(new RegExp(`${path}$`))
      await expectMemoryTab(page, tab, title)
      // Settled means hydrated; 'networkidle' never comes while the shell's
      // call feed (SSE, /api/calls/stream) is open.
      await waitForHydration(page)
      await page.screenshot({ path: `${SHOTS}/${tab}.png`, fullPage: true })
    })
  }

  const stamp = Date.now()
  const raw = `TODO: call the printer about the flyer order ${stamp}`

  await test.step('nothing is typed in on Memory: What the brain knows points to the Ask bar', async () => {
    await expect(page.getByTestId('brain-knows')).toBeVisible()
    await expect(page.locator('#thought')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Capture', exact: true })).toHaveCount(0)
    await expect(page.getByTestId('tell-the-brain')).toContainText('Ask bar')
    await page.getByTestId('tell-the-brain-open').click()
    await expect(page.getByPlaceholder('Ask the company brain…')).toBeFocused()
    await page.keyboard.press('Escape')
  })

  // What the brain stores for "TODO: call the printer …" with a real model: a
  // task thought plus its due date. Seeded here because the mock cannot.
  const summary = `Call the printer about the flyer order ${stamp}`
  await test.step('the thought shows under What the brain knows, its task under Tasks', async () => {
    const [row] = await sql()`
      insert into thought (user_id, raw_text, normalized_text, lexical_text, category,
        capture_source, enrich_queue_status, enriched_at)
      values (${ownerId}, ${raw}, ${raw}, ${raw}, 'task', 'ui', 'complete', now())
      returning id`
    await sql()`
      insert into temporal_event (user_id, thought_id, kind, active_period, time_precision,
        timezone, confidence, semantic_summary, lexical_text)
      values (${ownerId}, ${row!.id}, 'deadline',
        tsrange((now() + interval '1 day')::timestamp, (now() + interval '1 day 1 hour')::timestamp),
        'day', 'UTC', 0.9, ${summary}, ${summary})`

    await page.reload()
    // A tab click before hydration is a document load, and the Mark done click
    // after it would land on server-rendered markup with no handler.
    await waitForHydration(page)
    const known =page.getByTestId('brain-knows-row').filter({ hasText: `flyer order ${stamp}` })
    await expect(known).toBeVisible({ timeout: 30_000 })
    await expect(known.getByTestId('brain-knows-source')).toHaveText('Typed or spoken in the app')
    await expect(known.getByTestId('brain-knows-category')).toHaveText('task')
    await expect(known.getByTestId('brain-knows-status')).toHaveText('Indexed')
    await page.screenshot({ path: `${SHOTS}/brain-knows.png`, fullPage: true })

    await page.getByTestId('memory-tab-tasks').click()
    await expect(page).toHaveURL(/\/m\/memory\/tasks$/)
    await page.getByRole('tab', { name: /to\s*do/i }).click()
    const row2 = page.getByRole('button', { name: new RegExp(`flyer order ${stamp}`) }).first()
    await expect(row2).toBeVisible({ timeout: 30_000 })
    await page.screenshot({ path: `${SHOTS}/tasks-with-task.png`, fullPage: true })
  })

  await test.step('complete the task from the Tasks page', async () => {
    const row2 = page.getByRole('button', { name: new RegExp(`flyer order ${stamp}`) }).first()
    const markDone = row2.locator('xpath=..').getByRole('button', { name: /Mark done/i })
    const action = page.waitForResponse(
      (r) => r.url().includes('/api/temporal-events/') && r.url().includes('/action'),
    )
    await markDone.first().click()
    const res = await action
    expect(res.ok(), await res.text()).toBe(true)
    await expect
      .poll(async () => {
        const rows = await sql()`
          select lifecycle_status from temporal_event where semantic_summary = ${summary}`
        return rows[0]?.lifecycle_status
      })
      .toBe('completed')
    await page.screenshot({ path: `${SHOTS}/tasks-completed.png`, fullPage: true })
  })

  await test.step('old memory URLs are gone (404 in the shell)', async () => {
    for (const path of ['/memory/tasks', '/memory/projects', '/memory/notes', '/capture']) {
      const res = await page.goto(path)
      expect(res?.status(), path).toBe(404)
      await expect(page.getByTestId('app-shell')).toBeVisible()
    }
  })

  await test.step('phone width: header and sub-navigation fit', async () => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/m/memory/tasks')
    await expect(page.getByTestId('memory-nav')).toBeVisible()
    await page.screenshot({ path: `${SHOTS}/phone-tasks.png` })
  })
})
