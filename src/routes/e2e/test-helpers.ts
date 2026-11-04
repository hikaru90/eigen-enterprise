import { deflateSync } from 'node:zlib'
import { expect, type Page, type BrowserContext } from '@playwright/test'
import { HARNESS_E2E_PASSWORD } from '$lib/e2e/harness-credentials'

export const TEST_PASSWORD = HARNESS_E2E_PASSWORD

let userCounter = 0

export type ProfileNames = { firstName: string; lastName: string }

export type RegisterUserOptions = {
  /** Defaults to `test.eigen` (harness). Use a production domain to exercise onboarding.
   *  Production users land on the nucleus first-run wizard (provider setup) instead of chat. */
  emailDomain?: string
  /**
   * Production accounts first land on the required profile step (P-5). By
   * default the helper completes it through the API (these names + a
   * generated picture) and continues where sign-in was going; 'manual'
   * leaves the page on /welcome/profile for the test to drive.
   */
  profile?: ProfileNames | 'manual'
}

export const DEFAULT_PROFILE: ProfileNames = { firstName: 'E2e', lastName: 'Tester' }

/** "Olga Owner" → { Olga, Owner } (a profile needs both names; the account name stays "First Last"). */
export function profileNames(fullName: string): ProfileNames {
  const [firstName, ...rest] = fullName.trim().split(/\s+/)
  if (!firstName || rest.length === 0) throw new Error(`a profile needs a first and a last name: "${fullName}"`)
  return { firstName, lastName: rest.join(' ') }
}

/**
 * Completes the profile (P-5) through its API as the signed-in page: a
 * 256 px WebP drawn in the browser (the same encoder the profile editor
 * uses) and the two names. Returns the stored image route.
 */
export async function completeProfileViaApi(page: Page, names: ProfileNames = DEFAULT_PROFILE): Promise<string> {
  const result = await page.evaluate(async ({ firstName, lastName }) => {
    const canvas = document.createElement('canvas')
    canvas.width = 256
    canvas.height = 256
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('no 2d canvas')
    const g = ctx.createLinearGradient(0, 0, 256, 256)
    g.addColorStop(0, `hsl(${(firstName.length * 47) % 360} 70% 55%)`)
    g.addColorStop(1, `hsl(${(lastName.length * 83) % 360} 70% 35%)`)
    ctx.fillStyle = g
    ctx.fillRect(0, 0, 256, 256)
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/webp', 0.9))
    if (!blob || blob.type !== 'image/webp') throw new Error(`no WebP encoder (${blob?.type})`)
    const pic = await fetch('/api/profile/avatar', { method: 'POST', headers: { 'content-type': 'image/webp' }, body: blob })
    if (!pic.ok) throw new Error(`avatar upload failed (${pic.status}): ${await pic.text()}`)
    const res = await fetch('/api/profile', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ firstName, lastName }),
    })
    if (!res.ok) throw new Error(`profile save failed (${res.status}): ${await res.text()}`)
    return ((await res.json()) as { profile: { image: string; complete: boolean } }).profile
  }, names)
  if (!result.complete) throw new Error('profile still incomplete after saving it')
  return result.image
}

/** A real w×h PNG (a two-colour gradient), built here so tests need no binary fixture. */
export function pngBytes(w = 160, h = 100): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3
      raw[o] = Math.round((x / w) * 255)
      raw[o + 1] = 90
      raw[o + 2] = Math.round((y / h) * 255)
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (b: Buffer) => {
    let c = 0xffffffff
    for (const byte of b) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type), data])
    const c = Buffer.alloc(4)
    c.writeUInt32BE(crc(td))
    return Buffer.concat([len, td, c])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr.set([8, 2, 0, 0, 0], 8)
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * Walks the profile step (/welcome/profile) like a person: names, a picture
 * chosen, cropped (one drag) and used, then Continue. Waits until the step is left.
 */
