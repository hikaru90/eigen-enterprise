import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
import postgres from 'postgres'
import { completeProfileViaApi, profileNames, registerUser } from './test-helpers'

/**
 * Calls S4 proof (plan/video-calls.md "Test strategy"): real browsers against
 * the harness's real livekit-server (playwright.config.ts starts it; joins and
 * leaves reach the console only through LiveKit's signed webhook). Chromium's
 * fake camera/microphone stand in for devices. DM call, decline, missed, and a
 * three-person channel call. Screenshots go to CALLS_SHOTS (default
 * test-results/calls).
 */

const DATABASE_URL = process.env.DATABASE_URL?.trim()
if (!DATABASE_URL)
  throw new Error(
    'DATABASE_URL not set — the calls e2e sets roles and reads call state in the test DB',
  )

const SHOTS = process.env.CALLS_SHOTS ?? 'test-results/calls'
const GATEWAY_BASE_URL = `http://127.0.0.1:${process.env.MOCK_GATEWAY_PORT ?? 5199}/v1`
const DESKTOP = { width: 1280, height: 800 }
const PHONE = { width: 375, height: 812 }

// Fake media for this suite only (launchOptions is worker-scoped: this file gets its own browser).
test.use({
  launchOptions: {
    args: [
      '--disable-popup-blocking',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
    ],
  },
})

let _sql: postgres.Sql | null = null
const sql = () => (_sql ??= postgres(DATABASE_URL!, { prepare: false }))
test.afterAll(async () => {
  await _sql?.end()
})

type Member = { ctx: BrowserContext; page: Page; email: string; id: string; name: string }

