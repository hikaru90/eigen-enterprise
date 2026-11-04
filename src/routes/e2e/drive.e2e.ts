import { deflateSync } from 'node:zlib'
import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import postgres from 'postgres'
import { completeProfileViaApi, profileNames, registerUser } from './test-helpers'

/**
 * Drive core (plan/phase-workspace.md D1) with TWO members in two browser
 * contexts: A creates "Projects", uploads a PDF and an image, creates
 * notes.md, shares the folder with B (view) → B finds it under "Shared with
 * me", opens and previews, but can't rename or trash (UI hides it, the
 * server refuses it) → A raises B to edit → B renames. Screenshots go to
 * DRIVE_SHOTS (default test-results/drive) and are meant to be looked at.
 */

const DATABASE_URL = process.env.DATABASE_URL?.trim()
test.skip(!DATABASE_URL, 'DATABASE_URL not set — the journey prepares its users in the test DB')

const SHOTS = process.env.DRIVE_SHOTS ?? 'test-results/drive'
const GATEWAY_BASE_URL = `http://127.0.0.1:${process.env.MOCK_GATEWAY_PORT ?? 5199}/v1`

let _sql: postgres.Sql | null = null
const sql = () => (_sql ??= postgres(DATABASE_URL!, { prepare: false }))
test.afterAll(async () => {
  await _sql?.end()
})

