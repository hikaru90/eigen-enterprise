import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
import postgres from 'postgres'
import { completeProfileViaApi, profileNames, registerUser } from './test-helpers'

/**
 * Calls S4 proof (plan/video-calls.md "Test strategy"): real browsers against
 * the harness's real livekit-server (playwright.config.ts starts it; joins and
 * leaves reach the console only through LiveKit's signed webhook). Chromium's
 * fake camera/microphone stand in for devices. DM call, decline, missed, a
 * three-person channel call, and a call in its own tab (owner, 2026-11-16):
 * every call opens in a tab of its own, the main tab browses freely while
 * the call goes on, the call tab cannot be navigated away from mid-call, and
 * hanging up closes it. Device pickers. Screenshots go to CALLS_SHOTS
 * (default test-results/calls).
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

const CALL_URL = /\/calls\/[0-9a-f-]{36}$/

/** Click `trigger` in the member's main tab and follow the call tab it opens. */
async function callTabFrom(m: Member, trigger: () => Promise<void>): Promise<Page> {
  const before = m.page.url()
  const [tab] = await Promise.all([m.ctx.waitForEvent('page'), trigger()])
  await tab.waitForURL(CALL_URL)
  // The main tab stays where it was: the call never runs in it.
  expect(m.page.url()).toBe(before)
  await expect(m.page.getByTestId('call-view')).toHaveCount(0)
  return tab
}

/** Click Call in the open conversation; the call opens in its own tab. */
async function startCall(caller: Member): Promise<{ id: string; tab: Page }> {
  await expect(caller.page.getByTestId('messages-call')).toHaveAttribute('data-live', 'false')
  const tab = await callTabFrom(caller, () => caller.page.getByTestId('messages-call').click())
  const id = new URL(tab.url()).pathname.split('/').pop()!
  await expect(tab.getByTestId('call-view')).toHaveAttribute('data-phase', 'connected')
  // Full-screen: no app shell, nothing to wander off to mid-call.
  await expect(tab.getByTestId('shell-nav-messages')).toHaveCount(0)
  return { id, tab }
}

/** The incoming-call toast for this call, on whatever nucleus page the callee is on. */
const toast = (page: Page, callId: string) =>
  page.locator(`[data-testid="incoming-call"][data-call-id="${callId}"]`)

/** Accept on the toast: the call opens (and is answered) in its own tab. */
async function accept(m: Member, callId: string): Promise<Page> {
  const ring = toast(m.page, callId)
  const tab = await callTabFrom(m, () => ring.getByTestId('incoming-call-accept').click())
  expect(new URL(tab.url()).pathname).toBe(`/calls/${callId}`)
  await expect(ring).toHaveCount(0)
  await expect(tab.getByTestId('call-view')).toHaveAttribute('data-phase', 'connected')
  return tab
}