/** SvelteKit hydration replaces the SSR DOM: input set before it is lost (root layout marker). */
export async function waitForHydration(page: Page): Promise<void> {
  await expect(page.locator('body')).toHaveAttribute('data-eigen-hydrated', 'true')
}

export async function completeProfileStepInUi(page: Page, names: ProfileNames): Promise<void> {
  await expect(page).toHaveURL(/\/welcome\/profile/)
  await expect(page.getByTestId('profile-step')).toBeVisible()
  await waitForHydration(page)
  await expect(page.getByTestId('profile-save')).toBeDisabled() // no picture yet
  await page.getByTestId('profile-picture-input').setInputFiles({ name: 'me.png', mimeType: 'image/png', buffer: pngBytes(320, 200) })
  const crop = page.getByTestId('profile-crop').locator('canvas')
  await expect(crop).toBeVisible()
  const box = await crop.boundingBox()
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2, { steps: 4 })
    await page.mouse.up()
  }
  await page.getByTestId('profile-crop-apply').click()
  await expect(page.getByTestId('profile-avatar')).toHaveAttribute('data-has-image', 'true')
  await page.getByTestId('profile-first-name').fill(names.firstName)
  await page.getByTestId('profile-last-name').fill(names.lastName)
  await page.getByTestId('profile-save').click()
  await page.waitForURL((u) => u.pathname !== '/welcome/profile', { timeout: 20_000 })
}

/** After a sign-in: when the profile step is showing, complete it (or leave it for 'manual') and continue. */
async function passProfileStep(page: Page, profile: RegisterUserOptions['profile']): Promise<void> {
  const url = new URL(page.url())
  if (url.pathname !== '/welcome/profile' || profile === 'manual') return
  await completeProfileViaApi(page, profile ?? DEFAULT_PROFILE)
  await page.goto(url.searchParams.get('next') ?? '/')
}

/**
 * Register a fresh test user and return their credentials + the context with session cookies.
 */
export async function registerUser(
  context: BrowserContext,
  page: Page,
  options?: RegisterUserOptions,
): Promise<{ email: string }> {
  userCounter += 1
  const id = `${Date.now()}-${userCounter}`
  const emailDomain = options?.emailDomain ?? 'test.eigen'
  const email = `e2e-${id}@${emailDomain}`

  // Passwordless (Better Auth emailOTP): email + terms → Create account → 6-digit code.
  await page.goto('/signup')
  await page.getByRole('button', { name: 'Create account' }).waitFor({ state: 'visible' })
  const emailInput = page.locator('#email')
  await emailInput.fill(email)
  await expect(emailInput).toHaveValue(email)
  const terms = page.getByRole('checkbox', { name: /Terms of Service|AGB/i })
  await terms.check()
  await expect(terms).toBeChecked()
  await page.getByRole('button', { name: 'Create account' }).click()
  await enterEmailedCode(page, email)

  // Signed in: the app (harness accounts) or the profile step first (production, P-5).
  await page.waitForURL((u) => u.pathname === '/' || u.pathname === '/welcome/profile')
  await passProfileStep(page, options?.profile)
  return { email }
}

/**
 * The dev-only harness endpoint exposes the last sign-in code Better Auth emailed,
 * so Playwright completes passwordless login without an inbox.
 */
export async function enterEmailedCode(page: Page, email: string): Promise<void> {
  await page.getByTestId('auth-code-step').waitFor({ state: 'visible', timeout: 15_000 })
  let code: string | null = null
  await expect
    .poll(
      async () => {
        const res = await page.request.get(`/api/e2e/harness/sign-in-code?email=${encodeURIComponent(email)}`)
        if (!res.ok()) throw new Error(`sign-in-code endpoint failed (${res.status()}): ${await res.text()}`)
        code = ((await res.json()) as { code?: string | null }).code ?? null
        return code
      },
      { timeout: 15_000, intervals: [250, 500, 1000] },
    )
    .not.toBeNull()
  if (!code) throw new Error(`No sign-in code captured for ${email}`)
  await page.locator('#code').fill(code)
  await page.getByRole('button', { name: 'Continue' }).click()
}

