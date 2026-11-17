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
