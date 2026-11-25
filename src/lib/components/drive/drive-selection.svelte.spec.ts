import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page, userEvent } from 'vitest/browser'
import type { DriveItem } from '$lib/drive/api'
import ArchivedView from './archived-view.svelte'
import DriveBrowser from './drive-browser.svelte'

/** Drive's row selection and its bar (the lists: My drive / folders, Overview, Shared with me, Trash, Archived). */

const { invalidateAllMock, api } = vi.hoisted(() => ({
  invalidateAllMock: vi.fn(),
  api: {
    trashMany: vi.fn(),
    restoreMany: vi.fn(),
    deleteForeverMany: vi.fn(),
    moveMany: vi.fn(),
    archiveMany: vi.fn(),
    unarchiveMany: vi.fn(),
    shareMany: vi.fn(),
    listFolder: vi.fn(),
    readText: vi.fn(),
  },
}))
vi.mock('$app/navigation', () => ({ goto: vi.fn(), invalidateAll: invalidateAllMock, afterNavigate: vi.fn() }))
vi.mock('$app/paths', () => ({ base: '', resolve: (path: string) => path }))
vi.mock('$lib/drive/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('$lib/drive/api')>()
  return { ...real, driveApi: { ...real.driveApi, ...api } }
})

type Row = DriveItem & { canEdit: boolean; canManage: boolean }
const at = '2026-11-04T10:00:00.000Z'
const item = (id: string, name: string, rights: Partial<Row> = {}): Row => ({
  type: 'file',
  id,
  name,
  parentId: null,
  ownerId: 'u1',
  updatedAt: at,
  trashedAt: null,
  size: 10,
  mime: 'text/plain',
  canEdit: true,
  canManage: true,
  ...rights,
})
const a = item('a', 'alpha.txt')
const b = item('b', 'bravo.txt')
const c = item('c', 'charlie.txt')
const d = item('d', 'delta.txt')
const viewOnly = item('v', 'view-only.txt', { canEdit: false, canManage: false })
const editOnly = item('e', 'edit-only.txt', { canManage: false })

const box = (name: string) => page.getByRole('checkbox', { name: `Select ${name}` })
const pageBox = () => page.getByTestId('drive-select-page')
const selectedNames = () =>
  page
    .getByTestId('drive-row')
    .elements()
    .filter((el) => el.getAttribute('data-selected') === 'true')
    .map((el) => el.getAttribute('data-name'))
const barActions = () =>
  page
    .getByTestId('drive-selection-bar')
    .element()
    .querySelectorAll('[data-testid^="drive-bulk-"]')
const actionIds = () => [...barActions()].map((el) => el.getAttribute('data-testid')!.replace('drive-bulk-', ''))

describe('drive selection: checkboxes, header state, ranges, keyboard', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.resetAllMocks()
  })

  it('a checkbox per row; the header checkbox goes none → some (indeterminate) → all, and selects the page', async () => {
    render(DriveBrowser, { props: { folderId: null, items: [a, b, c], canEdit: true } })
    await expect.element(box('alpha.txt')).not.toBeChecked()
    expect(page.getByTestId('drive-selection-bar').elements()).toHaveLength(0)
    await box('bravo.txt').click()
    await expect.element(page.getByTestId('drive-selection-count')).toHaveTextContent('1 selected')
    expect((pageBox().element() as HTMLInputElement).indeterminate).toBe(true)
    await pageBox().click()
    await expect.element(page.getByTestId('drive-selection-count')).toHaveTextContent('3 selected')
    await expect.element(pageBox()).toBeChecked()
    expect((pageBox().element() as HTMLInputElement).indeterminate).toBe(false)
    await pageBox().click()
    expect(page.getByTestId('drive-selection-bar').elements()).toHaveLength(0)
    expect(selectedNames()).toEqual([])
  })

  it('shift-click selects the range from the last clicked row, in the order shown', async () => {
    render(DriveBrowser, { props: { folderId: null, items: [a, b, c, d], canEdit: true } })
    await box('alpha.txt').click()
    await box('charlie.txt').click({ modifiers: ['Shift'] })
    expect(selectedNames()).toEqual(['alpha.txt', 'bravo.txt', 'charlie.txt'])
  })

  it('Space on a focused row toggles it; Escape clears the selection', async () => {
    render(DriveBrowser, { props: { folderId: null, items: [a, b], canEdit: true } })
    page.getByRole('link', { name: 'bravo.txt', exact: true }).element().focus()
    await userEvent.keyboard(' ')
    expect(selectedNames()).toEqual(['bravo.txt'])
    await userEvent.keyboard('{Escape}')
    expect(selectedNames()).toEqual([])
    expect(page.getByTestId('drive-selection-bar').elements()).toHaveLength(0)
  })

  it('the selection survives sorting and paging', async () => {
    const many = Array.from({ length: 250 }, (_, i) => item(`m${i}`, `file-${String(i).padStart(3, '0')}.txt`))
    render(DriveBrowser, { props: { folderId: null, items: many, canEdit: true } })
    await box('file-001.txt').click()
    await page.getByRole('button', { name: 'Name', exact: true }).click()
    await page.getByRole('button', { name: 'Name', exact: true }).click()
    await expect.element(page.getByTestId('drive-row').first()).toHaveAttribute('data-name', 'file-249.txt')
    await page.getByTestId('drive-page-next').click()
    await expect.element(page.getByTestId('drive-selection-count')).toHaveTextContent('1 selected')
    await expect.element(box('file-001.txt')).toBeChecked()
    // The header checkbox speaks for this page only.
    expect((pageBox().element() as HTMLInputElement).indeterminate).toBe(true)
  })

  it('the grid has a checkbox per card too', async () => {
    localStorage.setItem('drive-view', 'grid')
    render(DriveBrowser, { props: { folderId: null, items: [a, b], canEdit: true } })
    await box('alpha.txt').click()
    await expect.element(page.getByTestId('drive-selection-count')).toHaveTextContent('1 selected')
  })
})