/**
 * Login an existing user via the login form.
 */
export async function loginUser(page: Page, email: string): Promise<void> {
  await page.goto('/login')
  await page.waitForURL(/\/login/, { timeout: 15_000 })
  await page.locator('#email').fill(email)
  await page.getByRole('button', { name: 'Send code' }).click()
  await enterEmailedCode(page, email)
  await page.waitForURL((u) => u.pathname === '/' || u.pathname === '/welcome/profile')
  await passProfileStep(page, undefined)
}

/**
 * Sign out via the session API (POST — GET does not clear the Better Auth session).
 */
export async function signOut(page: Page): Promise<void> {
  const res = await page.request.post('/api/session/sign-out')
  if (!res.ok()) {
    throw new Error(`sign-out failed (${res.status()}): ${await res.text()}`)
  }
  await page.goto('/login')
  await page.waitForURL(/\/login/, { timeout: 15_000 })
}

/**
 * Capture a thought by submitting to the API (used for seeding test data).
 * Returns the stored thought id.
 */
export async function captureThought(
  page: Page,
  raw: string,
): Promise<{ id: string; normalizedText: string; category: string }> {
  const res = await page.request.post('/api/capture/submit', {
    data: { raw },
    headers: { accept: 'application/json' },
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`captureThought failed (${res.status()}): ${body}`)
  }
  const j = (await res.json()) as {
    thought: { id: string; normalizedText: string; category: string }
  }
  return j.thought
}

/**
 * Navigate to a protected route and assert redirect to /login.
 */
export async function assertRedirectsToLogin(page: Page, path: string): Promise<void> {
  await page.goto(path)
  await page.waitForURL(/\/login/)
}

