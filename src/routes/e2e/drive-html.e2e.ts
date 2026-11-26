import { expect, test } from './e2e-test'
import postgres from 'postgres'
import { completeProfileViaApi, profileNames, registerUser } from './test-helpers'

/**
 * HTML in Drive renders as a page (owner, 2026-11-20): a small site in a
 * folder — index.html, css/site.css, app.js — opens as the page itself in a
 * sandboxed frame. Its relative styles and scripts load from the folder; its
 * script runs but has an opaque origin (no app cookies, no app storage), and
 * the frame's link token can't reach files outside the folder. "Source"
 * shows the text. Screenshots go to DRIVE_SHOTS (default test-results/drive).
 */

const DATABASE_URL = process.env.DATABASE_URL?.trim()
test.skip(!DATABASE_URL, 'DATABASE_URL not set — the journey prepares its user in the test DB')
const SHOTS = process.env.DRIVE_SHOTS ?? 'test-results/drive'

let _sql: postgres.Sql | null = null
const sql = () => (_sql ??= postgres(DATABASE_URL!, { prepare: false }))
test.afterAll(async () => {
  await _sql?.end()
})

const INDEX = `<!doctype html>
<html><head><link rel="stylesheet" href="css/site.css"></head>
<body><h1 id="title">Quarterly report</h1><p id="js">script did not run</p><p id="origin"></p><p id="storage"></p><p id="escape"></p>
<script src="app.js"></script></body></html>`
const CSS = 'h1 { color: rgb(200, 30, 30); }'
const JS = `document.getElementById('js').textContent = 'script ran'
document.getElementById('origin').textContent = 'origin:' + self.origin
try { localStorage.getItem('x'); document.getElementById('storage').textContent = 'storage:open' } catch { document.getElementById('storage').textContent = 'storage:blocked' }
fetch('../secret.txt').then((r) => { document.getElementById('escape').textContent = 'escape:' + r.status }, () => { document.getElementById('escape').textContent = 'escape:refused' })`

test('Drive: an HTML file opens as a rendered, sandboxed page with its folder’s styles and scripts', async ({ browser }) => {
  test.setTimeout(120_000)
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  const { email } = await registerUser(ctx, page, { emailDomain: 'test.eigen' })
  const rows = await sql()`update "user" set role = 'member', name = 'Hana Html', account_kind = 'production', onboarding_completed = true where email = ${email} returning id`
  expect(rows).toHaveLength(1)
  await completeProfileViaApi(page, profileNames('Hana Html'))

  const folder = async (parentId: string | null, name: string) => {
    const r = await page.request.post('/api/drive/folders', { data: { parentId, name } })
    expect(r.status()).toBe(200)
    return (await r.json()).id as string
  }
  const upload = async (folderId: string, name: string, mimeType: string, body: string) => {
    const r = await page.request.post('/api/drive/upload', { multipart: { folderId, onConflict: 'fail', file: { name, mimeType, buffer: Buffer.from(body) } } })
    expect(r.status()).toBe(200)
    const out = await r.json()
    expect(out.errors).toEqual([])
    return out.uploaded[0].id as string
  }
  const outer = await folder(null, `Reports ${Date.now()}`)
  await upload(outer, 'secret.txt', 'text/plain', 'not for the page')
  const siteDir = await folder(outer, 'site')
  const css = await folder(siteDir, 'css')
  await upload(css, 'site.css', 'text/css', CSS)
  await upload(siteDir, 'app.js', 'text/javascript', JS)
  const indexId = await upload(siteDir, 'index.html', 'text/html', INDEX)

  await page.goto(`/drive/file/${indexId}`)
  await expect(page.getByTestId('drive-preview')).toHaveAttribute('data-kind', 'html')
  const frameEl = page.getByTestId('drive-html')
  await expect(frameEl).toHaveAttribute('sandbox', 'allow-scripts')
  const frame = page.frameLocator('[data-testid="drive-html"]')
  await expect(frame.locator('#title')).toHaveText('Quarterly report')
  await expect(frame.locator('#title')).toHaveCSS('color', 'rgb(200, 30, 30)')
  await expect(frame.locator('#js')).toHaveText('script ran')
  await expect(frame.locator('#origin')).toHaveText('origin:null')
  await expect(frame.locator('#storage')).toHaveText('storage:blocked')
  // ../secret.txt is outside the folder: the CSP refuses it (or Drive answers 4xx) — never 200.
  await expect(frame.locator('#escape')).toHaveText(/escape:(refused|4\d\d)/)
  await page.screenshot({ path: `${SHOTS}/html-page.png` })

  // The token alone can't climb out of the folder either (server-side check).
  const src = (await frameEl.getAttribute('src'))!
  const token = src.split('/')[4]!
  const anon = await browser.newContext()
  expect((await anon.request.get(new URL(`/api/drive/view/${token}/css/site.css`, page.url()).href)).status()).toBe(200)
  expect((await anon.request.get(new URL(`/api/drive/view/${token}/..%2Fsecret.txt`, page.url()).href)).status()).toBeGreaterThanOrEqual(400)
  expect((await anon.request.get(new URL(`/api/drive/view/${token.slice(0, -2)}xx/index.html`, page.url()).href)).status()).toBe(403)
  await anon.close()

  await page.getByRole('button', { name: 'Source' }).click()
  await expect(page.getByTestId('drive-html-source')).toContainText('<h1 id="title">Quarterly report</h1>')
  await page.screenshot({ path: `${SHOTS}/html-source.png` })
  await ctx.close()
})
