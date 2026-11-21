import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page, userEvent } from 'vitest/browser'
import FilePage from './+page.svelte'

const { gotoMock, invalidateAllMock } = vi.hoisted(() => ({ gotoMock: vi.fn(), invalidateAllMock: vi.fn() }))
vi.mock('$app/navigation', () => ({ goto: gotoMock, invalidateAll: invalidateAllMock }))
vi.mock('$app/paths', () => ({ base: '', resolve: (path: string) => path }))
// The editors (CSV grid, Markdown) pull CommonJS bundles this runner doesn't pre-bundle; not under test here.
vi.mock('$lib/components/drive/doc-editor.svelte', () => ({ default: () => undefined }))
vi.mock('$lib/components/drive/revisions-panel.svelte', () => ({ default: () => undefined }))
const at = '2026-11-04T10:00:00.000Z'

function data(overrides: Record<string, unknown> = {}) {
  return {
    file: {
      type: 'file',
      id: 'p1',
      name: 'harbour.jpg',
      parentId: 'f2',
      ownerId: 'u1',
      updatedAt: at,
      trashedAt: null,
      archivedAt: null,
      archivedBy: null,
      size: 2048,
      mime: 'image/jpeg',
      dated: { at: '2019-03-14T09:30:00.000Z', kind: 'taken' },
    },
    path: [
      { id: 'f1', name: 'Archive' },
      { id: 'f2', name: 'Photos' },
    ],
    root: { label: 'My drive', href: '/drive' },
    canEdit: false,
    canManage: false,
    archivedIn: null,
    kind: 'image',
    html: null,
    text: null,
    textError: null,
    table: null,
    revisions: [],
    authors: {},
    editable: false,
    content: null,
    heartbeatMs: 10_000,
    described: { ownerName: 'Ada Owner', shared: null, readOnlyFrom: null },
    ...overrides,
  }
}

const props = (d: ReturnType<typeof data>) => ({ data: d, params: { id: 'p1' } }) as never

describe('drive file page: closing the viewer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('has a close control at the top left that goes back to the folder the file is in', async () => {
    render(FilePage, props(data()))
    const close = page.getByTestId('drive-file-close')
    await expect.element(close).toHaveAttribute('href', '/drive/folder/f2')
    await expect.element(close).toHaveAccessibleName('Close and go back to Photos')
  })

  it('goes back to the root when the file sits at the top level', async () => {
    render(FilePage, props(data({ path: [], root: { label: 'Shared with me', href: '/drive/shared' } })))
    await expect.element(page.getByTestId('drive-file-close')).toHaveAttribute('href', '/drive/shared')
    await expect
      .element(page.getByTestId('drive-file-close'))
      .toHaveAccessibleName('Close and go back to Shared with me')
  })

  it('Escape closes the viewer', async () => {
    render(FilePage, props(data()))
    await expect.element(page.getByTestId('drive-file')).toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    expect(gotoMock).toHaveBeenCalledWith('/drive/folder/f2')
  })

  it('Escape does not close the viewer while the sharing dialog is open', async () => {
    render(FilePage, props(data({ canManage: true, described: { ownerName: 'Ada', shared: false, readOnlyFrom: null } })))
    await page.getByTestId('drive-file-share').click()
    await userEvent.keyboard('{Escape}')
    expect(gotoMock).not.toHaveBeenCalled()
  })
})

describe('drive file page: when the file is from', () => {
  it('shows the month and year with the kind of date', async () => {
    render(FilePage, props(data()))
    await expect.element(page.getByTestId('drive-file-dated')).toHaveTextContent('Mar 2019')
    await expect.element(page.getByTestId('drive-file-dated')).toHaveTextContent('taken')
  })

  it('says uploaded when only the upload date is known', async () => {
    const d = data()
    render(FilePage, props(data({ file: { ...d.file, dated: { at: '2026-11-04T10:00:00.000Z', kind: 'uploaded' } } })))
    await expect.element(page.getByTestId('drive-file-dated')).toHaveTextContent('Nov 2026')
    await expect.element(page.getByTestId('drive-file-dated')).toHaveTextContent('uploaded')
  })
})