/** Hang up: the call tab the app opened closes itself. */
async function hangUp(tab: Page) {
  await Promise.all([tab.waitForEvent('close'), tab.getByTestId('call-hangup').click()])
}

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

  const { id: callId, tab: annCall } = await startCall(ann)
  await expect(annCall.getByTestId('call-status')).toHaveText('Waiting for others to join…')

  const ring = toast(ben.page, callId)
  await expect(ring).toBeVisible()
  await expect(ring.getByTestId('incoming-call-caller')).toHaveText(ann.name)
  await ben.page.screenshot({ path: `${SHOTS}/dm-01-incoming-toast.png` })
  const benCall = await accept(ben, callId)
  await expect(ben.page).toHaveURL(/\/drive/)

  await expectRemoteVideo(annCall, [ben.name])
  await expectRemoteVideo(benCall, [ann.name])
  await expect(annCall.getByTestId('call-status')).toHaveText('2 in the call')
  // The webhook (not the browsers) put both in the call.
  await expect.poll(async () => (await stored(callId)).state).toBe('active')
  const live = await stored(callId)
  expect(
    live.people
      .filter((p) => p.joined_at !== null && p.left_at === null)
      .map((p) => p.user_id)
      .sort(),
  ).toEqual([ann.id, ben.id].sort())

  await annCall.screenshot({ path: `${SHOTS}/dm-02-call-desktop.png` })
  await benCall.setViewportSize(PHONE)
  await expectRemoteVideo(benCall, [ann.name])
  await benCall.screenshot({ path: `${SHOTS}/dm-03-call-phone.png` })

  await hangUp(annCall)
  const ended = benCall.getByTestId('call-ended')
  await expect(ended).toBeVisible()
  await expect(ended).toHaveAttribute('data-reason', 'call_over')
  await expect(ended).toContainText('The call has ended.')
  await benCall.screenshot({ path: `${SHOTS}/dm-04-ended-phone.png` })
  await expect.poll(async () => (await stored(callId)).state).toBe('ended')
  // The call is over: its tab offers Close (the app opened it) and closes.
  await expect(ended.getByTestId('call-back')).toHaveText('Close')
  await Promise.all([benCall.waitForEvent('close'), ended.getByTestId('call-back').click()])

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

  const { id: callId, tab: annCall } = await startCall(ann)
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

  await expect(annCall.getByTestId('call-ended')).toHaveAttribute('data-reason', 'call_over')
  await expect(annCall.getByTestId('call-ended')).toContainText('The call was declined.')
  await annCall.screenshot({ path: `${SHOTS}/declined-01-caller.png` })
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

  const { id: callId, tab: annCall } = await startCall(ann)
  const ring = toast(ben.page, callId)
  await expect(ring).toBeVisible()

  // The ring window closes: the toast goes away and the room is closed under the caller.
  await expect(ring).toHaveCount(0, { timeout: 75_000 })
  await expect(annCall.getByTestId('call-ended')).toHaveAttribute('data-reason', 'call_over', {
    timeout: 30_000,
  })
  await expect(annCall.getByTestId('call-ended')).toContainText('Nobody answered.')
  await annCall.screenshot({ path: `${SHOTS}/missed-01-caller.png` })
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

  const { id: callId, tab: annCall } = await startCall(ann)
  const tabs: Page[] = []
  for (const m of [ben, cat]) {
    const ring = toast(m.page, callId)
    await expect(ring).toBeVisible()
    await expect(ring.getByTestId('incoming-call-where')).toHaveText(`Call in #${channel}`)
    tabs.push(await accept(m, callId))
  }
  const [benCall, catCall] = tabs

  await expectRemoteVideo(annCall, [ben.name, cat.name])
  await expectRemoteVideo(benCall, [ann.name, cat.name])
  await expectRemoteVideo(catCall, [ann.name, ben.name])
  await expect(annCall.getByTestId('call-status')).toHaveText('3 in the call')
  await annCall.screenshot({ path: `${SHOTS}/channel-01-call-desktop.png` })
  await catCall.setViewportSize(PHONE)
  await expectRemoteVideo(catCall, [ann.name, ben.name])
  // Three people: a grid sized to the window — on a 375px phone, one column.
  await expect(annCall.getByTestId('call-view')).toHaveAttribute('data-mode', 'grid')
  await expect(catCall.getByTestId('call-grid')).toHaveAttribute('data-columns', '1')
  await catCall.screenshot({ path: `${SHOTS}/channel-02-call-phone.png`, fullPage: true })

  // One leaves: the call goes on for the other two.
  await hangUp(benCall)
  await expectRemoteVideo(annCall, [cat.name])
  await expectRemoteVideo(catCall, [ann.name])
  expect((await stored(callId)).state).toBe('active')

  await hangUp(annCall)
  await hangUp(catCall)
  await expect.poll(async () => (await stored(callId)).state).toBe('ended')

  for (const m of [ann, ben, cat]) {
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

/** Exactly these people are in the room right now, as LiveKit's webhook told the console. */
async function inRoom(callId: string, ids: string[]) {
  const live = await stored(callId)
  expect(live.state).toBe('active')
  expect(
    live.people
      .filter((p) => p.joined_at !== null && p.left_at === null)
      .map((p) => p.user_id)
      .sort(),
  ).toEqual([...ids].sort())
}

test('a call runs in its own tab: the main tab browses freely, the call tab cannot be left mid-call; devices can be chosen', async ({
  browser,
}) => {
  test.setTimeout(240_000)
  const suffix = Date.now().toString(36)
  const ann = await member(browser, 'admin', `Ava ${suffix}`)
  const ben = await member(browser, 'member', `Bill ${suffix}`)
  await openDm(ann, ben)
  await ben.page.goto('/drive')

  const { id: callId, tab: annCall } = await startCall(ann)
  await expect(toast(ben.page, callId)).toBeVisible()
  const benCall = await accept(ben, callId)
  await expectRemoteVideo(annCall, [ben.name])
  await expectRemoteVideo(benCall, [ann.name])
  // Two people: the other person fills the stage, I am the small self view.
  await expect(annCall.getByTestId('call-view')).toHaveAttribute('data-mode', 'pair')
  await expect.poll(async () => (await stored(callId)).state).toBe('active')

  // The main tabs browse the app — in-app navigation, no reloads — and stay clean.
  await ann.page.getByTestId('shell-nav-email').click()
  await ann.page.waitForURL(/\/m\/email/)
  await ben.page.getByTestId('shell-nav-messages').click()
  await ben.page.waitForURL(/\/messages/)
  for (const m of [ann, ben]) {
    await expect(m.page.getByTestId('call-view')).toHaveCount(0)
    await expect(m.page.getByTestId('mini-call')).toHaveCount(0)
  }
  await ann.page.screenshot({ path: `${SHOTS}/tab-01-main-tab-email.png` })
  // The calls go on in their tabs.
  for (const [tab, other] of [
    [annCall, ben],
    [benCall, ann],
  ] as const) {
    await expect(tab.getByTestId('call-view')).toHaveAttribute('data-phase', 'connected')
    await expectRemoteVideo(tab, [other.name])
  }
  await inRoom(callId, [ann.id, ben.id])

  // The main tab knows I am in a call (another tab): Join on /calls brings
  // the call's tab to the front instead of loading the call a second time.
  await annCall.evaluate(() => ((window as unknown as { __callTabMark: number }).__callTabMark = 1))
  await ann.page.getByTestId('shell-nav-calls').click()
  await ann.page.waitForURL(/\/calls$/)
  const join = ann.page.locator(`[data-testid="calls-live-item"][data-id="${callId}"]`).getByTestId('calls-join')
  await expect(join).toHaveText('Rejoin')
  const pages = ann.ctx.pages().length
  await join.click()
  await expect(ann.page.getByTestId('calls-join-error')).toHaveCount(0)
  expect(ann.ctx.pages()).toHaveLength(pages)
  expect(await annCall.evaluate(() => (window as unknown as { __callTabMark?: number }).__callTabMark)).toBe(1)
  await expect(annCall.getByTestId('call-view')).toHaveAttribute('data-phase', 'connected')
  // One call at a time across tabs: a meeting cannot be started from the main tab.
  await ann.page.getByTestId('calls-new-call').click()
  await ann.page.locator(`[data-testid="new-call-person"][data-email="${ben.email}"]`).check()
  await ann.page.getByTestId('new-call-submit').click()
  await expect(ann.page.getByTestId('new-call-error')).toContainText("You're already in a call")
  expect(ann.ctx.pages()).toHaveLength(pages)
  await ann.page.keyboard.press('Escape')

  // In the call tab, navigating away is refused while the call is live.
  await annCall.evaluate(() => {
    const a = document.createElement('a')
    a.href = '/drive'
    a.textContent = 'Drive'
    a.dataset.testid = 'stray-link'
    document.body.append(a)
  })
  await annCall.getByTestId('stray-link').click()
  await expect(annCall.getByTestId('call-tab-notice')).toHaveText("You're in a call. Hang up first to leave it.")
  expect(new URL(annCall.url()).pathname).toBe(`/calls/${callId}`)
  await expect(annCall.getByTestId('call-view')).toHaveAttribute('data-phase', 'connected')
  await annCall.screenshot({ path: `${SHOTS}/tab-02-leave-blocked.png` })
  // Closing the tab asks first (the browser's own "leave this page?"); staying keeps the call.
  const asked = annCall.waitForEvent('dialog')
  await annCall.close({ runBeforeUnload: true })
  const dialog = await asked
  expect(dialog.type()).toBe('beforeunload')
  await dialog.dismiss()
  expect(annCall.isClosed()).toBe(false)
  await expect(annCall.getByTestId('call-view')).toHaveAttribute('data-phase', 'connected')
  await inRoom(callId, [ann.id, ben.id])

  // Mute in the call tab: Ben sees it.
  await annCall.getByTestId('call-mic').click()
  await expect(annCall.getByTestId('call-mic')).toHaveAttribute('data-on', 'false')
  await expect(remoteTiles(benCall)).toHaveAttribute('data-muted', 'true')

  // Devices (Chromium's fake devices): another microphone; remembered in this browser.
  await annCall.getByTestId('call-devices-toggle').click()
  const micSelect = annCall.getByTestId('call-device-audioinput')
  await expect(micSelect).toBeVisible()
  const mics = await micSelect
    .locator('option')
    .evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value))
  expect(mics.length).toBeGreaterThan(1)
  const otherMic = mics.find((id) => id !== 'default' && id !== 'communications')!
  await micSelect.selectOption(otherMic)
  await expect(micSelect).toHaveValue(otherMic)
  await expect(annCall.getByTestId('call-device-problem')).toHaveCount(0)
  // Chromium can route call sound to a chosen speaker (setSinkId): no "cannot choose" note.
  await expect(annCall.getByTestId('call-speaker-unsupported')).toHaveCount(0)
  await expect(annCall.getByTestId('call-device-videoinput')).toBeVisible()
  await annCall.screenshot({ path: `${SHOTS}/tab-03-devices-desktop.png` })
  const remembered = await annCall.evaluate(() => localStorage.getItem('ee.calls.devices'))
  expect(JSON.parse(remembered ?? '{}')).toMatchObject({ audioinput: otherMic })
  // The call goes on after the switch: Ben still gets Ann's video.
  await expectRemoteVideo(benCall, [ann.name])

  // Hang up: Ann's call tab closes, the DM call ends for both, and the main
  // tab may start calls again.
  await hangUp(annCall)
  await expect(benCall.getByTestId('call-ended')).toHaveAttribute('data-reason', 'call_over')
  await expect.poll(async () => (await stored(callId)).state).toBe('ended')
  await ann.page.getByTestId('calls-new-call').click()
  await ann.page.locator(`[data-testid="new-call-person"][data-email="${ben.email}"]`).check()
  const [meetingTab] = await Promise.all([ann.ctx.waitForEvent('page'), ann.page.getByTestId('new-call-submit').click()])
  await meetingTab.waitForURL(CALL_URL)
  await expect(meetingTab.getByTestId('call-view')).toHaveAttribute('data-phase', 'connected')
  expect(new URL(ann.page.url()).pathname).toBe('/calls')
  await hangUp(meetingTab)

  await ann.ctx.close()
  await ben.ctx.close()
})