/** A signed-in company member in their own browser context, camera + mic allowed. */
async function member(browser: Browser, role: 'admin' | 'member', name: string): Promise<Member> {
  const ctx = await browser.newContext({ viewport: DESKTOP, permissions: ['camera', 'microphone'] })
  const page = await ctx.newPage()
  const { email } = await registerUser(ctx, page, { emailDomain: 'test.eigen' })
  const rows = await sql()`
    update "user" set role = ${role}, name = ${name}, account_kind = 'production', onboarding_completed = true
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
  return { ctx, page, email, id: rows[0].id as string, name }
}

const conv = (page: Page, title: string) =>
  page
    .getByTestId('messages-list')
    .locator(`[data-testid="messages-conversation"][data-title="${title}"]`)

async function openMessages(page: Page) {
  await page.goto('/messages')
  await expect(page.getByTestId('messages-live')).toHaveAttribute('data-state', 'live')
}

/** `from` opens a DM with `to` (and says hello, so `to` has it in the list). */
async function openDm(from: Member, to: Member) {
  await openMessages(from.page)
  await from.page.getByTestId('messages-new-dm').click()
  await from.page.locator(`[data-testid="dm-person"][data-email="${to.email}"]`).check()
  await from.page.getByTestId('dm-start').click()
  await expect(from.page.getByTestId('messages-title')).toContainText(to.name)
  await from.page.getByTestId('messages-composer').fill('Got a minute?')
  await from.page.getByTestId('messages-composer').press('Enter')
  await expect(
    from.page.getByTestId('messages-body').filter({ hasText: 'Got a minute?' }),
  ).toBeVisible()
}

/** Click Call in the open conversation; the caller lands on the call page. Returns the call id. */
async function startCall(caller: Page): Promise<string> {
  await expect(caller.getByTestId('messages-call')).toHaveAttribute('data-live', 'false')
  await caller.getByTestId('messages-call').click()
  await caller.waitForURL(/\/calls\/[0-9a-f-]{36}$/)
  const id = new URL(caller.url()).pathname.split('/').pop()!
  await expect(caller.getByTestId('call-view')).toHaveAttribute('data-phase', 'connected')
  return id
}

/** The incoming-call toast for this call, on whatever nucleus page the callee is on. */
const toast = (page: Page, callId: string) =>
  page.locator(`[data-testid="incoming-call"][data-call-id="${callId}"]`)

const remoteTiles = (page: Page) =>
  page.locator('[data-testid="call-tile"][data-local="false"][data-kind="camera"]')

/** Each of `names` is in the grid as a remote camera tile whose <video> is really decoding frames. */
async function expectRemoteVideo(page: Page, names: string[]) {
  const tiles = remoteTiles(page)
  await expect(tiles).toHaveCount(names.length, { timeout: 30_000 })
  for (const n of names)
    await expect(tiles.getByTestId('call-tile-name').filter({ hasText: n })).toHaveCount(1)
  await expect(tiles.locator('[data-testid="call-video"]')).toHaveCount(names.length)
  await expect
    .poll(
      () =>
        tiles
          .locator('[data-testid="call-video"]')
          .evaluateAll((vs) => vs.filter((v) => (v as HTMLVideoElement).videoWidth > 0).length),
      { timeout: 30_000, message: 'remote <video> elements with frames (videoWidth > 0)' },
    )
    .toBe(names.length)
  // And it keeps playing: every remote video decodes new frames (not one frame, then paused).
  const frames = () =>
    tiles
      .locator('[data-testid="call-video"]')
      .evaluateAll((vs) =>
        vs.map((v) => (v as HTMLVideoElement).getVideoPlaybackQuality().totalVideoFrames),
      )
  const before = await frames()
  await expect
    .poll(async () => (await frames()).filter((n, i) => n > before[i] + 10).length, {
      timeout: 15_000,
      message: 'remote videos still decoding new frames',
    })
    .toBe(names.length)
}

/** The call as stored: its state and who the webhook saw join. */
async function stored(callId: string) {
  const [call] = await sql()`select state from "call" where id = ${callId}`
  const people =
    await sql()`select user_id, joined_at, left_at, response from call_participant where call_id = ${callId}`
  return { state: call?.state as string | undefined, people }
}

/** The conversation's call lines (structured data on the row, never parsed from text). */
const callLines = (page: Page) => page.getByTestId('messages-call-line')

test('DM call: ring on another page, accept, both see each other, hang up → "Call, n min" in both DMs', async ({
  browser,
}) => {
  test.setTimeout(240_000)
  const suffix = Date.now().toString(36)
  const ann = await member(browser, 'admin', `Ann ${suffix}`)
  const ben = await member(browser, 'member', `Ben ${suffix}`)
  await openDm(ann, ben)

  // Ben is somewhere else entirely (Drive), not in Messages.
  await ben.page.goto('/drive')
  await expect(ben.page.getByTestId('shell-nav-messages')).not.toHaveAttribute(
    'aria-current',
    'page',
  )

  const callId = await startCall(ann.page)
  await expect(ann.page.getByTestId('call-status')).toHaveText('Waiting for others to join…')

  const ring = toast(ben.page, callId)
  await expect(ring).toBeVisible()
  await expect(ring.getByTestId('incoming-call-caller')).toHaveText(ann.name)
  await ben.page.screenshot({ path: `${SHOTS}/dm-01-incoming-toast.png` })
  await ring.getByTestId('incoming-call-accept').click()
  await ben.page.waitForURL(new RegExp(`/calls/${callId}$`))
  await expect(ben.page.getByTestId('call-view')).toHaveAttribute('data-phase', 'connected')

  await expectRemoteVideo(ann.page, [ben.name])
  await expectRemoteVideo(ben.page, [ann.name])
  await expect(ann.page.getByTestId('call-status')).toHaveText('2 in the call')
  // The webhook (not the browsers) put both in the call.
  await expect.poll(async () => (await stored(callId)).state).toBe('active')
  const live = await stored(callId)
  expect(
    live.people
      .filter((p) => p.joined_at !== null && p.left_at === null)
      .map((p) => p.user_id)
      .sort(),
  ).toEqual([ann.id, ben.id].sort())

  await ann.page.screenshot({ path: `${SHOTS}/dm-02-call-desktop.png` })
  await ben.page.setViewportSize(PHONE)
  await expectRemoteVideo(ben.page, [ann.name])
  await ben.page.screenshot({ path: `${SHOTS}/dm-03-call-phone.png` })

  await ann.page.getByTestId('call-hangup').click()
  await ann.page.waitForURL(/\/calls$/)
  await expect(ben.page.getByTestId('call-ended')).toBeVisible()
  await expect(ben.page.getByTestId('call-ended')).toHaveAttribute('data-reason', 'call_over')
  await expect(ben.page.getByTestId('call-ended')).toContainText('The call has ended.')
  await ben.page.screenshot({ path: `${SHOTS}/dm-04-ended-phone.png` })
  await expect.poll(async () => (await stored(callId)).state).toBe('ended')

  for (const [who, other] of [
    [ann, ben],
    [ben, ann],
  ] as const) {
    await who.page.setViewportSize(DESKTOP)
    await openMessages(who.page)
    await conv(who.page, other.name).click()
    await expect(callLines(who.page)).toHaveCount(1)
    await expect(callLines(who.page)).toHaveAttribute('data-outcome', 'ended')
    await expect(who.page.getByTestId('messages-call')).toHaveAttribute('data-live', 'false')
  }
  await ann.page.screenshot({ path: `${SHOTS}/dm-05-call-line.png` })

  await ann.ctx.close()
  await ben.ctx.close()
})

test('DM call declined: the caller is told, "Declined call" in the DM', async ({ browser }) => {
  test.setTimeout(180_000)
  const suffix = Date.now().toString(36)
  const ann = await member(browser, 'admin', `Ada ${suffix}`)
  const ben = await member(browser, 'member', `Bob ${suffix}`)
  await openDm(ann, ben)
  await ben.page.goto('/drive')

  const callId = await startCall(ann.page)
  // Ann is really in the room before Bob says no.
  await expect
    .poll(
      async () =>
        (await stored(callId)).people.find((p) => p.user_id === ann.id)?.joined_at ?? null,
    )
    .not.toBeNull()
  const ring = toast(ben.page, callId)
  await expect(ring).toBeVisible()
  await ring.getByTestId('incoming-call-decline').click()
  await expect(ring).toHaveCount(0)
  await expect(ben.page).toHaveURL(/\/drive/)

  await expect(ann.page.getByTestId('call-ended')).toHaveAttribute('data-reason', 'call_over')
  await expect(ann.page.getByTestId('call-ended')).toContainText('The call was declined.')
  await ann.page.screenshot({ path: `${SHOTS}/declined-01-caller.png` })
  expect((await stored(callId)).state).toBe('declined')

  for (const [who, other] of [
    [ann, ben],
    [ben, ann],
  ] as const) {
    await openMessages(who.page)
    await conv(who.page, other.name).click()
    await expect(callLines(who.page)).toHaveCount(1)
    await expect(callLines(who.page)).toHaveAttribute('data-outcome', 'declined')
  }

  await ann.ctx.close()
  await ben.ctx.close()
})

test('DM call nobody answers: rings out, the caller is told, "Missed call" in the DM', async ({
  browser,
}) => {
  // The ring window is 45 s (modules/calls/state.ts RING_TIMEOUT_MS), not shortened for tests.
  test.setTimeout(240_000)
  const suffix = Date.now().toString(36)
  const ann = await member(browser, 'admin', `Amy ${suffix}`)
  const ben = await member(browser, 'member', `Bert ${suffix}`)
  await openDm(ann, ben)
  await ben.page.goto('/drive')

  const callId = await startCall(ann.page)
  const ring = toast(ben.page, callId)
  await expect(ring).toBeVisible()

  // The ring window closes: the toast goes away and the room is closed under the caller.
  await expect(ring).toHaveCount(0, { timeout: 75_000 })
  await expect(ann.page.getByTestId('call-ended')).toHaveAttribute('data-reason', 'call_over', {
    timeout: 30_000,
  })
  await expect(ann.page.getByTestId('call-ended')).toContainText('Nobody answered.')
  await ann.page.screenshot({ path: `${SHOTS}/missed-01-caller.png` })
  expect((await stored(callId)).state).toBe('missed')

  for (const [who, other] of [
    [ann, ben],
    [ben, ann],
  ] as const) {
    await openMessages(who.page)
    await conv(who.page, other.name).click()
    await expect(callLines(who.page)).toHaveCount(1)
    await expect(callLines(who.page)).toHaveAttribute('data-outcome', 'missed')
  }

  await ann.ctx.close()
  await ben.ctx.close()
})

test('three-person channel call: two accept, everyone sees two remote videos, all leave → one call line', async ({
  browser,
}) => {
  test.setTimeout(300_000)
  const suffix = Date.now().toString(36)
  const ann = await member(browser, 'admin', `Ari ${suffix}`)
  const ben = await member(browser, 'member', `Bo ${suffix}`)
  const cat = await member(browser, 'member', `Cy ${suffix}`)
  const channel = `standup-${suffix}`

  // A private channel with just the three of them.
  await openMessages(ann.page)
  await ann.page.getByTestId('messages-new-channel').click()
  await ann.page.locator('#channel-name').fill(channel)
  await ann.page.getByTestId('channel-private').check()
  for (const m of [ben, cat])
    await ann.page
      .getByTestId('channel-invite')
      .locator('label')
      .filter({ hasText: m.email })
      .locator('input')
      .check()
  await ann.page.getByTestId('channel-create').click()
  await expect(ann.page.getByTestId('messages-title')).toContainText(channel)

  await ben.page.goto('/drive')
  await cat.page.goto('/calls')

  const callId = await startCall(ann.page)
  for (const m of [ben, cat]) {
    const ring = toast(m.page, callId)
    await expect(ring).toBeVisible()
    await expect(ring.getByTestId('incoming-call-where')).toHaveText(`Call in #${channel}`)
    await ring.getByTestId('incoming-call-accept').click()
    await m.page.waitForURL(new RegExp(`/calls/${callId}$`))
  }

  await expectRemoteVideo(ann.page, [ben.name, cat.name])
  await expectRemoteVideo(ben.page, [ann.name, cat.name])
  await expectRemoteVideo(cat.page, [ann.name, ben.name])
  await expect(ann.page.getByTestId('call-status')).toHaveText('3 in the call')
  await ann.page.screenshot({ path: `${SHOTS}/channel-01-call-desktop.png` })
  await cat.page.setViewportSize(PHONE)
  await expectRemoteVideo(cat.page, [ann.name, ben.name])
  await cat.page.screenshot({ path: `${SHOTS}/channel-02-call-phone.png`, fullPage: true })

  // One leaves: the call goes on for the other two.
  await ben.page.getByTestId('call-hangup').click()
  await ben.page.waitForURL(/\/calls$/)
  await expectRemoteVideo(ann.page, [cat.name])
  await expectRemoteVideo(cat.page, [ann.name])
  expect((await stored(callId)).state).toBe('active')

  await ann.page.getByTestId('call-hangup').click()
  await ann.page.waitForURL(/\/calls$/)
  await cat.page.getByTestId('call-hangup').click()
  await cat.page.waitForURL(/\/calls$/)
  await expect.poll(async () => (await stored(callId)).state).toBe('ended')

  for (const m of [ann, ben, cat]) {
    await m.page.setViewportSize(DESKTOP)
    await openMessages(m.page)
    await conv(m.page, channel).click()
    await expect(callLines(m.page)).toHaveCount(1)
    await expect(callLines(m.page)).toHaveAttribute('data-outcome', 'ended')
  }
  await ann.page.screenshot({ path: `${SHOTS}/channel-03-call-line.png` })

  await ann.ctx.close()
  await ben.ctx.close()
  await cat.ctx.close()
})