describe('drive file page: text preview limits', () => {
  it('explains when text is too large and keeps the download action', async () => {
    const d = data()
    render(
      FilePage,
      props(
        data({
          file: { ...d.file, name: 'huge.ts', mime: 'text/plain', size: 2 * 1024 * 1024 + 1, dated: null },
          kind: 'text',
          textError: 'This file is too large to preview, download it instead.',
        }),
      ),
    )
    await expect.element(page.getByTestId('drive-text-too-large')).toHaveTextContent('too large to preview, download')
    await expect.element(page.getByTestId('drive-file-download')).toHaveAttribute('href', '/api/drive/files/p1/content?download=1')
    await expect.element(page.getByTestId('drive-text')).not.toBeInTheDocument()
  })

  it('says the same for a Markdown file over the cap, instead of an empty document', async () => {
    const d = data()
    render(
      FilePage,
      props(
        data({
          file: { ...d.file, name: 'huge.md', mime: 'text/markdown', size: 2 * 1024 * 1024 + 1, dated: null },
          kind: 'markdown',
          textError: 'This file is too large to preview, download it instead.',
        }),
      ),
    )
    await expect.element(page.getByTestId('drive-text-too-large')).toHaveTextContent('too large to preview, download')
    await expect.element(page.getByText('This document is empty.')).not.toBeInTheDocument()
  })
})

describe('drive file page: HTML files render as pages', () => {
  const html = (overrides: Record<string, unknown> = {}) =>
    data({
      file: { ...data().file, id: 'h1', name: 'report.html', mime: 'text/html', dated: null },
      kind: 'html',
      text: '<h1>Quarterly</h1>',
      viewUrl: '/api/drive/view/tok.sig/report.html',
      ...overrides,
    })

  it('shows the page itself in a sandboxed frame by default (scripts, no same origin)', async () => {
    render(FilePage, props(html()))
    const frame = page.getByTestId('drive-html')
    await expect.element(frame).toHaveAttribute('src', '/api/drive/view/tok.sig/report.html')
    await expect.element(frame).toHaveAttribute('sandbox', 'allow-scripts')
    await expect.element(frame).toHaveAttribute('referrerpolicy', 'no-referrer')
    await expect.element(page.getByRole('button', { name: 'Page' })).toHaveAttribute('aria-pressed', 'true')
    await expect.element(page.getByTestId('drive-html-source')).not.toBeInTheDocument()
  })

  it('gives a read-only GitHub HTML source the same scripts-without-same-origin sandbox', async () => {
    render(
      FilePage,
      props(
        html({
          canManage: true,
          described: { ownerName: 'GitHub', shared: false, readOnlyFrom: 'GitHub' },
        }),
      ),
    )
    const frame = page.getByTestId('drive-html')
    await expect.element(frame).toHaveAttribute('sandbox', 'allow-scripts')
    expect(frame.element().getAttribute('sandbox')).not.toContain('allow-same-origin')
    await expect.element(page.getByTestId('drive-readonly-badge')).toHaveTextContent('GitHub · read-only')
  })

  it('switches to the source text and back', async () => {
    render(FilePage, props(html()))
    await page.getByRole('button', { name: 'Source' }).click()
    await expect.element(page.getByTestId('drive-html-source')).toHaveTextContent('<h1>Quarterly</h1>')
    await expect.element(page.getByTestId('drive-html')).not.toBeInTheDocument()
    await page.getByRole('button', { name: 'Page' }).click()
    await expect.element(page.getByTestId('drive-html')).toBeInTheDocument()
  })

  it('opens the page on its own in a new tab', async () => {
    render(FilePage, props(html()))
    const open = page.getByTestId('drive-html-open')
    await expect.element(open).toHaveAttribute('href', '/api/drive/view/tok.sig/report.html')
    await expect.element(open).toHaveAttribute('target', '_blank')
    await expect.element(open).toHaveAttribute('rel', 'noopener noreferrer')
  })
})

describe('drive file page: the details pane can be put away', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.removeItem('ee.drive.file-details')
  })

  it('hides and shows the details pane from a labelled toggle, for any kind of file', async () => {
    render(FilePage, props(data()))
    const toggle = page.getByTestId('drive-file-side-toggle')
    await expect.element(toggle).toHaveAccessibleName('Hide details')
    await expect.element(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect.element(toggle).toHaveAttribute('aria-controls', 'drive-file-side')
    await expect.element(page.getByTestId('drive-file-side')).toBeVisible()
    await toggle.click()
    await expect.element(page.getByTestId('drive-file-side')).not.toBeVisible()
    await expect.element(toggle).toHaveAccessibleName('Show details')
    await expect.element(toggle).toHaveAttribute('aria-expanded', 'false')
    await toggle.click()
    await expect.element(page.getByTestId('drive-file-side')).toBeVisible()
  })

  it('remembers the choice in this browser', async () => {
    const first = render(FilePage, props(data()))
    await page.getByTestId('drive-file-side-toggle').click()
    expect(localStorage.getItem('ee.drive.file-details')).toBe('hidden')
    first.unmount()
    render(FilePage, props(data()))
    await expect.element(page.getByTestId('drive-file-side-toggle')).toHaveAccessibleName('Show details')
    await expect.element(page.getByTestId('drive-file-side')).not.toBeVisible()
  })
})

