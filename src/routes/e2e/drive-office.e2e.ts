import { expect, test, type Page } from '@playwright/test'
import postgres from 'postgres'
import { buildDocx, p, r, sectPr } from '../../lib/office/docx/test-utils/builder'
import { makePdf } from '../../lib/office/pdf/fixtures'
import { buildPptx, para, sp, xfrm } from '../../lib/office/pptx/test-utils/build-pptx'
import { completeProfileViaApi, gotoHydrated, profileNames, registerUser } from './test-helpers'

/**
 * Office files in the Drive (plan/phase-office-files.md): a member uploads a
 * PDF, a Word document and a PowerPoint deck; each opens in the Drive's own
 * viewer; the agent's read returns each file's text as Markdown; a binary
 * save keeps a revision. Screenshots go to DRIVE_SHOTS (default
 * test-results/drive-office).
 */

const DATABASE_URL = process.env.DATABASE_URL?.trim()
test.skip(!DATABASE_URL, 'DATABASE_URL not set — the journey prepares its users in the test DB')

const SHOTS = process.env.DRIVE_SHOTS ?? 'test-results/drive-office'

let _sql: postgres.Sql | null = null
const sql = () => (_sql ??= postgres(DATABASE_URL!, { prepare: false }))
test.afterAll(async () => {
  await _sql?.end()
})

const row = (page: Page, name: string) => page.locator(`[data-testid="drive-row"][data-name="${name}"]`)

test('Drive: PDF, Word and PowerPoint open in their own viewers and read as text', async ({ browser }) => {
  test.setTimeout(180_000)
  const stamp = Date.now()
  const names = { pdf: `brief-${stamp}.pdf`, docx: `letter-${stamp}.docx`, pptx: `pitch-${stamp}.pptx` }
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  const { email } = await registerUser(ctx, page, { emailDomain: 'test.eigen' })
  const rows = await sql()`update "user" set role = 'admin', name = 'Ada Owner', account_kind = 'production', onboarding_completed = true where email = ${email} returning id`
  expect(rows).toHaveLength(1)
  await completeProfileViaApi(page, profileNames('Ada Owner'))

  const pdf = await makePdf([{ lines: ['Revenue grew in the third quarter'] }, { lines: ['Next steps'] }], { title: 'Quarterly brief' })
  const docx = buildDocx({ body: p(r('Dear team, the office viewers are live.')) + sectPr() })
  const pptx = buildPptx({
    slides: [{ shapes: sp({ id: 2, name: 'Title', ph: '<p:ph type="title"/>', xfrm: xfrm(457200, 457200, 8229600, 1143000), body: para('Our pitch') }), notes: ['Open with the customer story'] }],
  })

  await gotoHydrated(page, '/drive')
  await page.getByTestId('drive-upload-input').setInputFiles([
    { name: names.pdf, mimeType: 'application/pdf', buffer: Buffer.from(pdf) },
    { name: names.docx, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from(docx) },
    { name: names.pptx, mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', buffer: Buffer.from(pptx) },
  ])
  await expect(page.getByTestId('drive-notice')).toHaveText('Uploaded 3 files.')

  // PDF: the Drive's own viewer, not the browser's.
  await row(page, names.pdf).getByTestId('drive-open').click()
  await expect(page.getByTestId('pdf-viewer')).toHaveAttribute('data-status', 'ready')
  await expect(page.getByTestId('drive-pdf')).toHaveCount(0)
  await page.screenshot({ path: `${SHOTS}/01-pdf-viewer.png`, fullPage: true })
  const pdfId = page.url().split('/').pop()!

  await page.goBack()
  await row(page, names.docx).getByTestId('drive-open').click()
  await expect(page.getByTestId('docx-viewer')).toContainText('Dear team, the office viewers are live.')
  await page.screenshot({ path: `${SHOTS}/02-docx-viewer.png`, fullPage: true })
  const docxId = page.url().split('/').pop()!

  await page.goBack()
  await row(page, names.pptx).getByTestId('drive-open').click()
  await expect(page.getByTestId('pptx-slide').first()).toContainText('Our pitch')
  await page.screenshot({ path: `${SHOTS}/03-pptx-viewer.png`, fullPage: true })
  const pptxId = page.url().split('/').pop()!

  // What the agent reads (drive.read): each file's text as Markdown.
  const text = async (id: string) => {
    const res = await page.request.get(`/api/drive/files/${id}/text`)
    expect(res.status()).toBe(200)
    return ((await res.json()) as { content: string }).content
  }
  expect(await text(pdfId)).toContain('Revenue grew in the third quarter')
  expect(await text(docxId)).toContain('Dear team, the office viewers are live.')
  const deck = await text(pptxId)
  expect(deck).toContain('Our pitch')
  expect(deck).toContain('Open with the customer story')

  // A binary save keeps a revision; bytes of another format are refused.
  const put = (id: string, body: Uint8Array) =>
    page.request.put(`/api/drive/files/${id}/content`, { headers: { 'content-type': 'application/octet-stream' }, data: Buffer.from(body) })
  expect((await put(docxId, docx)).status()).toBe(200)
  expect((await put(docxId, pdf)).status()).toBe(400)
  const revs = await page.request.get(`/api/drive/files/${docxId}/revisions`)
  const versions = ((await revs.json()) as { revisions: Array<{ id: string }> }).revisions
  expect(versions).toHaveLength(2)
  // An earlier version downloads as that file.
  const older = await page.request.get(`/api/drive/files/${docxId}/content?revision=${versions[1]!.id}`)
  expect(older.status()).toBe(200)
  expect(older.headers()['content-disposition']).toMatch(/^attachment; filename\*=UTF-8''letter-\d+%20\(version%20/)
  // The file page lists the versions beside the viewer.
  await gotoHydrated(page, `/drive/file/${docxId}`)
  await expect(page.getByTestId('drive-revision-download')).toHaveCount(2)

  await ctx.close()
})