async function newMember(context: BrowserContext, page: Page, role: 'admin' | 'member', name: string): Promise<{ id: string; email: string }> {
  const { email } = await registerUser(context, page, { emailDomain: 'test.eigen' })
  const rows = await sql()`update "user" set role = ${role}, name = ${name}, account_kind = 'production', onboarding_completed = true where email = ${email} returning id`
  if (rows.length !== 1) throw new Error(`could not prepare ${email}`)
  // P-5: a production member has a complete profile (names + picture) before any shell page.
  await completeProfileViaApi(page, profileNames(name))
  {
    const saved = await page.request.post('/api/onboarding/provider', {
      data: { provider: 'openrouter', baseUrl: GATEWAY_BASE_URL, apiKey: `e2e-key-${Date.now()}`, modelChat: 'mock-chat-model', modelEmbedding: 'mock-embed-model' },
    })
    expect(saved.status()).toBe(200)
  }
  return { id: String(rows[0]!.id), email }
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

/** A minimal valid one-page PDF saying "Drive PDF preview". */
function pdfBytes(): Buffer {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  const stream = 'BT /F1 18 Tf 40 100 Td (Drive PDF preview) Tj ET'
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objs.forEach((o, i) => {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${o}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

const row = (page: Page, name: string) => page.locator(`[data-testid="drive-row"][data-name="${name}"]`)

async function nameDialog(page: Page, value: string) {
  const input = page.getByTestId('drive-name-input')
  await expect(input).toBeVisible()
  await input.fill(value)
  await page.getByTestId('drive-name-save').click()
}

test('Drive: two members — create, upload, share view → edit, preview, rename', async ({ browser }) => {
  test.setTimeout(240_000)
  // Admins see every file in search: a per-run name keeps earlier runs' files out of the assertion.
  const renamed = `kickoff-${Date.now()}.md`
  const ctxA = await browser.newContext()
  const a = await ctxA.newPage()
  await newMember(ctxA, a, 'admin', 'Ada Owner')
  const ctxB = await browser.newContext()
  const b = await ctxB.newPage()
  const memberB = await newMember(ctxB, b, 'member', 'Ben Member')

  // A: Drive from the nav, one page frame, storage shown.
  await a.goto('/')
  await a.getByTestId('shell-sidebar').getByTestId('shell-nav-drive').click()
  await expect(a).toHaveURL(/\/drive$/)
  await expect(a.getByTestId('drive-tab-mine')).toHaveAttribute('aria-current', 'page')
  await expect(a.getByTestId('module-status')).toHaveText(/Active/)
  await expect(a.getByTestId('drive-storage')).toHaveText(/used/)
  await expect(a).toHaveTitle(/My drive · Drive · eigenEnterprise/)

  // New → Folder "Projects".
  await a.getByTestId('drive-new').click()
  await a.getByTestId('drive-new-folder').click()
  await nameDialog(a, 'Projects')
  await expect(row(a, 'Projects')).toBeVisible()
  await row(a, 'Projects').getByTestId('drive-open').click()
  await expect(a).toHaveURL(/\/drive\/folder\//)
  const folderUrl = a.url()
  await expect(a.getByTestId('drive-path')).toContainText('Projects')

  // Upload a PDF and an image (multiple at once).
  await a.getByTestId('drive-upload-input').setInputFiles([
    { name: 'brief.pdf', mimeType: 'application/pdf', buffer: pdfBytes() },
    { name: 'mood.png', mimeType: 'image/png', buffer: pngBytes() },
  ])
  await expect(a.getByTestId('drive-notice')).toHaveText('Uploaded 2 files.')
  await expect(row(a, 'brief.pdf')).toBeVisible()
  await expect(row(a, 'mood.png')).toBeVisible()

  // New → Document "notes" → opens /drive/file/[id].
  await a.getByTestId('drive-new').click()
  await a.getByTestId('drive-new-document').click()
  await nameDialog(a, 'notes')
  await expect(a).toHaveURL(/\/drive\/file\//)
  await expect(a.getByTestId('drive-file')).toContainText('notes.md')
  await expect(a.getByTestId('drive-revision')).toHaveCount(0)
  await expect(a.getByTestId('drive-revisions')).toContainText('No revisions yet.')
  const notesUrl = a.url()
  const notesId = notesUrl.split('/').pop()!
  // Give notes.md content through the text API — a revision. The open editor
  // holds the edit lock (D2, W-6), so leave the page first: a write without
  // an editor session waits until nobody is editing.
  await a.goto('about:blank')
  await expect
    .poll(async () => (await a.request.put(`/api/drive/files/${notesId}/text`, { data: { content: '# Kickoff\n\n- **Scope** agreed\n- Budget in the CSV\n' } })).status(), { timeout: 60_000 })
    .toBe(200)
  await a.goto(notesUrl)
  await expect(a.getByTestId('drive-markdown').locator('h1')).toHaveText('Kickoff')
  await expect(a.getByTestId('drive-revision')).toHaveCount(1)
  await a.screenshot({ path: `${SHOTS}/01-owner-notes-preview.png`, fullPage: true })

  await a.goto(folderUrl)
  await expect(a.getByTestId('drive-row')).toHaveCount(3)
  await a.screenshot({ path: `${SHOTS}/02-owner-projects-folder.png`, fullPage: true })

  // B sees nothing yet; the folder itself is a 404 for them.
  await b.goto('/drive/shared')
  // (Not "empty": public channels' attachment folders — Messages / #channel, C2 — are shared with everyone.)
  await expect(b.getByRole('heading', { name: 'Drive', exact: true })).toBeVisible()
  await expect(row(b, 'Projects')).toHaveCount(0)
  expect((await b.request.get(`/api/drive/files/${notesId}/text`)).status()).toBe(404)

  // A shares Projects with B: view.
  await a.goto('/drive')
  await row(a, 'Projects').getByTestId('drive-share').click()
  await expect(a.getByTestId('drive-share-dialog')).toBeVisible()
  await a.getByTestId('drive-share-pick').selectOption(`user:${memberB.id}`)
  await a.getByTestId('drive-share-pick-level').selectOption('view')
  await a.getByTestId('drive-share-add').click()
  // The creator's own manage grant (initializeGrants on create) + B.
  await expect(a.getByTestId('drive-share-row')).toHaveCount(2)
  await a.screenshot({ path: `${SHOTS}/03-owner-share-dialog.png` })
  await a.getByTestId('drive-share-save').click()
  await expect(a.getByTestId('drive-share-dialog')).toBeHidden()

  // B: Shared with me → Projects → previews; no rename/trash/share offered.
  await b.goto('/drive/shared')
  await expect(b.getByTestId('drive-tab-shared')).toHaveAttribute('aria-current', 'page')
  await expect(row(b, 'Projects')).toBeVisible()
  await expect(row(b, 'Projects').getByTestId('drive-rename')).toHaveCount(0)
  await b.screenshot({ path: `${SHOTS}/04-member-shared-with-me.png`, fullPage: true })
  await row(b, 'Projects').getByTestId('drive-open').click()
  await expect(b.getByTestId('drive-row')).toHaveCount(3)
  await expect(b.getByTestId('drive-new')).toHaveCount(0)
  for (const name of ['brief.pdf', 'mood.png', 'notes.md']) {
    await expect(row(b, name).getByTestId('drive-rename')).toHaveCount(0)
    await expect(row(b, name).getByTestId('drive-trash')).toHaveCount(0)
    await expect(row(b, name).getByTestId('drive-download')).toBeVisible()
  }
  await b.screenshot({ path: `${SHOTS}/05-member-folder-view-only.png`, fullPage: true })

  await row(b, 'notes.md').getByTestId('drive-open').click()
  await expect(b.getByTestId('drive-markdown').locator('h1')).toHaveText('Kickoff')
  await expect(b.getByTestId('drive-file')).toContainText('view only')
  await expect(b.getByTestId('drive-revision-restore')).toHaveCount(0)
  await b.screenshot({ path: `${SHOTS}/06-member-notes-preview.png`, fullPage: true })

  await b.goBack()
  await row(b, 'mood.png').getByTestId('drive-open').click()
  const img = b.getByTestId('drive-image')
  await expect(img).toBeVisible()
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(160)
  await b.screenshot({ path: `${SHOTS}/07-member-image-preview.png`, fullPage: true })

  await b.goBack()
  await row(b, 'brief.pdf').getByTestId('drive-open').click()
  await expect(b.getByTestId('drive-pdf')).toBeVisible()
  const pdfRes = await b.request.get(`/api/drive/files/${b.url().split('/').pop()}/content`)
  expect(pdfRes.status()).toBe(200)
  expect(pdfRes.headers()['content-type']).toBe('application/pdf')
  await b.waitForTimeout(1500)
  await b.screenshot({ path: `${SHOTS}/08-member-pdf-preview.png`, fullPage: true })

  // The server refuses B's writes too (not only the hidden buttons).
  expect((await b.request.patch(`/api/drive/items/file/${notesId}`, { data: { name: 'hacked.md' } })).status()).toBe(403)
  expect((await b.request.delete(`/api/drive/items/file/${notesId}`)).status()).toBe(403)
  expect((await b.request.put(`/api/drive/files/${notesId}/text`, { data: { content: 'x' } })).status()).toBe(403)

  // A raises B to edit.
  await a.goto('/drive')
  // Right after a navigation the page may still be hydrating: retry the click until the dialog is up.
  await expect(async () => {
    await row(a, 'Projects').getByTestId('drive-share').click()
    await expect(a.getByTestId('drive-share-dialog')).toBeVisible({ timeout: 2000 })
  }).toPass()
  await expect(a.getByTestId('drive-share-row')).toHaveCount(2)
  await a.getByTestId('drive-share-row').filter({ hasText: memberB.email }).getByTestId('drive-share-level').selectOption('edit')
  await a.getByTestId('drive-share-save').click()
  await expect(a.getByTestId('drive-share-dialog')).toBeHidden()

  // B can now rename notes.md.
  await b.goto(folderUrl)
  await row(b, 'notes.md').getByTestId('drive-rename').click()
  await nameDialog(b, renamed)
  await expect(b.getByTestId('drive-notice')).toHaveText(`Renamed to “${renamed}”.`)
  await expect(row(b, renamed)).toBeVisible()
  await expect(row(b, renamed).getByTestId('drive-share')).toHaveCount(0)
  await b.screenshot({ path: `${SHOTS}/09-member-renamed-with-edit.png`, fullPage: true })

  // A sees B's rename; search finds it.
  await a.goto(`/drive?q=${encodeURIComponent(renamed.slice(0, -3))}`)
  await expect(row(a, renamed)).toBeVisible()
  await a.screenshot({ path: `${SHOTS}/10-owner-search.png`, fullPage: true })

  await ctxA.close()
  await ctxB.close()
})
