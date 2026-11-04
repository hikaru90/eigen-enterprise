import { deflateSync } from 'node:zlib'
import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import postgres from 'postgres'
import { completeProfileViaApi, profileNames, registerUser } from './test-helpers'

/**
 * Phase-workspace C2 proof, two members in two browsers: a thread reply
 * appears live for the other; reactions toggle live with who reacted; edit
 * shows "(edited)", delete shows "Message deleted" (own, and an admin's
 * moderation delete, audited); an image and a .md attached in #general land in
 * the Drive — B sees the thumbnail and the card and opens the .md in the
 * Drive — and B cannot open a file from a private channel they're not in.
 * Screenshots go to MESSAGES_DEPTH_SHOTS (default test-results/messages-depth).
 */

const DATABASE_URL = process.env.DATABASE_URL?.trim()
test.skip(!DATABASE_URL, 'DATABASE_URL not set — the test sets roles in the test DB')

const SHOTS = process.env.MESSAGES_DEPTH_SHOTS ?? 'test-results/messages-depth'
const GATEWAY_BASE_URL = `http://127.0.0.1:${process.env.MOCK_GATEWAY_PORT ?? 5199}/v1`

let _sql: postgres.Sql | null = null
const sql = () => (_sql ??= postgres(DATABASE_URL!, { prepare: false }))
test.afterAll(async () => {
  await _sql?.end()
})

async function newMember(context: BrowserContext, page: Page, role: 'admin' | 'member', name: string) {
  const { email } = await registerUser(context, page, { emailDomain: 'test.eigen' })
  const rows = await sql()`
    update "user" set role = ${role}, name = ${name}, account_kind = 'production', onboarding_completed = true
    where email = ${email} returning id`
  if (rows.length !== 1) throw new Error(`could not set up ${email}`)
  // P-5: a production member has a complete profile (names + picture) before any shell page.
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
  return { email, id: rows[0].id as string }
}

