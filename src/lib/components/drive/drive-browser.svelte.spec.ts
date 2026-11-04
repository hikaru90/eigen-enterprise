import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import type { DriveItem } from '$lib/drive/api'
import DriveBrowser from './drive-browser.svelte'

const { gotoMock, invalidateAllMock } = vi.hoisted(() => ({
  gotoMock: vi.fn(),
  invalidateAllMock: vi.fn(),
}))
vi.mock('$app/navigation', () => ({ goto: gotoMock, invalidateAll: invalidateAllMock }))
vi.mock('$app/paths', () => ({ base: '', resolve: (path: string) => path }))

const at = '2026-11-04T10:00:00.000Z'
const folder: DriveItem & { canEdit: boolean; canManage: boolean } = {
  type: 'folder',
  id: 'f1',
  name: 'Projects',
  parentId: null,
  ownerId: 'u1',
  updatedAt: at,
  trashedAt: null,
  canEdit: true,
  canManage: true,
}
const image: DriveItem & { canEdit: boolean; canManage: boolean } = {
  type: 'file',
  id: 'i1',
  name: 'mood.png',
  parentId: null,
  ownerId: 'u2',
  updatedAt: at,
  trashedAt: null,
  size: 2048,
  mime: 'image/png',
  canEdit: false,
  canManage: false,
}
const describe_ = {
  'folder:f1': { ownerName: 'Ada Owner', shared: true },
  'file:i1': { ownerName: 'Ben Member', shared: null },
}

describe('drive-browser: the full-width listing', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.clearAllMocks()
  })

  it('lists items with owner initials and name, size, and a sharing badge where the viewer may know', async () => {
    render(DriveBrowser, {
      props: { folderId: null, items: [folder, image], canEdit: true, describe: describe_ },
    })
    const rows = page.getByTestId('drive-row')
    await expect.element(rows.first()).toHaveAttribute('data-name', 'Projects')
    await expect.element(page.getByTestId('drive-list')).toBeInTheDocument()
    await expect.element(page.getByText('Ada Owner')).toBeInTheDocument()
    await expect.element(page.getByText('AO')).toBeInTheDocument()
    await expect.element(page.getByText('Ben Member')).toBeInTheDocument()
    await expect.element(page.getByText('2.0 KB')).toBeInTheDocument()
    // Shared: only the folder (the image's sharing is not the viewer's to know).
    expect(page.getByTestId('drive-shared-badge').elements()).toHaveLength(1)
  })

  it('switches to a grid with image previews, and remembers the choice in this browser', async () => {
    render(DriveBrowser, { props: { folderId: null, items: [folder, image], canEdit: true } })
    await page.getByTestId('drive-view-grid').click()
    await expect.element(page.getByTestId('drive-grid')).toBeInTheDocument()
    await expect
      .element(page.getByTestId('drive-thumb'))
      .toHaveAttribute('src', '/api/drive/files/i1/content')
    expect(page.getByTestId('drive-row').elements()).toHaveLength(2)
    expect(localStorage.getItem('drive-view')).toBe('grid')
    await expect
      .element(page.getByTestId('drive-view-grid'))
      .toHaveAttribute('aria-pressed', 'true')
  })

  it('opens in the view this browser last used', async () => {
    localStorage.setItem('drive-view', 'grid')
    render(DriveBrowser, { props: { folderId: null, items: [folder], canEdit: true } })
    await expect.element(page.getByTestId('drive-grid')).toBeInTheDocument()
  })

  it('an empty folder offers New folder and Upload; a read-only one only says it is empty', async () => {
    const editable = render(DriveBrowser, {
      props: { folderId: 'f1', items: [], canEdit: true, emptyText: 'This folder is empty.' },
    })
    await expect.element(page.getByTestId('drive-empty')).toHaveTextContent('This folder is empty.')
    await expect.element(page.getByTestId('drive-empty-new-folder')).toBeInTheDocument()
    await expect.element(page.getByTestId('drive-empty-upload')).toBeInTheDocument()
    editable.unmount()

    render(DriveBrowser, {
      props: {
        folderId: 'f1',
        items: [],
        canEdit: false,
        showToolbar: false,
        emptyText: 'Nothing.',
      },
    })
    await expect.element(page.getByTestId('drive-empty')).toHaveTextContent('Nothing.')
    expect(page.getByTestId('drive-empty-upload').elements()).toHaveLength(0)
  })

  it('dragging files over the pane shows where they will upload', async () => {
    render(DriveBrowser, {
      props: { folderId: 'f1', path: [{ id: 'f1', name: 'Projects' }], items: [], canEdit: true },
    })
    const pane = page.getByTestId('drive-browser').element()
    const files = new DataTransfer()
    files.items.add(new File(['x'], 'a.txt'))
    pane.dispatchEvent(
      new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: files }),
    )
    await expect
      .element(page.getByTestId('drive-drop-overlay'))
      .toHaveTextContent('Drop to upload to Projects')
    pane.dispatchEvent(
      new DragEvent('dragleave', { bubbles: true, cancelable: true, dataTransfer: files }),
    )
    await expect.element(page.getByTestId('drive-drop-overlay')).not.toBeInTheDocument()
  })
})
