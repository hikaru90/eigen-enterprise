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

test('Drive: PDF, Word and PowerPoint edits save, reopen changed, and keep a revision', async ({ browser }) => {
  test.setTimeout(240_000)
  const stamp = Date.now()
  const names = { pdf: `organise-${stamp}.pdf`, docx: `minutes-${stamp}.docx`, pptx: `deck-${stamp}.pptx` }
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  const { email } = await registerUser(ctx, page, { emailDomain: 'test.eigen' })
  const rows = await sql()`update "user" set role = 'admin', name = 'Ed Owner', account_kind = 'production', onboarding_completed = true where email = ${email} returning id`
  expect(rows).toHaveLength(1)
  await completeProfileViaApi(page, profileNames('Ed Owner'))

  const pdf = await makePdf([{ lines: ['Revenue grew in the third quarter'] }, { lines: ['Next steps'] }], { title: 'Quarterly brief' })
  const docx = buildDocx({ body: p(r('Dear team, the office viewers are live.')) + sectPr() })
  const pptx = buildPptx({
    slides: [{ shapes: sp({ id: 2, name: 'Title', ph: '<p:ph type="title"/>', xfrm: xfrm(457200, 457200, 8229600, 1143000), body: para('Our pitch') }) }],
  })

  await gotoHydrated(page, '/drive')
  await page.getByTestId('drive-upload-input').setInputFiles([
    { name: names.pdf, mimeType: 'application/pdf', buffer: Buffer.from(pdf) },
    { name: names.docx, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from(docx) },
    { name: names.pptx, mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', buffer: Buffer.from(pptx) },
  ])
  await expect(page.getByTestId('drive-notice')).toHaveText('Uploaded 3 files.')

  const revisions = async (id: string) => {
    const res = await page.request.get(`/api/drive/files/${id}/revisions`)
    expect(res.status()).toBe(200)
    return (((await res.json()) as { revisions: Array<{ id: string }> }).revisions).length
  }
  const text = async (id: string) => {
    const res = await page.request.get(`/api/drive/files/${id}/text`)
    expect(res.status()).toBe(200)
    return ((await res.json()) as { content: string }).content
  }

  // PDF: organise — delete the first page, save (one revision), reopen with one page left.
  await row(page, names.pdf).getByTestId('drive-open').click()
  await expect(page.getByTestId('pdf-viewer')).toHaveAttribute('data-status', 'ready')
  await expect(page.getByTestId('pdf-page-count')).toHaveText('of 2')
  const pdfId = page.url().split('/').pop()!
  await page.getByTestId('pdf-organise').click()
  await expect(page.getByTestId('pdf-org-page')).toHaveCount(2)
  await page.getByTestId('pdf-org-page').first().click()
  await page.getByTestId('pdf-org-delete').click()
  await expect(page.getByTestId('pdf-org-page')).toHaveCount(1)
  await page.getByTestId('pdf-org-save').click()
  // Saving closes the organiser; the viewer reopens the new bytes itself.
  await expect(page.getByTestId('pdf-organiser')).toHaveCount(0)
  await expect(page.getByTestId('pdf-viewer')).toHaveAttribute('data-status', 'ready')
  await expect(page.getByTestId('pdf-page-count')).toHaveText('of 1')
  await page.screenshot({ path: `${SHOTS}/04-pdf-organised.png`, fullPage: true })
  expect(await revisions(pdfId)).toBe(2)
  expect(await text(pdfId)).not.toContain('Revenue grew')
  expect(await text(pdfId)).toContain('Next steps')
  await gotoHydrated(page, `/drive/file/${pdfId}`)
  await expect(page.getByTestId('pdf-viewer')).toHaveAttribute('data-status', 'ready')
  await expect(page.getByTestId('pdf-page-count')).toHaveText('of 1')

  // Word: edit the paragraph in the flowing Edit layout; the autosave writes one revision.
  await page.goBack()
  await row(page, names.docx).getByTestId('drive-open').click()
  await expect(page.getByTestId('docx-viewer')).toContainText('Dear team, the office viewers are live.')
  const docxId = page.url().split('/').pop()!
  await page.getByTestId('docx-edit').click()
  const surface = page.locator('.docx-edit-surface')
  await expect(surface).toBeVisible()
  // A triple click selects the paragraph; typing replaces it.
  await surface.click({ clickCount: 3 })
  await page.keyboard.type('Dear team, the office viewers are live. Now they edit.')
  await expect(page.getByTestId('docx-save-state')).toHaveAttribute('data-status', 'saved', { timeout: 30_000 })
  await page.screenshot({ path: `${SHOTS}/05-docx-editing.png`, fullPage: true })
  await page.getByTestId('docx-done').click()
  await expect(page.getByTestId('docx-viewer')).toContainText('Now they edit.')
  expect(await revisions(docxId)).toBe(2)
  expect(await text(docxId)).toContain('Now they edit.')
  await gotoHydrated(page, `/drive/file/${docxId}`)
  await expect(page.getByTestId('docx-viewer')).toContainText('Now they edit.')

  // PowerPoint: double-click the title, type, Escape; the autosave writes one revision.
  await page.goBack()
  await row(page, names.pptx).getByTestId('drive-open').click()
  await expect(page.getByTestId('pptx-slide').first()).toContainText('Our pitch')
  const pptxId = page.url().split('/').pop()!
  await page.getByTestId('pptx-edit').click()
  await page.locator('[data-testid="pptx-hit"][aria-label="Title"]').dblclick()
  const titleEditor = page.getByTestId('pptx-text-editor')
  await expect(titleEditor).toHaveAttribute('contenteditable', 'true')
  await page.keyboard.type(' — edited')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('pptx-save-state')).toHaveAttribute('data-status', 'saved', { timeout: 30_000 })
  await page.screenshot({ path: `${SHOTS}/06-pptx-edited.png`, fullPage: true })
  await page.getByTestId('pptx-done').click()
  await expect(page.getByTestId('pptx-slide').first()).toContainText('Our pitch — edited')
  expect(await revisions(pptxId)).toBe(2)
  expect(await text(pptxId)).toContain('Our pitch — edited')
  await gotoHydrated(page, `/drive/file/${pptxId}`)
  await expect(page.getByTestId('pptx-slide').first()).toContainText('Our pitch — edited')

  await ctx.close()
})