describe('drive selection bar: only the acts valid for every selected item, per list', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.resetAllMocks()
  })

  it('My drive / a folder: Move, Share, Archive, Trash when all may be managed; Share leaves with an edit-only item', async () => {
    render(DriveBrowser, { props: { folderId: null, items: [a, editOnly, viewOnly], canEdit: true } })
    await box('alpha.txt').click()
    expect(actionIds()).toEqual(['move', 'share', 'archive', 'trash'])
    await box('edit-only.txt').click()
    expect(actionIds()).toEqual(['move', 'archive', 'trash'])
    await box('view-only.txt').click()
    expect(actionIds()).toEqual([])
    await expect.element(page.getByTestId('drive-selection-none-valid')).toBeInTheDocument()
  })

  it('Shared with me (view-only items): nothing to do on them', async () => {
    render(DriveBrowser, {
      props: { folderId: null, root: { label: 'Shared with me', href: '/drive/shared' }, items: [viewOnly], canEdit: false, showToolbar: false },
    })
    await box('view-only.txt').click()
    expect(actionIds()).toEqual([])
  })

  it('the Overview (mixed folders and files): a folder and a file select together', async () => {
    const folder: Row = { ...a, type: 'folder', id: 'f1', name: 'Projects', origin: 'mine' }
    const shared: Row = { ...b, origin: 'shared' }
    render(DriveBrowser, { props: { folderId: null, root: { label: 'Overview', href: '/drive' }, items: [folder, shared], canEdit: true } })
    await pageBox().click()
    await expect.element(page.getByTestId('drive-selection-count')).toHaveTextContent('2 selected')
    expect(actionIds()).toEqual(['move', 'share', 'archive', 'trash'])
  })

  it('Trash: Restore, and Delete forever only when every item may be managed', async () => {
    const trashed = (r: Row) => ({ ...r, trashedAt: at })
    render(DriveBrowser, { props: { folderId: null, items: [trashed(a), trashed(editOnly)], canEdit: false, showToolbar: false, trashView: true } })
    await box('alpha.txt').click()
    expect(actionIds()).toEqual(['restore', 'delete_forever'])
    await box('edit-only.txt').click()
    expect(actionIds()).toEqual(['restore'])
  })
})