test('a guest outside the company joins from a personal link (no account), shows as "Guest", and the host withdraws the link', async ({
  browser,
}) => {
  test.setTimeout(240_000)
  const suffix = Date.now().toString(36)
  const ann = await member(browser, 'admin', `Ada ${suffix}`)
  const guestEmail = `kunde-${suffix}@example.org`
  await ann.page.goto('/calls')
  await expect(ann.page.locator('body')).toHaveAttribute('data-eigen-hydrated', 'true')

  // New call: guests by email first; start now → the host's call tab opens, the guest's link comes back once.
  await ann.page.getByTestId('calls-new-call').click()
  await ann.page.getByLabel('Guests (email)').fill(guestEmail)
  await expect(ann.page.getByLabel('Other call link (Zoom, Teams, Google Meet …)')).toBeVisible()
  const scheduled = ann.page.waitForResponse((r) => r.url().endsWith('/api/calls/meetings') && r.request().method() === 'POST')
  const [annCall] = await Promise.all([ann.ctx.waitForEvent('page'), ann.page.getByTestId('new-call-submit').click()])
  const out = (await (await scheduled).json()) as { call: { id: string }; invitations: { url: string; email: string }[] }
  expect(out.invitations.map((i) => i.email)).toEqual([guestEmail])
  await expect(ann.page.getByTestId('new-call-invitation')).toContainText(guestEmail)
  await annCall.waitForURL(CALL_URL)
  await expect(annCall.getByTestId('call-view')).toHaveAttribute('data-phase', 'connected')
  const [row] = await sql()`select token_hash from call_guest where call_id = ${out.call.id}`
  expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/)
  expect(out.invitations[0]!.url).not.toContain(row.token_hash)

  // The guest: a fresh browser, no account. Name → preview → join.
  const guestCtx = await browser.newContext({ viewport: PHONE, permissions: ['camera', 'microphone'] })
  const guest = await guestCtx.newPage()
  const link = new URL(out.invitations[0]!.url)
  await guest.goto(link.pathname)
  await expect(guest.locator('body')).toHaveAttribute('data-eigen-hydrated', 'true')
  await expect(guest.getByTestId('guest-state')).toHaveAttribute('data-status', 'ok')
  await guest.getByLabel('Your name').fill('Ony Kunde')
  await guest.getByTestId('guest-continue').click()
  await expect(guest.getByTestId('guest-preview-video')).toBeVisible()
  await guest.getByTestId('guest-join').click()
  await expect(guest.getByTestId('call-view')).toHaveAttribute('data-phase', 'connected')
  await guest.screenshot({ path: `${SHOTS}/guest-01-in-call-phone.png` })

  await expectRemoteVideo(annCall, ['Ony Kunde'])
  await expect(remoteTiles(annCall).getByTestId('call-guest-badge')).toHaveText(/guest/i)
  await expectRemoteVideo(guest, [ann.name])
  await expect
    .poll(async () => (await stored(out.call.id)).people.find((p) => String(p.user_id).startsWith('guest:'))?.joined_at ?? null)
    .not.toBeNull()
  await annCall.screenshot({ path: `${SHOTS}/guest-02-host-sees-guest.png` })

  // The host withdraws the link: the guest is removed from the room and the link stops working.
  await ann.page.getByTestId('new-call-done').click()
  const item = ann.page.locator(`[data-testid="calls-live-item"][data-id="${out.call.id}"]`)
  await item.getByTestId('calls-guests').click()
  await ann.page.getByRole('button', { name: `Withdraw the link of ${guestEmail}` }).click()
  await expect(ann.page.locator('[data-testid="meeting-guest"]')).toHaveAttribute('data-revoked', 'true')
  await expect(guest.getByTestId('call-view')).not.toHaveAttribute('data-phase', 'connected', { timeout: 20_000 })
  await expect(remoteTiles(annCall)).toHaveCount(0, { timeout: 20_000 })
  await guest.goto(link.pathname)
  await expect(guest.getByTestId('guest-state')).toHaveAttribute('data-status', 'revoked')

  await hangUp(annCall)
  await guestCtx.close()
  await ann.ctx.close()
})
