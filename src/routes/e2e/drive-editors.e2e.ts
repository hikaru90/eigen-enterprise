import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import Papa from 'papaparse'
import postgres from 'postgres'
import { registerUser } from './test-helpers'

/**
 * Drive editors (plan/phase-workspace.md D2, W-1 + W-6) with three members:
 * A writes notes.md in the WYSIWYG editor (heading, list, bold) → saved as
 * plain Markdown → B (edit) opens it → "Ada Owner is editing", read-only →
 * B takes over and edits → A's next edit is refused, A sees "taken over"
 * with the unsaved draft kept. V (view only) gets the rendered view, never
 * the editor. CSV: add a column + 2 rows, paste a 2×2 spreadsheet block,
 * reload → persisted, the raw file is valid CSV. Revisions: view an older
 * version and restore it (a new revision). Screenshots go to
 * DRIVE_EDITOR_SHOTS (default test-results/drive-editors) — look at them.
 */

const DATABASE_URL = process.env.DATABASE_URL?.trim()
test.skip(!DATABASE_URL, 'DATABASE_URL not set — the journey prepares its users in the test DB')

const SHOTS = process.env.DRIVE_EDITOR_SHOTS ?? 'test-results/drive-editors'
const GATEWAY_BASE_URL = `http://127.0.0.1:${process.env.MOCK_GATEWAY_PORT ?? 5199}/v1`
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

let _sql: postgres.Sql | null = null
const sql = () => (_sql ??= postgres(DATABASE_URL!, { prepare: false }))
test.afterAll(async () => {
  await _sql?.end()
})

async function newMember(context: BrowserContext, page: Page, role: 'admin' | 'member', name: string): Promise<{ id: string; email: string }> {
  const { email } = await registerUser(context, page, { emailDomain: 'test.eigen' })
  const rows = await sql()`update "user" set role = ${role}, name = ${name}, account_kind = 'production', onboarding_completed = true where email = ${email} returning id`
  if (rows.length !== 1) throw new Error(`could not prepare ${email}`)
  const saved = await page.request.post('/api/onboarding/provider', {
    data: { provider: 'openrouter', baseUrl: GATEWAY_BASE_URL, apiKey: `e2e-key-${Date.now()}`, modelChat: 'mock-chat-model', modelEmbedding: 'mock-embed-model' },
  })
  expect(saved.status()).toBe(200)
  return { id: String(rows[0]!.id), email }
}

