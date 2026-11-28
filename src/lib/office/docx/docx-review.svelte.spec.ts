import { strFromU8, unzipSync } from 'fflate'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page, userEvent } from 'vitest/browser'
import CommentsPanel from './comments-panel.svelte'
import DocxViewer from './docx-viewer.svelte'
import { buildDocx, p, r, sectPr } from './test-utils/builder'

const api = vi.hoisted(() => ({
  readBytes: vi.fn<(id: string) => Promise<Uint8Array>>(),
  acquireLock: vi.fn(),
  heartbeatLock: vi.fn(),
  releaseLock: vi.fn(),
  writeBytes: vi.fn(),
}))
vi.mock('$lib/drive/api', () => {
  class DriveApiError extends Error {
    constructor(
      message: string,
      readonly status: number,
      readonly code: string | null,
      readonly holder: unknown,
    ) {
      super(message)
    }
  }
  return { driveApi: api, DriveApiError }
})

const W14 = 'xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"'
const W15 = 'http://schemas.microsoft.com/office/word/2012/wordml'
const ME = { id: 'u1', name: 'Dana Ruiz' }

/** A document with a two-comment thread on "Revenue grew" and a tracked insertion and deletion. */
function reviewed(settings = '') {
  return buildDocx({
    settings,
    body:
      p(
        `<w:commentRangeStart w:id="0"/>${r('Revenue grew')}<w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r>` +
          `<w:commentRangeStart w:id="1"/><w:commentRangeEnd w:id="1"/><w:r><w:commentReference w:id="1"/></w:r>` +
          `<w:ins w:id="5" w:author="Ann" w:date="2026-11-01T09:00:00Z">${r(' sharply')}</w:ins><w:del w:id="6" w:author="Bo"><w:r><w:delText> slowly</w:delText></w:r></w:del>`,
      ) +
      p(r('Second line')) +
      sectPr(),
    comments:
      `<w:comment w:id="0" w:author="Ann Lee" w:initials="AL" w:date="2026-11-01T10:00:00Z"><w:p w14:paraId="0000000A" ${W14}>${r('Source?')}</w:p></w:comment>` +
      `<w:comment w:id="1" w:author="Dana Ruiz" w:initials="DR" w:date="2026-11-01T11:00:00Z"><w:p w14:paraId="0000000B" ${W14}>${r('Q3 report')}</w:p></w:comment>`,
    parts: {
      rIdEx: {
        type: 'http://schemas.microsoft.com/office/2011/relationships/commentsExtended',
        target: 'commentsExtended.xml',
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.commentsExtended+xml',
        xml: `<w15:commentsEx xmlns:w15="${W15}"><w15:commentEx w15:paraId="0000000A" w15:done="0"/><w15:commentEx w15:paraId="0000000B" w15:paraIdParent="0000000A" w15:done="0"/></w15:commentsEx>`,
      },
    },
  })
}

const part = (bytes: Uint8Array, name: string) => strFromU8(unzipSync(bytes)[name] ?? new Uint8Array())
const saved = () => api.writeBytes.mock.calls.map((c) => c[1] as Uint8Array)
const lastSaved = (name: string) => (saved().length ? part(saved().at(-1)!, name) : '')
const edit = () => page.getByTestId('docx-edit-page')
const surface = () => document.querySelector<HTMLElement>('.docx-edit-surface')!

async function open(props: Record<string, unknown> = {}) {
  render(DocxViewer, { fileId: 'f1', name: 'report.docx', canEdit: true, heartbeatMs: 10_000, saveDelayMs: 30, author: ME, ...props })
  await expect.element(page.getByTestId('docx-page-indicator')).toHaveTextContent(/Page 1 of 1/)
}

async function startEdit() {
  await userEvent.click(page.getByTestId('docx-edit'))
  await expect.element(page.getByTestId('docx-review-bar')).toBeVisible()
}