describe('drive selection bar: bulk acts and their per-item outcome', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.resetAllMocks()
  })

  it('Move to trash sends the selection once and names every item that failed; those stay selected', async () => {
    api.trashMany.mockResolvedValue({ trashed: [a, b, c], errors: [{ type: 'file', id: 'd', error: 'Someone is editing it.' }] })
    render(DriveBrowser, { props: { folderId: null, items: [a, b, c, d], canEdit: true } })
    await pageBox().click()
    await page.getByTestId('drive-bulk-trash').click()
    expect(api.trashMany).toHaveBeenCalledWith([
      { type: 'file', id: 'a' },
      { type: 'file', id: 'b' },
      { type: 'file', id: 'c' },
      { type: 'file', id: 'd' },
    ])
    await expect.element(page.getByTestId('drive-bulk-failures')).toHaveTextContent('3 moved to the trash, 1 failed:')
    await expect.element(page.getByTestId('drive-bulk-failure')).toHaveTextContent('delta.txt — Someone is editing it.')
    expect(invalidateAllMock).toHaveBeenCalled()
    expect(selectedNames()).toEqual(['delta.txt'])
  })

  it('everything done: a plain notice and nothing left selected', async () => {
    api.archiveMany.mockResolvedValue({ archived: [a, b], errors: [] })
    render(DriveBrowser, { props: { folderId: null, items: [a, b], canEdit: true } })
    await pageBox().click()
    await page.getByTestId('drive-bulk-archive').click()
    await expect.element(page.getByTestId('drive-notice')).toHaveTextContent('2 archived')
    expect(page.getByTestId('drive-bulk-failures').elements()).toHaveLength(0)
    expect(selectedNames()).toEqual([])
  })

  it('a call that fails as a whole is shown, never swallowed', async () => {
    api.trashMany.mockRejectedValue(new Error('Drive is not reachable.'))
    render(DriveBrowser, { props: { folderId: null, items: [a, b], canEdit: true } })
    await pageBox().click()
    await page.getByTestId('drive-bulk-trash').click()
    await expect.element(page.getByTestId('drive-bulk-stopped')).toHaveTextContent('Stopped: Drive is not reachable. 2 not tried.')
    expect(selectedNames()).toEqual(['alpha.txt', 'bravo.txt'])
  })

  it('Delete forever (Trash) asks first, stating the count and that it can’t be undone', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true)
    api.deleteForeverMany.mockResolvedValue({ deleted: [{ type: 'file', id: 'a', name: 'alpha.txt' }, { type: 'file', id: 'b', name: 'bravo.txt' }], errors: [] })
    const trashed = (r: Row) => ({ ...r, trashedAt: at })
    render(DriveBrowser, { props: { folderId: null, items: [trashed(a), trashed(b)], canEdit: false, showToolbar: false, trashView: true } })
    await pageBox().click()
    await page.getByTestId('drive-bulk-delete_forever').click()
    expect(confirmSpy).toHaveBeenLastCalledWith('Delete 2 items forever? This can’t be undone.')
    expect(api.deleteForeverMany).not.toHaveBeenCalled()
    await page.getByTestId('drive-bulk-delete_forever').click()
    await expect.element(page.getByTestId('drive-notice')).toHaveTextContent('2 deleted forever')
    expect(api.deleteForeverMany).toHaveBeenCalledTimes(1)
    confirmSpy.mockRestore()
  })

  it('Move to… picks a folder for all selected items at once', async () => {
    api.listFolder.mockResolvedValue({ folder: null, path: [], items: [{ ...a, type: 'folder', id: 'dest', name: 'Dest' }], canEdit: true })
    api.moveMany.mockResolvedValue({ moved: [a, b], errors: [] })
    render(DriveBrowser, { props: { folderId: null, items: [a, b], canEdit: true } })
    await pageBox().click()
    await page.getByTestId('drive-bulk-move').click()
    await expect.element(page.getByText('Move 2 items')).toBeInTheDocument()
    await page.getByTestId('drive-move-folder').click()
    await page.getByTestId('drive-move-here').click()
    expect(api.moveMany).toHaveBeenCalledWith([{ type: 'file', id: 'a' }, { type: 'file', id: 'b' }], 'dest')
    await expect.element(page.getByTestId('drive-notice')).toHaveTextContent('2 moved')
  })
})

describe('archived view selection', () => {
  beforeEach(() => vi.resetAllMocks())

  it('selects across groups and unarchives them in one go, naming what failed', async () => {
    const archived = (r: Row) => ({ ...r, archivedAt: at, archivedByName: null })
    const groups = [
      { key: 'g1', folder: null, root: { label: 'My drive', href: '/drive' }, path: [], items: [archived(a), archived(b)] },
      { key: 'g2', folder: { id: 'x', name: 'X' }, root: { label: 'My drive', href: '/drive' }, path: [{ id: 'x', name: 'X' }], items: [archived(c)] },
    ]
    api.unarchiveMany.mockResolvedValue({
      unarchived: [{ item: a, stillIn: null }, { item: c, stillIn: null }],
      errors: [{ type: 'file', id: 'b', error: 'That file is not archived.' }],
    })
    render(ArchivedView, { props: { groups, suggestDays: 90 } })
    await box('alpha.txt').click()
    await box('charlie.txt').click({ modifiers: ['Shift'] })
    await expect.element(page.getByTestId('drive-selection-count')).toHaveTextContent('3 selected')
    expect(actionIds()).toEqual(['unarchive'])
    await page.getByTestId('drive-bulk-unarchive').click()
    expect(api.unarchiveMany).toHaveBeenCalledWith([
      { type: 'file', id: 'a' },
      { type: 'file', id: 'b' },
      { type: 'file', id: 'c' },
    ])
    await expect.element(page.getByTestId('drive-bulk-failures')).toHaveTextContent('2 unarchived, 1 failed:')
    await expect.element(page.getByTestId('drive-bulk-failure')).toHaveTextContent('bravo.txt — That file is not archived.')
  })
})