async function newDoc(page: Page, kind: 'document' | 'table', name: string): Promise<string> {
  await page.goto('/drive')
  await expect(async () => {
    await page.getByTestId('drive-new').click()
    await expect(page.getByTestId(`drive-new-${kind}`)).toBeVisible({ timeout: 2000 })
  }).toPass()
  await page.getByTestId(`drive-new-${kind}`).click()
  await page.getByTestId('drive-name-input').fill(name)
  await page.getByTestId('drive-name-save').click()
  await expect(page).toHaveURL(/\/drive\/file\//)
  return page.url().split('/').pop()!
}

const saveState = (page: Page) => page.getByTestId('drive-save-state')
async function expectSaved(page: Page) {
  await expect(saveState(page)).toHaveAttribute('data-status', 'saved', { timeout: 20_000 })
  await expect(saveState(page)).toContainText(/Saved \d/)
}
const rawText = async (page: Page, id: string) => {
  const res = await page.request.get(`/api/drive/files/${id}/text`)
  expect(res.status()).toBe(200)
  return ((await res.json()) as { content: string }).content
}

test('Drive editors: Markdown with lock + takeover, CSV grid, revisions', async ({ browser }) => {
  test.setTimeout(300_000)
  const ctxA = await browser.newContext()
  const a = await ctxA.newPage()
  await newMember(ctxA, a, 'admin', 'Ada Owner')
  const ctxB = await browser.newContext()
  const b = await ctxB.newPage()
  const memberB = await newMember(ctxB, b, 'member', 'Ben Member')
  const ctxV = await browser.newContext()
  const v = await ctxV.newPage()
  const memberV = await newMember(ctxV, v, 'member', 'Vic Viewer')

  // ── A writes notes.md in the editor ─────────────────────────────────────
  const notesId = await newDoc(a, 'document', 'notes')
  const share = await a.request.put(`/api/drive/items/file/${notesId}/grants`, {
    data: {
      grants: [
        { subject: { kind: 'user', userId: memberB.id }, level: 'edit' },
        { subject: { kind: 'user', userId: memberV.id }, level: 'view' },
      ],
    },
  })
  expect(share.status()).toBe(200)
  await a.reload()
  const editableA = a.getByTestId('drive-md-editable')
  // Opening is reading: no lock until the first keystroke.
  await expect(a.getByTestId('drive-editor-mode')).toHaveAttribute('data-mode', 'reading')
  await expect(editableA).toHaveAttribute('contenteditable', 'true')
  await editableA.click()
  await a.keyboard.type('Kickoff')
  await expect(a.getByTestId('drive-editor-status-bar')).toContainText('Editing')
  await a.getByTestId('drive-md-h1').click()
  await a.keyboard.press('End')
  await a.keyboard.press('Enter')
  await a.keyboard.type('Plan for the week')
  await a.keyboard.press('Enter')
  await a.getByTestId('drive-md-bullet').click()
  await a.keyboard.press(`${mod}+b`)
  await a.keyboard.type('Scope')
  await a.keyboard.press(`${mod}+b`)
  await a.keyboard.type(' agreed')
  await a.keyboard.press('Enter')
  await a.keyboard.type('Budget in the CSV')
  await expectSaved(a)
  await expect(editableA.locator('h1')).toHaveText('Kickoff')
  await expect(editableA.locator('ul li')).toHaveCount(2)
  await expect(editableA.locator('strong')).toHaveText('Scope')
  const md = await rawText(a, notesId)
  expect(md).toMatch(/^# Kickoff\n\nPlan for the week\n\n[-*] \*\*Scope\*\* agreed\n\n?[-*] Budget in the CSV\n?$/)
  await a.screenshot({ path: `${SHOTS}/01-a-editing-markdown.png`, fullPage: true })

  // ── V (view only) never gets the editor ─────────────────────────────────
  await v.goto(`/drive/file/${notesId}`)
  await expect(v.getByTestId('drive-markdown').locator('h1')).toHaveText('Kickoff')
  await expect(v.getByTestId('drive-file')).toContainText('view only')
  await expect(v.getByTestId('drive-md-toolbar')).toHaveCount(0)
  await expect(v.getByTestId('drive-md-editable')).toHaveCount(0)
  await expect(v.getByTestId('drive-revision-restore')).toHaveCount(0)
  expect((await v.request.post(`/api/drive/files/${notesId}/lock`, { data: { session: 'viewer-session-1' } })).status()).toBe(403)
  await v.screenshot({ path: `${SHOTS}/02-v-view-only.png`, fullPage: true })

  // ── B opens it: A is editing → read-only + Take over ────────────────────
  await b.goto(`/drive/file/${notesId}`)
  await expect(b.getByTestId('drive-lock-banner')).toBeVisible()
  await expect(b.getByTestId('drive-lock-holder')).toHaveText('Ada Owner')
  await expect(b.getByTestId('drive-md-editable')).toHaveAttribute('contenteditable', 'false')
  await expect(b.getByTestId('drive-md-editable').locator('h1')).toHaveText('Kickoff')
  await b.screenshot({ path: `${SHOTS}/03-b-sees-a-editing.png`, fullPage: true })

  await b.getByTestId('drive-takeover').click()
  await expect(b.getByTestId('drive-lock-banner')).toHaveCount(0)
  await expect(b.getByTestId('drive-editor-status-bar')).toContainText('Editing')
  const editableB = b.getByTestId('drive-md-editable')
  await expect(editableB).toHaveAttribute('contenteditable', 'true')
  await editableB.locator('h1').click()
  await b.keyboard.press('End')
  await b.keyboard.type(' (Ben)')
  await expectSaved(b)
  expect(await rawText(b, notesId)).toMatch(/^# Kickoff \(Ben\)\n/)
  await b.screenshot({ path: `${SHOTS}/04-b-took-over.png`, fullPage: true })

  // ── A's next edit is refused: taken over, the draft is kept ─────────────
  await editableA.locator('p').first().click()
  await a.keyboard.press('End')
  await a.keyboard.type(' — A was still typing')
  await expect(a.getByTestId('drive-lost-banner')).toBeVisible({ timeout: 20_000 })
  await expect(a.getByTestId('drive-lost-banner')).toContainText('Ben Member took over editing')
  await expect(a.getByTestId('drive-lost-draft')).toHaveValue(/A was still typing/)
  await expect(editableA).toHaveAttribute('contenteditable', 'false')
  expect(await a.evaluate((id) => localStorage.getItem(`drive-draft:${id}`), notesId)).toMatch(/A was still typing/)
  expect(await rawText(a, notesId)).not.toMatch(/A was still typing/)
  await a.screenshot({ path: `${SHOTS}/05-a-taken-over.png`, fullPage: true })

  // ── Revisions: view an older version, restore it ────────────────────────
  const revs = b.getByTestId('drive-revision')
  const before = await revs.count()
  expect(before).toBe(2)
  await expect(revs.first()).toContainText('Ben Member')
  // One revision per editing session (A's, then B's); the empty new document is none.
  await revs.nth(before - 1).getByTestId('drive-revision-view').click()
  await expect(b.getByTestId('drive-revision-dialog')).toBeVisible()
  await expect(b.getByTestId('drive-revision-dialog')).toContainText('Ada Owner')
  await b.screenshot({ path: `${SHOTS}/06-b-view-revision.png`, fullPage: true })
  const older = await (await b.request.get(`/api/drive/files/${notesId}/revisions`)).json()
  const olderId = (older as { revisions: Array<{ id: string }> }).revisions[before - 1]!.id
  const olderText = ((await (await b.request.get(`/api/drive/files/${notesId}/revisions/${olderId}`)).json()) as { content: string }).content
  await b.getByTestId('drive-revision-dialog-restore').click()
  await expect(b.getByTestId('drive-revision-dialog')).toBeHidden()
  await expect(revs).toHaveCount(before + 1)
  await expect(revs.first().getByTestId('drive-revision-restored-from')).toContainText('Restored from Ada Owner')
  await expect.poll(() => rawText(b, notesId)).toBe(olderText)
  await expect(b.getByTestId('drive-md-editable').locator('h1')).not.toContainText('(Ben)')
  await b.screenshot({ path: `${SHOTS}/07-b-restored.png`, fullPage: true })

  // ── CSV: B makes a table ────────────────────────────────────────────────
  const tableId = await newDoc(b, 'table', 'budget')
  await expect(b.getByTestId('drive-editor-mode')).toHaveAttribute('data-mode', 'reading')
  const cell = (r: number, c: number) => b.locator(`textarea[data-testid="drive-csv-cell"][data-r="${r}"][data-c="${c}"]`)
  await expect(cell(0, 0)).toHaveValue('Column 1')
  // Header row.
  await cell(0, 0).fill('Item')
  await cell(0, 1).fill('Qty')
  await cell(0, 2).fill('Price')
  // Add a column right of "Price" and name it.
  await cell(0, 2).click()
  await b.getByTestId('drive-csv-addColumn').click()
  await expect(cell(0, 3)).toBeFocused()
  await cell(0, 3).fill('Note, with comma')
  // Two rows (the new table has one empty row).
  await cell(1, 0).click()
  await b.getByTestId('drive-csv-addRow').click()
  await b.getByTestId('drive-csv-addRow').click()
  await expect(b.getByTestId('drive-csv-row')).toHaveCount(4)
  await cell(1, 0).fill('Apples')
  await cell(1, 3).fill('say "fresh"\nand local')
  // Keyboard: Tab moves right, Enter moves down.
  await cell(1, 0).click()
  await b.keyboard.press('Tab')
  await expect(cell(1, 1)).toBeFocused()
  await b.keyboard.press('Enter')
  await expect(cell(2, 1)).toBeFocused()
  // Paste a 2×2 block copied from a spreadsheet at B3 (row 3, column B).
  await cell(2, 1).click()
  await cell(2, 1).evaluate((el) => {
    const data = new DataTransfer()
    data.setData('text/plain', '12\t0.50\r\n7\t1.20\r\n')
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  })
  await expect(cell(2, 1)).toHaveValue('12')
  await expect(cell(3, 2)).toHaveValue('1.20')
  await expectSaved(b)
  await b.screenshot({ path: `${SHOTS}/08-b-csv-edited.png`, fullPage: true })

  await b.reload()
  await expect(cell(0, 3)).toHaveValue('Note, with comma')
  await expect(cell(1, 3)).toHaveValue('say "fresh"\nand local')
  await expect(cell(3, 1)).toHaveValue('7')
  const csv = await rawText(b, tableId)
  const parsed = Papa.parse<string[]>(csv, { delimiter: ',', skipEmptyLines: true })
  expect(parsed.errors).toEqual([])
  expect(parsed.data).toEqual([
    ['Item', 'Qty', 'Price', 'Note, with comma'],
    ['Apples', '', '', 'say "fresh"\nand local'],
    ['', '12', '0.50', ''],
    ['', '7', '1.20', ''],
  ])
  expect(csv).toContain('"Note, with comma"')
  expect(csv).toContain('"say ""fresh""\nand local"')
  expect(csv.endsWith('\r\n')).toBe(true)
  await b.screenshot({ path: `${SHOTS}/09-b-csv-after-reload.png`, fullPage: true })

  // CSV revisions: one per editing session — the reload ended the first one.
  const csvRevs = b.getByTestId('drive-revision')
  await expect(csvRevs).toHaveCount(1)
  await cell(1, 0).fill('Pears')
  await expectSaved(b)
  await expect(csvRevs).toHaveCount(2)
  await csvRevs.last().getByTestId('drive-revision-restore').click()
  await expect(csvRevs).toHaveCount(3)
  await expect(cell(1, 0)).toHaveValue('Apples')
  await b.screenshot({ path: `${SHOTS}/10-b-csv-restored.png`, fullPage: true })

  await ctxA.close()
  await ctxB.close()
  await ctxV.close()
})