test('Drive: a PDF note, a Word comment and a PowerPoint comment save, reopen, and read as text', async ({ browser }) => {
  test.setTimeout(240_000)
  const stamp = Date.now()
  const names = { pdf: `notes-${stamp}.pdf`, docx: `review-${stamp}.docx`, pptx: `talk-${stamp}.pptx` }
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  const { email } = await registerUser(ctx, page, { emailDomain: 'test.eigen' })
  const rows = await sql()`update "user" set role = 'admin', name = 'Ada Owner', account_kind = 'production', onboarding_completed = true where email = ${email} returning id`
  expect(rows).toHaveLength(1)
  await completeProfileViaApi(page, profileNames('Ada Owner'))

  const pdf = await makePdf([{ lines: ['Revenue grew in the third quarter'] }], { title: 'Quarterly brief' })
  const docx = buildDocx({ body: p(r('Dear team, the office viewers are live.')) + sectPr() })
  const pptx = buildPptx({
    slides: [{ shapes: sp({ id: 2, name: 'Title', ph: '<p:ph type="title"/>', xfrm: xfrm(457200, 457200, 8229600, 1143000), body: para('Our pitch') }) }],
  })

  await gotoHydrated(page, '/drive')
  await page.getByTestId('drive-upload-input').setInputFiles([
    { name: names.pdf, mimeType: 'application/pdf', buffer: Buffer.from(pdf) },
    { name: names.docx, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from(docx) },
    { name: names.pptx, mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', buffer: Buffer.from(pptx) },
  ])
  await expect(page.getByTestId('drive-notice')).toHaveText('Uploaded 3 files.')

  const revisions = async (id: string) => {
    const res = await page.request.get(`/api/drive/files/${id}/revisions`)
    expect(res.status()).toBe(200)
    return (((await res.json()) as { revisions: Array<{ id: string }> }).revisions).length
  }
  const text = async (id: string) => {
    const res = await page.request.get(`/api/drive/files/${id}/text`)
    expect(res.status()).toBe(200)
    return ((await res.json()) as { content: string }).content
  }

  // PDF: Annotate, place a sticky note on the page, Save (one revision); reopened, the note is there.
  const note = 'Check the Q3 figure with finance'
  await row(page, names.pdf).getByTestId('drive-open').click()
  await expect(page.getByTestId('pdf-viewer')).toHaveAttribute('data-status', 'ready')
  const pdfId = page.url().split('/').pop()!
  await page.getByTestId('pdf-annotate').click()
  await expect(page.getByTestId('pdf-editor')).toHaveAttribute('data-ready', 'true')
  await expect(page.getByTestId('pdf-editor')).toHaveAttribute('data-lock', 'held')
  await page.getByTestId('pdf-edit-mode-annotate').click()
  await expect(page.getByTestId('pdf-editor')).toHaveAttribute('data-mode', 'annotate')
  await page.getByTestId('pdf-tool-Text').click()
  await page.getByTestId('pdf-edit-surface').first().click({ position: { x: 120, y: 120 } })
  await page.getByTestId('pdf-edit-draft').getByRole('textbox', { name: 'Note text' }).fill(note)
  await page.getByTestId('pdf-edit-draft-add').click()
  await expect(page.getByTestId('pdf-comment')).toHaveCount(1)
  await expect(page.getByTestId('pdf-comment').getByTestId('pdf-comment-text')).toHaveText(note)
  await page.getByTestId('pdf-edit-save').click()
  // Saving closes the editor; the viewer reopens the new bytes itself.
  await expect(page.getByTestId('pdf-editor')).toHaveCount(0)
  await expect(page.getByTestId('pdf-viewer')).toHaveAttribute('data-status', 'ready')
  expect(await revisions(pdfId)).toBe(2)
  await gotoHydrated(page, `/drive/file/${pdfId}`)
  await expect(page.getByTestId('pdf-viewer')).toHaveAttribute('data-status', 'ready')
  await page.getByTestId('pdf-annotate').click()
  await expect(page.getByTestId('pdf-editor')).toHaveAttribute('data-ready', 'true')
  await expect(page.getByTestId('pdf-comment')).toHaveCount(1)
  await expect(page.getByTestId('pdf-comment')).toContainText('Ada Owner')
  await expect(page.getByTestId('pdf-comment').getByTestId('pdf-comment-text')).toHaveText(note)
  await page.screenshot({ path: `${SHOTS}/07-pdf-note.png`, fullPage: true })
  await page.getByTestId('pdf-edit-discard').click()
  await expect(page.getByTestId('pdf-editor')).toHaveCount(0)
  const pdfText = await text(pdfId)
  expect(pdfText).toContain(note)
  expect(pdfText).toContain('Ada Owner')

  // Word: in the Edit layout select the paragraph, comment on it; the autosave writes one revision.
  const remark = 'Name the viewers in the first line'
  await gotoHydrated(page, '/drive')
  await row(page, names.docx).getByTestId('drive-open').click()
  await expect(page.getByTestId('docx-viewer')).toContainText('Dear team, the office viewers are live.')
  const docxId = page.url().split('/').pop()!
  await page.getByTestId('docx-edit').click()
  const surface = page.locator('.docx-edit-surface')
  await expect(surface).toBeVisible()
  await surface.click({ clickCount: 3 })
  await page.getByTestId('docx-comments-toggle').click()
  await expect(page.getByTestId('docx-comment-add')).toBeEnabled()
  await page.getByTestId('docx-comment-add').click()
  await page.getByTestId('docx-comment-input').fill(remark)
  await page.getByTestId('docx-comment-save').click()
  await expect(page.getByTestId('docx-comments').getByTestId('docx-comment-text')).toHaveText(remark)
  await expect(page.getByTestId('docx-save-state')).toHaveAttribute('data-status', 'saved', { timeout: 30_000 })
  await page.getByTestId('docx-done').click()
  expect(await revisions(docxId)).toBe(2)
  await gotoHydrated(page, `/drive/file/${docxId}`)
  await expect(page.getByTestId('docx-viewer')).toContainText('Dear team, the office viewers are live.')
  // A document with comments opens with its comments margin showing.
  await expect(page.getByTestId('docx-comments').getByTestId('docx-comment-text')).toHaveText(remark)
  await expect(page.getByTestId('docx-comments').getByTestId('docx-comment-author')).toHaveText('Ada Owner')
  await page.screenshot({ path: `${SHOTS}/08-docx-comment.png`, fullPage: true })
  expect(await text(docxId)).toContain(`> Comment (Ada Owner): ${remark}`)

  // PowerPoint: comment on the slide (commenting starts editing); the autosave writes one revision.
  const ask = 'Add the customer logo here'
  await gotoHydrated(page, '/drive')
  await row(page, names.pptx).getByTestId('drive-open').click()
  await expect(page.getByTestId('pptx-slide').first()).toContainText('Our pitch')
  const pptxId = page.url().split('/').pop()!
  await page.getByTestId('pptx-comments-toggle').click()
  await page.getByTestId('pptx-comment-new').click()
  await page.getByTestId('pptx-comment-text').fill(ask)
  await page.getByTestId('pptx-comment-post').click()
  await expect(page.getByTestId('pptx-thread-text')).toHaveText(ask)
  await expect(page.getByTestId('pptx-comment-marker')).toHaveCount(1)
  await expect(page.getByTestId('pptx-save-state')).toHaveAttribute('data-status', 'saved', { timeout: 30_000 })
  await page.getByTestId('pptx-done').click()
  expect(await revisions(pptxId)).toBe(2)
  await gotoHydrated(page, `/drive/file/${pptxId}`)
  await expect(page.getByTestId('pptx-slide').first()).toContainText('Our pitch')
  await expect(page.getByTestId('pptx-comment-marker')).toHaveCount(1)
  await page.getByTestId('pptx-comments-toggle').click()
  await expect(page.getByTestId('pptx-thread-text')).toHaveText(ask)
  await expect(page.getByTestId('pptx-thread-author')).toHaveText('Ada Owner')
  await page.screenshot({ path: `${SHOTS}/09-pptx-comment.png`, fullPage: true })
  const deck = await text(pptxId)
  expect(deck).toContain(`> Comment (Ada Owner): ${ask}`)

  await ctx.close()
})