describe('DocxViewer review', () => {
  beforeEach(() => {
    for (const f of Object.values(api)) f.mockReset()
    api.readBytes.mockResolvedValue(reviewed())
    api.acquireLock.mockResolvedValue({ state: 'held', since: '2026-11-20T10:00:00Z' })
    api.heartbeatLock.mockResolvedValue({ state: 'held', since: '2026-11-20T10:00:00Z' })
    api.releaseLock.mockResolvedValue(undefined)
    api.writeBytes.mockResolvedValue({ file: { id: 'f1', size: 1 } })
  })

  it('shows comments as threads beside the pages, with the commented text highlighted, and changes in colour', async () => {
    await open()
    const panel = page.getByTestId('docx-comments')
    await expect.element(panel).toBeVisible()
    await expect.element(panel.getByTestId('docx-thread')).toHaveTextContent(/Ann Lee.*Source\?.*Dana Ruiz.*Q3 report/)
    const highlighted = document.querySelector<HTMLElement>('[data-testid="docx-scroller"] .docx-comment')
    expect(highlighted?.textContent).toBe('Revenue grew')
    expect(document.querySelector('[data-testid="docx-scroller"] ins.docx-change')?.textContent).toBe(' sharply')
    expect(document.querySelector('[data-testid="docx-scroller"] del.docx-change')?.textContent).toBe(' slowly')
    expect(document.querySelector('[data-testid="docx-scroller"] .docx-changed')).not.toBeNull()
    // Clicking the text selects its thread.
    await userEvent.click(page.getByTestId('docx-scroller').getByText('Revenue grew'))
    await expect.element(panel.getByTestId('docx-thread')).toHaveAttribute('data-active', '1')
    // In the Print layout the panel only reads.
    expect(document.querySelector('[data-testid="docx-comment-reply"]')).toBeNull()
    await expect.element(page.getByTestId('docx-comments-hint')).toHaveTextContent('Choose Edit')
  })

  it('adds a comment on the selection, replies and resolves; each is saved into the file', async () => {
    await open()
    await startEdit()
    await userEvent.tripleClick(edit().getByText('Second line'))
    await userEvent.click(page.getByTestId('docx-comment-add'))
    await userEvent.fill(page.getByTestId('docx-comment-input'), 'Needs a source')
    await userEvent.click(page.getByTestId('docx-comment-save'))
    await expect.element(page.getByTestId('docx-comments').getByText('Needs a source')).toBeVisible()
    await expect.poll(() => lastSaved('word/comments.xml')).toContain('Needs a source')
    expect(lastSaved('word/comments.xml')).toMatch(/w:author="Dana Ruiz"[^>]*w:initials="DR"/)
    expect(lastSaved('word/document.xml')).toMatch(/<w:commentRangeStart w:id="\d+"\/><w:r><w:t xml:space="preserve">Second line<\/w:t><\/w:r><w:commentRangeEnd/)
    // Reply to the first thread, then resolve it.
    const first = page.getByTestId('docx-thread').first()
    await userEvent.click(first.getByTestId('docx-comment-reply'))
    await userEvent.fill(page.getByTestId('docx-comment-input'), 'Found it')
    await userEvent.keyboard('{Enter}')
    await expect.element(first).toHaveTextContent('Found it')
    await userEvent.click(first.getByTestId('docx-comment-resolve'))
    await expect.element(first).toHaveAttribute('data-done', '1')
    await expect.poll(() => lastSaved('word/commentsExtended.xml')).toContain('w15:paraId="0000000A" w15:done="1"')
    expect(lastSaved('word/comments.xml')).toContain('Found it')
    // Reopen.
    await userEvent.click(first.getByTestId('docx-comment-reopen'))
    await expect.element(first).toHaveAttribute('data-done', '0')
  })

  it('edits only your own comments and deletes a thread with its anchors', async () => {
    await open()
    await startEdit()
    const comments = page.getByTestId('docx-comment')
    // Ann's comment: no Edit; Dana's reply: Edit.
    expect(comments.first().getByRole('button', { name: 'Edit comment' }).query()).toBeNull()
    await userEvent.click(comments.nth(1).getByRole('button', { name: 'Edit comment' }))
    await userEvent.fill(page.getByTestId('docx-comment-input'), 'Q3 report, page 4')
    await userEvent.click(page.getByTestId('docx-comment-save'))
    await expect.element(comments.nth(1)).toHaveTextContent('Q3 report, page 4')
    await userEvent.click(comments.first().getByRole('button', { name: 'Delete comment' }))
    await expect.element(page.getByTestId('docx-thread')).not.toBeInTheDocument()
    await expect.poll(() => lastSaved('word/document.xml')).not.toContain('commentRangeStart')
    expect(surface().textContent).toContain('Revenue grew')
  })

  it('Track changes records typing as an insertion, writes the setting, and Accept all keeps it', async () => {
    await open()
    await startEdit()
    const toggle = page.getByTestId('docx-track-toggle')
    await userEvent.click(toggle)
    await expect.element(toggle).toHaveAttribute('aria-pressed', 'true')
    await userEvent.click(edit().getByText('Second line'))
    const text = [...surface().querySelectorAll('p')].flatMap((el) => [...el.childNodes]).map((n) => (n.nodeType === 3 ? n : n.lastChild)).find((n) => n?.textContent === 'Second line')!
    document.getSelection()!.collapse(text, 'Second line'.length)
    await new Promise((resolve) => setTimeout(resolve, 50))
    await userEvent.keyboard(' added')
    await expect.element(edit().getByText(' added')).toBeVisible()
    expect([...surface().querySelectorAll('ins.docx-insertion')].map((e) => e.textContent)).toEqual([' sharply', ' added'])
    await expect.poll(() => lastSaved('word/document.xml')).toMatch(/<w:ins w:id="\d+" w:author="Dana Ruiz" w:date="[^"]+"><w:r><w:t xml:space="preserve"> added<\/w:t><\/w:r><\/w:ins>/)
    expect(lastSaved('word/settings.xml')).toContain('<w:trackRevisions/>')
    await expect.element(page.getByTestId('docx-change-count')).toHaveTextContent(/3 tracked changes|Change \d of 3/)
    await userEvent.click(page.getByTestId('docx-change-accept-all'))
    await expect.element(page.getByTestId('docx-change-count')).toHaveTextContent('No tracked changes')
    await expect.poll(() => lastSaved('word/document.xml')).not.toMatch(/<w:ins |<w:del /)
    expect(lastSaved('word/document.xml')).toContain('Second line')
    expect(surface().textContent).not.toContain('slowly')
  })

  it('steps to a change and rejects it', async () => {
    await open()
    await startEdit()
    await userEvent.click(page.getByRole('button', { name: 'Next change' }))
    await expect.element(page.getByTestId('docx-change-current')).toHaveTextContent('Insertion by Ann')
    await userEvent.click(page.getByTestId('docx-change-reject'))
    await expect.element(page.getByTestId('docx-change-count')).toHaveTextContent(/1 tracked change|Change 1 of 1/)
    expect(surface().textContent).not.toContain('sharply')
  })

  it('without the signed-in member, commenting and tracking stay off and say so; a tracked document takes no edits', async () => {
    api.readBytes.mockResolvedValue(reviewed('<w:trackRevisions/>'))
    await open({ author: undefined })
    await expect.element(page.getByTestId('docx-comments-off')).toBeVisible()
    await startEdit()
    expect(document.querySelector('[data-testid="docx-comment-add"]')).toBeNull()
    expect(document.querySelector('[data-testid="docx-comment-reply"]')).toBeNull()
    await expect.element(page.getByTestId('docx-track-toggle')).toBeDisabled()
    await expect.element(page.getByTestId('docx-track-off')).toHaveTextContent('can’t take edits')
    await userEvent.click(edit().getByText('Second line'))
    await userEvent.keyboard('x')
    await expect.element(page.getByTestId('docx-track-refused')).toBeVisible()
    expect(surface().textContent).not.toContain('Second linex')
    expect(api.writeBytes).not.toHaveBeenCalled()
  })
})