describe('drive file page: full view', () => {
  const proto = HTMLElement.prototype as { requestFullscreen: HTMLElement['requestFullscreen'] }
  const realRequest = proto.requestFullscreen
  let fullscreenElement: Element | null = null

  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.removeItem('ee.drive.file-details')
    fullscreenElement = null
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => fullscreenElement })
    Object.defineProperty(document, 'exitFullscreen', {
      configurable: true,
      value: vi.fn(async () => {
        fullscreenElement = null
        document.dispatchEvent(new Event('fullscreenchange'))
      }),
    })
    return () => {
      proto.requestFullscreen = realRequest
      delete (document as { fullscreenElement?: unknown }).fullscreenElement
      delete (document as { exitFullscreen?: unknown }).exitFullscreen
    }
  })

  const grantFullscreen = () => {
    proto.requestFullscreen = vi.fn(async function (this: HTMLElement) {
      fullscreenElement = document.documentElement === this ? document.documentElement : null
      document.dispatchEvent(new Event('fullscreenchange'))
    })
  }
  const refuseFullscreen = () => {
    proto.requestFullscreen = vi.fn(async () => {
      throw new Error('refused')
    })
  }

  it('goes full screen with the viewer alone; leaving full screen (Esc in the browser) restores the page', async () => {
    grantFullscreen()
    render(FilePage, props(data()))
    const button = page.getByTestId('drive-file-full-view')
    await expect.element(button).toHaveAccessibleName('Full view')
    await button.click()
    await expect.element(page.getByTestId('drive-file')).toHaveAttribute('data-full-view', 'screen')
    // The whole document goes full screen (dialogs the viewers open live outside the file view), the file view fills it.
    expect(fullscreenElement).toBe(document.documentElement)
    await expect.element(page.getByTestId('drive-file-side')).not.toBeVisible()
    await expect.element(button).toHaveAccessibleName('Exit full view')
    await expect.element(button).toHaveAttribute('aria-pressed', 'true')
    // The browser handles Esc in full screen: it leaves, then tells the page.
    fullscreenElement = null
    document.dispatchEvent(new Event('fullscreenchange'))
    await expect.element(page.getByTestId('drive-file')).toHaveAttribute('data-full-view', 'off')
    await expect.element(page.getByTestId('drive-file-side')).toBeVisible()
    expect(gotoMock).not.toHaveBeenCalled()
  })

  it('the Exit full view button leaves full screen', async () => {
    grantFullscreen()
    render(FilePage, props(data()))
    await page.getByTestId('drive-file-full-view').click()
    await expect.element(page.getByTestId('drive-file')).toHaveAttribute('data-full-view', 'screen')
    await page.getByTestId('drive-file-full-view').click()
    expect(document.exitFullscreen).toHaveBeenCalled()
    await expect.element(page.getByTestId('drive-file')).toHaveAttribute('data-full-view', 'off')
  })

  it('when the browser refuses full screen, maximises in the window and says so; Esc leaves it before closing the file', async () => {
    refuseFullscreen()
    render(FilePage, props(data()))
    await page.getByTestId('drive-file-full-view').click()
    await expect.element(page.getByTestId('drive-file')).toHaveAttribute('data-full-view', 'window')
    await expect
      .element(page.getByTestId('drive-file-full-view-note'))
      .toHaveTextContent('Full screen is not available here')
    await expect.element(page.getByTestId('drive-file-side')).not.toBeVisible()
    await userEvent.keyboard('{Escape}')
    await expect.element(page.getByTestId('drive-file')).toHaveAttribute('data-full-view', 'off')
    expect(gotoMock).not.toHaveBeenCalled()
    await userEvent.keyboard('{Escape}')
    expect(gotoMock).toHaveBeenCalledWith('/drive/folder/f2')
  })

  it('leaving full view keeps a details pane the person had hidden hidden', async () => {
    refuseFullscreen()
    render(FilePage, props(data()))
    await page.getByTestId('drive-file-side-toggle').click()
    await page.getByTestId('drive-file-full-view').click()
    await page.getByTestId('drive-file-full-view').click()
    await expect.element(page.getByTestId('drive-file')).toHaveAttribute('data-full-view', 'off')
    await expect.element(page.getByTestId('drive-file-side')).not.toBeVisible()
  })
})