/** A real 160×100 PNG (a two-colour gradient), built here so the test has no binary fixture. */
function pngBytes(): Buffer {
  const w = 160
  const h = 100
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
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

const conv = (page: Page, title: string) =>
  page.getByTestId('messages-list').locator(`[data-testid="messages-conversation"][data-title="${title}"]`)
const item = (page: Page, text: string) => page.getByTestId('messages-item').filter({ hasText: text })
const threadItem = (page: Page, text: string) => page.getByTestId('thread-item').filter({ hasText: text })

async function post(page: Page, text: string) {
  await page.getByTestId('messages-composer').fill(text)
  await page.getByTestId('messages-composer').press('Enter')
  await expect(item(page, text)).toBeVisible()
}

test('threads, reactions, edit/delete and Drive attachments, live between two members', async ({ browser }) => {
  test.setTimeout(240_000)
  const suffix = Date.now().toString(36)
  const general = `general-${suffix}`
  const secret = `secret-${suffix}`

  const ctxA = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const a = await ctxA.newPage()
  const olga = await newMember(ctxA, a, 'admin', `Olga ${suffix}`)
  const ctxB = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const b = await ctxB.newPage()
  const bea = await newMember(ctxB, b, 'member', `Bea ${suffix}`)

  await a.goto('/messages')
  await expect(a.getByTestId('messages-live')).toHaveAttribute('data-state', 'live')
  await a.getByTestId('messages-new-channel').click()
  await a.locator('#channel-name').fill(general)
  await a.getByTestId('channel-create').click()
  await expect(a.getByTestId('messages-title')).toContainText(general)
  await post(a, 'Plan for the week')

  await b.goto('/messages')
  await expect(b.getByTestId('messages-live')).toHaveAttribute('data-state', 'live')
  await conv(b, general).click()
  await expect(item(b, 'Plan for the week')).toBeVisible()

  // ── 1. Threads: B replies in a thread → A sees the count live, then the reply live in the panel.
  await item(b, 'Plan for the week').hover()
  await item(b, 'Plan for the week').getByTestId('messages-reply').click()
  await expect(b.getByTestId('messages-thread')).toBeVisible()
  await b.getByTestId('thread-composer').fill('I’ll take Monday')
  await b.getByTestId('thread-composer').press('Enter')
  await expect(threadItem(b, 'I’ll take Monday')).toBeVisible()
  // The reply is in the thread, not the main log.
  await expect(item(b, 'I’ll take Monday')).toHaveCount(0)
  await expect(item(a, 'Plan for the week').getByTestId('messages-thread-link')).toContainText('1 reply')
  await item(a, 'Plan for the week').getByTestId('messages-thread-link').click()
  await expect(threadItem(a, 'I’ll take Monday')).toBeVisible()
  await a.getByTestId('thread-composer').fill('Great — I have Tuesday')
  await a.getByTestId('thread-composer').press('Enter')
  await expect(threadItem(b, 'Great — I have Tuesday')).toBeVisible() // live in B's open thread
  await expect(item(b, 'Plan for the week').getByTestId('messages-thread-link')).toContainText('2 replies')
  await b.screenshot({ path: `${SHOTS}/01-thread-live-member.png` })
  await a.screenshot({ path: `${SHOTS}/02-thread-owner.png` })
  await a.getByTestId('messages-thread-close').click()
  await b.getByTestId('messages-thread-close').click()

  // ── 2. Reactions: B reacts 👍 → A sees 1 live; A adds theirs → 2 for both, with who reacted; B toggles off → 1.
  const reaction = (page: Page, emoji: string) =>
    item(page, 'Plan for the week').locator(`[data-testid="messages-reaction"][data-emoji="${emoji}"]`)
  await item(b, 'Plan for the week').hover()
  await item(b, 'Plan for the week').getByTestId('messages-react').click()
  await expect(b.getByTestId('messages-picker')).toBeVisible()
  await b.screenshot({ path: `${SHOTS}/03-reaction-picker.png` })
  await b.locator('[data-testid="messages-picker-emoji"][data-emoji="👍"]').click()
  await expect(reaction(b, '👍')).toHaveAttribute('data-count', '1')
  await expect(reaction(b, '👍')).toHaveAttribute('aria-pressed', 'true')
  await expect(reaction(a, '👍')).toHaveAttribute('data-count', '1')
  await expect(reaction(a, '👍')).toHaveAttribute('aria-pressed', 'false')
  await reaction(a, '👍').click()
  await expect(reaction(a, '👍')).toHaveAttribute('data-count', '2')
  await expect(reaction(b, '👍')).toHaveAttribute('data-count', '2')
  await expect(reaction(b, '👍')).toHaveAttribute('title', `Bea ${suffix} and Olga ${suffix}`)
  await reaction(b, '👍').hover()
  await b.screenshot({ path: `${SHOTS}/04-reactions-live.png` })
  await reaction(b, '👍').click()
  await expect(reaction(a, '👍')).toHaveAttribute('data-count', '1')
  await expect(reaction(a, '👍')).toHaveAttribute('title', `Olga ${suffix}`)

  // ── 3. Edit + delete: B edits and deletes their own; A (admin) moderates one of B's.
  await post(b, 'Meeting at 10')
  await post(b, 'oops wrong channel')
  await post(b, 'buy cheap watches')
  await expect(item(a, 'buy cheap watches')).toBeVisible()
  await item(b, 'Meeting at 10').hover()
  await item(b, 'Meeting at 10').getByTestId('messages-edit-start').click()
  await b.getByTestId('messages-edit-input').fill('Meeting at 11')
  await b.getByTestId('messages-edit-input').press('Enter')
  await expect(item(a, 'Meeting at 11').getByTestId('messages-edited')).toBeVisible()
  await expect(item(a, 'Meeting at 10')).toHaveCount(0)
  // A can't edit B's message; as admin A may delete it.
  await item(a, 'Meeting at 11').hover()
  await expect(item(a, 'Meeting at 11').getByTestId('messages-edit-start')).toHaveCount(0)

  await item(b, 'oops wrong channel').hover()
  await item(b, 'oops wrong channel').getByTestId('messages-delete').click()
  await b.getByTestId('messages-delete-confirm').click()
  await expect(item(b, 'oops wrong channel')).toHaveCount(0)
  await expect(a.getByTestId('messages-deleted')).toHaveCount(1)

  await item(a, 'buy cheap watches').hover()
  await item(a, 'buy cheap watches').getByTestId('messages-delete').click()
  await expect(a.getByRole('dialog')).toContainText('as a moderator')
  await expect(a.getByTestId('messages-delete-confirm')).toBeVisible()
  await a.waitForTimeout(400) // let the dialog's fade-in finish for the screenshot
  await a.screenshot({ path: `${SHOTS}/05-moderation-confirm.png` })
  await a.getByTestId('messages-delete-confirm').click()
  await expect(b.getByTestId('messages-deleted')).toHaveCount(2)
  await expect(item(b, 'buy cheap watches')).toHaveCount(0)
  const audit = await sql()`
    select principal_id, payload from kernel_events
    where type = 'messages.message_moderated' and payload->>'authorId' = ${bea.id} order by ts desc limit 1`
  expect(audit).toHaveLength(1)
  expect(audit[0].principal_id).toBe(olga.id)
  await b.screenshot({ path: `${SHOTS}/06-edit-delete-member.png` })

  // ── 4. Attachments: A attaches an image + a .md in #general.
  await a.getByTestId('messages-file-input').setInputFiles([
    { name: 'mood.png', mimeType: 'image/png', buffer: pngBytes() },
    { name: 'agenda.md', mimeType: 'text/markdown', buffer: Buffer.from('# Weekly agenda\n\n- ship C2\n') },
  ])
  await expect(a.locator('[data-testid="messages-pending-file"][data-status="ready"]')).toHaveCount(2)
  await a.screenshot({ path: `${SHOTS}/07-composer-attachments.png` })
  await a.getByTestId('messages-composer').fill('Files for the week')
  await a.getByTestId('messages-composer').press('Enter')
  const filesMsg = (page: Page) => item(page, 'Files for the week')
  await expect(filesMsg(a).getByTestId('messages-attachment-image')).toBeVisible()

  const thumb = filesMsg(b).locator('[data-testid="messages-attachment-image"] img')
  await expect(thumb).toBeVisible()
  await expect.poll(() => thumb.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(160)
  await expect(filesMsg(b).locator('[data-testid="messages-attachment-file"][data-name="agenda.md"]')).toContainText('agenda.md')
  await b.screenshot({ path: `${SHOTS}/08-member-sees-attachments.png` })

  // The folder is "Messages / #general-…" with the channel's (company) access.
  const folder = await sql()`
    select f.name, p.name as parent from drive_folder f join drive_folder p on p.id = f.parent_id
    join message_drive_folders m on m.folder_id = f.id
    join message_conversations c on c.id::text = m.scope where c.name = ${general}`
  expect(folder).toEqual([{ name: `#${general}`, parent: 'Messages' }])

  await filesMsg(b).locator('[data-testid="messages-attachment-file"][data-name="agenda.md"]').click()
  await expect(b).toHaveURL(/\/drive\/file\//)
  await expect(b.getByTestId('drive-markdown').locator('h1')).toHaveText('Weekly agenda')
  await expect(b.getByTestId('drive-path')).toContainText(`#${general}`)
  await b.screenshot({ path: `${SHOTS}/09-member-opens-md-in-drive.png`, fullPage: true })

  // ── 5. A private channel's file stays private.
  await a.getByTestId('messages-new-channel').click()
  await a.locator('#channel-name').fill(secret)
  await a.getByTestId('channel-private').check()
  await a.getByTestId('channel-create').click()
  await expect(a.getByTestId('messages-title')).toContainText(secret)
  await a.getByTestId('messages-file-input').setInputFiles([
    { name: 'salaries.md', mimeType: 'text/markdown', buffer: Buffer.from('# Salaries\n') },
  ])
  await expect(a.locator('[data-testid="messages-pending-file"][data-status="ready"]')).toHaveCount(1)
  await a.getByTestId('messages-send').click()
  await expect(item(a, '').locator('[data-testid="messages-attachment-file"][data-name="salaries.md"]')).toBeVisible()
  const [secretFile] = await sql()`select id from drive_file where name = 'salaries.md' order by created_at desc limit 1`
  expect((await b.request.get(`/api/drive/files/${secretFile.id}/content`)).status()).toBe(404)
  const denied = await b.goto(`/drive/file/${secretFile.id}`)
  expect(denied?.status()).toBe(404)
  await b.screenshot({ path: `${SHOTS}/10-member-denied-private-file.png` })
  // The owner (and channel members) can.
  expect((await a.request.get(`/api/drive/files/${secretFile.id}/content`)).status()).toBe(200)

  await ctxA.close()
  await ctxB.close()
})