describe('CommentsPanel', () => {
  const comments = [
    { id: '0', author: 'Ann Lee', initials: 'AL', date: '2026-11-01T10:00:00Z', text: 'Source?', parentId: null, done: true, paraId: 'A', durableId: null },
    { id: '1', author: 'Dana Ruiz', initials: 'DR', date: null, text: 'Q3', parentId: '0', done: false, paraId: 'B', durableId: null },
  ]
  const handlers = () => ({ onselect: vi.fn(), onadd: vi.fn(), onreply: vi.fn(), onedit: vi.fn(), ondone: vi.fn(), ondelete: vi.fn() })

  it('shows a resolved thread with its reply and offers Reopen', async () => {
    const h = handlers()
    render(CommentsPanel, { comments, me: 'Dana Ruiz', editable: true, canAdd: false, active: null, ...h })
    await expect.element(page.getByTestId('docx-thread')).toHaveAttribute('data-done', '1')
    await expect.element(page.getByTestId('docx-thread-resolved')).toHaveTextContent('Resolved')
    await expect.element(page.getByText('AL')).toBeVisible()
    await userEvent.click(page.getByTestId('docx-comment-reopen'))
    expect(h.ondone).toHaveBeenCalledWith('0', false)
    // Nothing selected: no new comment.
    await expect.element(page.getByTestId('docx-comment-add')).toBeDisabled()
  })

  it('adds a comment when text is selected', async () => {
    const h = handlers()
    render(CommentsPanel, { comments: [], me: 'Dana Ruiz', editable: true, canAdd: true, active: null, ...h })
    await userEvent.click(page.getByTestId('docx-comment-add'))
    await userEvent.fill(page.getByTestId('docx-comment-input'), '  Check this  ')
    await userEvent.click(page.getByTestId('docx-comment-save'))
    expect(h.onadd).toHaveBeenCalledWith('Check this')
  })
})