/** Detects raw JSON/tool payloads that must never appear in user-visible chat text. */
export const CHAT_RAW_JSON_PATTERN = /\{"|\btool"\s*:|"arguments"\s*:|"results"\s*:|"items"\s*:/

export const CHAT_SNAKE_CASE_TOOL_PATTERN = /Running\s+[a-z]+_[a-z0-9_]+/i

export function assertChatLogHasNoRawJson(logText: string): void {
  expect(logText, 'chat should not expose raw JSON to the user').not.toMatch(CHAT_RAW_JSON_PATTERN)
  expect(logText, 'chat should not show snake_case tool names').not.toMatch(
    CHAT_SNAKE_CASE_TOOL_PATTERN,
  )
}

export async function startNewChatSession(page: Page): Promise<void> {
  await page.goto('/chat')
  await expect(page.getByPlaceholder('Ask a question about your memories...')).toBeVisible({
    timeout: 30_000,
  })

  const toggle = page.getByRole('button', { name: 'Toggle session list' })
  if (!(await toggle.isVisible().catch(() => false))) return

  await toggle.click()
  const newChat = page.getByRole('button', { name: 'New chat', exact: true })
  if (await newChat.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await newChat.click()
    // New chat must leave a blank compose — not a prior session that can race-reload mid-stream.
    await expect(
      page.getByText(
        'Ask about your memories, manage thoughts, or save something new when you want to.',
      ),
    ).toBeVisible({ timeout: 10_000 })
  }
  const closeSidebar = page.getByRole('button', { name: 'Close sidebar' })
  if (await closeSidebar.isVisible().catch(() => false)) {
    await closeSidebar.click()
  }
}

export async function askChatQuestion(page: Page, question: string): Promise<void> {
  const input = page.getByPlaceholder('Ask a question about your memories...')
  await expect(input).toBeVisible()
  await input.click()
  await input.fill(question)
  await expect(input).toHaveValue(question)
  await input.press('Enter')
  await expect(page.getByRole('log', { name: 'Chat messages' }).getByText(question)).toBeVisible({
    timeout: 15_000,
  })
}

export async function waitForChatIdle(page: Page, timeoutMs = 120_000): Promise<void> {
  const input = page.getByPlaceholder('Ask a question about your memories...')
  await expect(input).toBeEnabled({ timeout: timeoutMs })
}

export async function assertChatLoadingVisible(page: Page): Promise<void> {
  const progress = page.getByText(
    /Connecting…|Working…|Planning next step|Searching your memories|Searching text notes|Appending to text note|Creating text note|Updating text note|Preparing your reply|Answering your question|Checking your schedule/i,
  )
  const spinner = page.locator('.animate-spin').first()
  await expect
    .poll(
      async () =>
        (await progress
          .first()
          .isVisible()
          .catch(() => false)) || (await spinner.isVisible().catch(() => false)),
      { timeout: 10_000, intervals: [100, 250, 500] },
    )
    .toBe(true)
}

export async function waitForChatAnswerMarker(
  page: Page,
  marker: RegExp | string,
  timeoutMs = 120_000,
): Promise<string> {
  const log = page.getByRole('log', { name: 'Chat messages' })
  const pattern = typeof marker === 'string' ? new RegExp(marker, 'i') : marker
  await waitForChatIdle(page, timeoutMs)
  await expect
    .poll(async () => (await log.textContent()) ?? '', { timeout: timeoutMs })
    .toMatch(pattern)
  const logText = (await log.textContent()) ?? ''
  assertChatLogHasNoRawJson(logText)
  return logText
}

export function normalizeChatLogText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * Final assistant answer bubble (the message with "Regenerate answer").
 * Ephemeral stream progress labels are excluded by design.
 */
export async function readChatFinalAnswerText(page: Page): Promise<string> {
  const regenerate = page.getByRole('button', { name: 'Regenerate answer' }).last()
  await expect(regenerate).toBeVisible()
  const bubble = regenerate.locator('xpath=ancestor::div[contains(@class,"group")][1]')
  return normalizeChatLogText((await bubble.innerText()) ?? '')
}

/**
 * After a completed stream turn: reload the chat page and assert the persisted
 * session answer matches what the live NDJSON stream rendered.
 */
export async function assertChatStreamMatchesReload(
  page: Page,
  options?: { timeoutMs?: number; answerMarker?: RegExp | string },
): Promise<void> {
  const timeoutMs = options?.timeoutMs ?? 120_000
  const marker =
    typeof options?.answerMarker === 'string'
      ? new RegExp(options.answerMarker, 'i')
      : (options?.answerMarker ?? /./)

  await waitForChatIdle(page, timeoutMs)
  await expect(page.getByRole('button', { name: 'Regenerate answer' })).toBeVisible({
    timeout: timeoutMs,
  })

  const streamAnswer = await readChatFinalAnswerText(page)
  expect(streamAnswer.length, 'stream should produce a non-empty answer').toBeGreaterThan(0)
  expect(streamAnswer, 'stream answer should include expected marker').toMatch(marker)
  assertChatLogHasNoRawJson(streamAnswer)

  await page.reload()
  await expect(page.getByPlaceholder('Ask a question about your memories...')).toBeVisible({
    timeout: timeoutMs,
  })
  await waitForChatIdle(page, timeoutMs)

  const log = page.getByRole('log', { name: 'Chat messages' })
  await expect
    .poll(async () => normalizeChatLogText((await log.textContent()) ?? ''), {
      timeout: timeoutMs,
    })
    .toMatch(marker)
  await expect(page.getByRole('button', { name: 'Regenerate answer' })).toBeVisible({
    timeout: timeoutMs,
  })

  const reloadedAnswer = await readChatFinalAnswerText(page)
  assertChatLogHasNoRawJson(reloadedAnswer)
  expect(reloadedAnswer, 'persisted chat answer on reload should match stream response').toBe(
    streamAnswer,
  )
}
