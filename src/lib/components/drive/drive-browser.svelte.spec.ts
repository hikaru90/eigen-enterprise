import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import type { DriveItem, DriveOrigin } from '$lib/drive/api'
import DriveBrowser from './drive-browser.svelte'

const { gotoMock, invalidateAllMock, api } = vi.hoisted(() => ({
  gotoMock: vi.fn(),
  invalidateAllMock: vi.fn(),
  api: {
    archive: vi.fn(),
    unarchive: vi.fn(),
    createFolder: vi.fn(),
    upload: vi.fn(),
    move: vi.fn(),
    readText: vi.fn(),
  },
}))
vi.mock('$app/navigation', () => ({ goto: gotoMock, invalidateAll: invalidateAllMock }))
vi.mock('$app/paths', () => ({ base: '', resolve: (path: string) => path }))
vi.mock('$lib/drive/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('$lib/drive/api')>()
  return { ...real, driveApi: { ...real.driveApi, ...api } }
})

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
const newFolder: DriveItem & { canEdit: boolean; canManage: boolean } = {
  ...folder,
  id: 'f-new',
  name: 'Fresh',
}

/** A drag event as the browser fires it, carrying `data`. */
function fire(target: Element, type: string, data: DataTransfer) {
  target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data }))
}
function desktopFiles(...names: string[]) {
  const data = new DataTransfer()
  for (const n of names) data.items.add(new File(['x'], n))
  return data
}
const rowNamed = (name: string) =>
  page.getByTestId('drive-row').elements().find((el) => el.getAttribute('data-name') === name)!

const describe_ = {
  'folder:f1': { ownerName: 'Ada Owner', shared: true, readOnlyFrom: null },
  'file:i1': { ownerName: 'Ben Member', shared: null, readOnlyFrom: null },
}

describe('drive-browser: the full-width listing', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.resetAllMocks()
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

  it('pages a source folder with 2,000 files and keeps the last file reachable', async () => {
    const files = Array.from({ length: 2_000 }, (_, i) => ({
      ...image,
      id: `source-${i}`,
      name: `file-${String(i).padStart(4, '0')}.txt`,
      mime: 'text/plain',
    }))
    render(DriveBrowser, {
      props: {
        folderId: 'source-root',
        root: { label: 'GitHub', href: '/drive/folder/source-root' },
        items: files,
        canEdit: false,
      },
    })
    const rows = page.getByTestId('drive-row')
    await expect.element(rows.last()).toHaveAttribute('data-name', 'file-0199.txt')
    expect(rows.elements()).toHaveLength(200)
    await expect.element(page.getByTestId('drive-page-summary')).toHaveTextContent('1–200 of 2,000')
    await expect.element(page.getByTestId('drive-page-previous')).toBeDisabled()
    for (let i = 0; i < 9; i++) await page.getByTestId('drive-page-next').click()
    await expect.element(page.getByTestId('drive-page-summary')).toHaveTextContent('1,801–2,000 of 2,000')
    await expect.element(page.getByTestId('drive-page-next')).toBeDisabled()
    await expect.element(rows.first()).toHaveAttribute('data-name', 'file-1800.txt')
    await expect.element(rows.last()).toHaveAttribute('data-name', 'file-1999.txt')
    expect(rows.elements()).toHaveLength(200)
    // exact: the row's Download action is a link whose label also contains the name.
    await expect
      .element(page.getByRole('link', { name: 'file-1999.txt', exact: true }))
      .toHaveAttribute('href', '/drive/file/source-1999')
  }, 15_000)

  it('new search results start again at their first page', async () => {
    const many = (prefix: string, n: number) =>
      Array.from({ length: n }, (_, i) => ({ ...image, id: `${prefix}-${i}`, name: `${prefix}-${String(i).padStart(4, '0')}.txt`, mime: 'text/plain' }))
    const base = { folderId: 'source-root', root: { label: 'GitHub', href: '/drive/folder/source-root' }, items: [], canEdit: false }
    const { rerender } = render(DriveBrowser, { props: { ...base, query: 'a', results: many('a', 450) } })
    await page.getByTestId('drive-page-next').click()
    await page.getByTestId('drive-page-next').click()
    await expect.element(page.getByTestId('drive-page-summary')).toHaveTextContent('401–450 of 450')
    await rerender({ ...base, query: 'b', results: many('b', 900) })
    await expect.element(page.getByTestId('drive-page-summary')).toHaveTextContent('1–200 of 900')
    await expect.element(page.getByTestId('drive-row').first()).toHaveAttribute('data-name', 'b-0000.txt')
  })

  it('shows the month and year each file is from, and what kind of date it is', async () => {
    const photo = { ...image, id: 'i2', name: 'harbour.jpg', dated: { at: '2019-03-14T09:30:00.000Z', kind: 'taken' as const } }
    const upload = { ...image, id: 'i3', name: 'notes.png', dated: { at: '2026-11-04T10:00:00.000Z', kind: 'uploaded' as const } }
    render(DriveBrowser, { props: { folderId: null, items: [folder, photo, upload], canEdit: true, describe: {} } })
    const dated = page.getByTestId('drive-dated')
    await expect.element(dated.nth(0)).toHaveTextContent('Mar 2019')
    await expect.element(dated.nth(0)).toHaveTextContent('taken')
    await expect.element(dated.nth(0)).toHaveAttribute('title', 'Taken March 2019')
    await expect.element(dated.nth(1)).toHaveTextContent('Nov 2026')
    await expect.element(dated.nth(1)).toHaveTextContent('uploaded')
    // Folders are not from a date.
    expect(dated.elements()).toHaveLength(2)
  })

  it('the grid says when a file is from too', async () => {
    const photo = { ...image, id: 'i2', name: 'harbour.jpg', dated: { at: '2019-03-14T09:30:00.000Z', kind: 'taken' as const } }
    render(DriveBrowser, { props: { folderId: null, items: [photo], canEdit: true, describe: {} } })
    await page.getByTestId('drive-view-grid').click()
    await expect.element(page.getByTestId('drive-dated')).toHaveTextContent('Mar 2019')
  })

  it('a read-only source folder: "<source> · read-only" badges, no toolbar actions, no row edits', async () => {
    const overview: DriveItem & { canEdit: boolean; canManage: boolean } = {
      type: 'file',
      id: 's1',
      name: 'Overview.md',
      parentId: 'root',
      ownerId: 'repos',
      updatedAt: at,
      trashedAt: null,
      size: 10,
      mime: 'text/markdown',
      canEdit: false,
      canManage: false,
    }
    render(DriveBrowser, {
      props: {
        folderId: 'root',
        items: [overview],
        canEdit: false,
        describe: { 'file:s1': { ownerName: 'GitHub', shared: false, readOnlyFrom: 'GitHub' } },
      },
    })
    await expect.element(page.getByTestId('drive-readonly-badge')).toHaveTextContent('GitHub · read-only')
    expect(page.getByTestId('drive-new-folder-button').elements()).toHaveLength(0)
    expect(page.getByTestId('drive-upload').elements()).toHaveLength(0)
    expect(page.getByTestId('drive-rename').elements()).toHaveLength(0)
    expect(page.getByTestId('drive-archive').elements()).toHaveLength(0)
    expect(page.getByTestId('drive-share').elements()).toHaveLength(0)
  })

  it('previews images in the list view too, in place of the kind icon', async () => {
    render(DriveBrowser, { props: { folderId: null, items: [folder, image], canEdit: true } })
    await expect.element(page.getByTestId('drive-row').nth(1)).toBeInTheDocument()
    const thumbs = page.getByTestId('drive-list-thumb')
    expect(thumbs.elements()).toHaveLength(1)
    await expect.element(thumbs).toHaveAttribute('src', '/api/drive/files/i1/content')
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

  it('previews text files in the grid: the opening lines of a document, the first rows of a table', async () => {
    const base = { parentId: null, ownerId: 'u1', updatedAt: at, trashedAt: null, size: 64, canEdit: true, canManage: true }
    const notes = { ...base, type: 'file' as const, id: 'n1', name: 'notes.md', mime: 'text/markdown' }
    const budget = { ...base, type: 'file' as const, id: 'b1', name: 'budget.csv', mime: 'text/csv' }
    api.readText.mockImplementation(async (id: string) =>
      id === 'n1' ? { content: '# Plan\nShip the drive previews.' } : { content: 'item,cost\npaper,12\n' },
    )
    localStorage.setItem('drive-view', 'grid')
    render(DriveBrowser, { props: { folderId: null, items: [notes, budget], canEdit: true } })
    const previews = page.getByTestId('drive-text-preview')
    await expect.element(previews.nth(0)).toHaveAttribute('data-state', 'ready')
    await expect.element(previews.nth(0)).toHaveTextContent('Ship the drive previews.')
    await expect.element(previews.nth(1)).toHaveAttribute('data-state', 'ready')
    expect(previews.nth(1).element().querySelectorAll('td')[2]?.textContent).toBe('paper')
    expect(api.readText).toHaveBeenCalledWith('n1')
    expect(api.readText).toHaveBeenCalledWith('b1')
  })

  it('keeps the kind icon when a text file cannot be read', async () => {
    const notes = { type: 'file' as const, id: 'n2', name: 'notes.md', parentId: null, ownerId: 'u1', updatedAt: at, trashedAt: null, size: 64, canEdit: true, canManage: true }
    api.readText.mockRejectedValue(new Error('gone'))
    localStorage.setItem('drive-view', 'grid')
    render(DriveBrowser, { props: { folderId: null, items: [notes], canEdit: true } })
    await expect.element(page.getByTestId('drive-text-preview')).toHaveAttribute('data-state', 'failed')
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

  it('Archive is offered on what you may edit; it hides the item from this view and says where to find it', async () => {
    api.archive.mockResolvedValue({ ...folder, archivedAt: at })
    render(DriveBrowser, { props: { folderId: null, items: [folder, image], canEdit: true } })
    // The image is view-only: no Archive for it.
    expect(page.getByTestId('drive-archive').elements()).toHaveLength(1)
    await page.getByRole('button', { name: 'Archive Projects' }).click()
    expect(api.archive).toHaveBeenCalledWith(expect.objectContaining({ type: 'folder', id: 'f1' }))
    await expect.element(page.getByTestId('drive-notice')).toHaveTextContent('Archived “Projects”. Find it under Archived.')
    expect(invalidateAllMock).toHaveBeenCalled()
  })

  it('search results mark archived items and offer Unarchive instead of Archive', async () => {
    const archivedFolder = { ...folder, archivedAt: at, inArchive: true }
    render(DriveBrowser, {
      props: { folderId: null, items: [], results: [archivedFolder, { ...image, inArchive: false }], query: 'p', canEdit: true },
    })
    expect(page.getByTestId('drive-archived-badge').elements()).toHaveLength(1)
    await expect.element(page.getByRole('button', { name: 'Unarchive Projects' })).toBeInTheDocument()
    expect(page.getByTestId('drive-archive').elements()).toHaveLength(0)
  })

  it('a folder created in this view takes files dropped from the desktop at once (no reload)', async () => {
    api.createFolder.mockResolvedValue(newFolder)
    api.upload.mockResolvedValue({ uploaded: [image], errors: [] })
    const view = render(DriveBrowser, { props: { folderId: null, items: [image], canEdit: true } })
    // invalidateAll brings the new listing, as the page's load would.
    invalidateAllMock.mockImplementation(async () => {
      view.rerender({ folderId: null, items: [newFolder, image], canEdit: true })
    })
    await page.getByTestId('drive-new-folder-button').click()
    await page.getByTestId('drive-name-input').fill('Fresh')
    await page.getByTestId('drive-name-save').click()
    expect(api.createFolder).toHaveBeenCalledWith(null, 'Fresh')
    await expect.element(page.getByTestId('drive-row').first()).toHaveAttribute('data-name', 'Fresh')

    const target = rowNamed('Fresh')
    const files = desktopFiles('a.txt')
    fire(target, 'dragenter', files)
    fire(target, 'dragover', files)
    await expect.element(page.getByTestId('drive-drop-overlay')).toHaveTextContent('Drop to upload to Fresh')
    fire(target, 'drop', files)
    await expect.poll(() => api.upload.mock.calls.length).toBe(1)
    expect(api.upload.mock.calls[0]![0]).toBe('f-new')
    expect(api.upload.mock.calls[0]![1].map((f: File) => f.name)).toEqual(['a.txt'])
    await expect.element(page.getByTestId('drive-notice')).toHaveTextContent('Uploaded 1 file to Fresh.')
  })

  it('files dropped on the pane but not on a folder still upload here', async () => {
    api.upload.mockResolvedValue({ uploaded: [image], errors: [] })
    render(DriveBrowser, { props: { folderId: 'f0', path: [{ id: 'f0', name: 'Top' }], items: [folder, image], canEdit: true } })
    const files = desktopFiles('b.txt')
    fire(rowNamed('mood.png'), 'dragenter', files)
    fire(rowNamed('mood.png'), 'dragover', files)
    await expect.element(page.getByTestId('drive-drop-overlay')).toHaveTextContent('Drop to upload to Top')
    fire(rowNamed('mood.png'), 'drop', files)
    await expect.poll(() => api.upload.mock.calls.length).toBe(1)
    expect(api.upload.mock.calls[0]![0]).toBe('f0')
  })

  it('a Drive item dragged onto a folder (also one created in this view) moves into it', async () => {
    api.move.mockResolvedValue({ ...image, parentId: 'f-new' })
    const editableImage = { ...image, canEdit: true }
    const view = render(DriveBrowser, { props: { folderId: null, items: [editableImage], canEdit: true } })
    view.rerender({ folderId: null, items: [newFolder, editableImage], canEdit: true })
    await expect.element(page.getByTestId('drive-row').first()).toHaveAttribute('data-name', 'Fresh')
    const source = rowNamed('mood.png')
    expect(source.getAttribute('draggable')).toBe('true')
    const data = new DataTransfer()
    fire(source, 'dragstart', data)
    fire(rowNamed('Fresh'), 'dragenter', data)
    fire(rowNamed('Fresh'), 'dragover', data)
    await expect.element(page.getByTestId('drive-drop-target')).toHaveAttribute('data-name', 'Fresh')
    // Moving within Drive is not an upload.
    expect(page.getByTestId('drive-drop-overlay').elements()).toHaveLength(0)
    fire(rowNamed('Fresh'), 'drop', data)
    await expect.poll(() => api.move.mock.calls.length).toBe(1)
    expect(api.move).toHaveBeenCalledWith(expect.objectContaining({ type: 'file', id: 'i1' }), 'f-new')
    expect(api.upload).not.toHaveBeenCalled()
    await expect.element(page.getByTestId('drive-notice')).toHaveTextContent('Moved “mood.png” to Fresh.')
  })

  it('what the viewer may not edit cannot be dragged, nor dropped onto', async () => {
    const viewOnlyFolder = { ...folder, id: 'f9', name: 'Theirs', canEdit: false }
    render(DriveBrowser, { props: { folderId: null, items: [viewOnlyFolder, image], canEdit: true } })
    expect(rowNamed('mood.png').getAttribute('draggable')).not.toBe('true')
    const files = desktopFiles('c.txt')
    fire(rowNamed('Theirs'), 'dragenter', files)
    fire(rowNamed('Theirs'), 'dragover', files)
    // The drop goes to the current view, not into the read-only folder.
    await expect.element(page.getByTestId('drive-drop-overlay')).toHaveTextContent('Drop to upload to My drive')
  })

  it('Upload folder recreates the folder tree here and uploads each file into its folder, with progress', async () => {
    let n = 0
    api.createFolder.mockImplementation(async (_parent: string | null, name: string) => ({ ...folder, id: `d${++n}`, name }))
    let release!: () => void
    const held = new Promise<void>((ok) => (release = ok))
    api.upload.mockImplementation(async (_folderId: string | null, files: File[]) => {
      if (files[0]!.name === 'b.txt') await held
      return { uploaded: files.map((f) => ({ ...image, name: f.name, outcome: 'created' })), errors: [], conflicts: [] }
    })
    render(DriveBrowser, { props: { folderId: 'f0', path: [{ id: 'f0', name: 'Top' }], items: [], canEdit: true } })
    await expect.element(page.getByTestId('drive-upload-folder')).toBeInTheDocument()
    const input = page.getByTestId('drive-upload-folder-input').element() as HTMLInputElement
    expect(input.webkitdirectory).toBe(true)
    const picked = [
      ['a.txt', 'Trip/a.txt'],
      ['b.txt', 'Trip/day 2/b.txt'],
    ].map(([name, rel]) => {
      const f = new File(['x'], name!)
      Object.defineProperty(f, 'webkitRelativePath', { value: rel })
      return f
    })
    Object.defineProperty(input, 'files', { value: picked, configurable: true })
    input.dispatchEvent(new Event('change', { bubbles: true }))

    await expect.element(page.getByTestId('drive-upload-progress')).toHaveTextContent('Uploading 2 of 2 files · Trip/day 2/b.txt')
    release()
    await expect.element(page.getByTestId('drive-notice')).toHaveTextContent('Uploaded 2 files in 2 folders.')
    expect(api.createFolder.mock.calls).toEqual([
      ['f0', 'Trip'],
      ['d1', 'day 2'],
    ])
    expect(api.upload.mock.calls.map(([id, files]) => [id, files.map((f: File) => f.name)])).toEqual([
      ['d1', ['a.txt']],
      ['d2', ['b.txt']],
    ])
    expect(page.getByTestId('drive-upload-progress').elements()).toHaveLength(0)
    expect(invalidateAllMock).toHaveBeenCalled()
  })

  it('a folder dropped from the desktop onto a folder row lands inside it; what didn’t upload is listed by path', async () => {
    let n = 0
    api.createFolder.mockImplementation(async (_parent: string | null, name: string) => ({ ...folder, id: `d${++n}`, name }))
    api.upload.mockImplementation(async (_folderId: string | null, files: File[]) =>
      files[0]!.name === 'huge.bin'
        ? { uploaded: [], errors: ['“huge.bin” is 120 MB; files can be at most 100 MB.'], conflicts: [] }
        : { uploaded: [{ ...image, name: files[0]!.name, outcome: 'created' }], errors: [], conflicts: [] },
    )
    const kid = (name: string) =>
      ({ isFile: true, isDirectory: false, name, file: (ok: (f: File) => void) => ok(new File(['x'], name)) }) as unknown as FileSystemEntry
    const tree = {
      isFile: false,
      isDirectory: true,
      name: 'Photos',
      createReader: () => {
        let read = false
        return {
          readEntries: (ok: (e: FileSystemEntry[]) => void) => {
            ok(read ? [] : [kid('one.jpg'), kid('huge.bin')])
            read = true
          },
        }
      },
    }
    // The browser hands a dropped folder over as a directory entry.
    const original = DataTransferItem.prototype.webkitGetAsEntry
    DataTransferItem.prototype.webkitGetAsEntry = function () {
      return tree as unknown as FileSystemEntry
    }
    try {
      render(DriveBrowser, { props: { folderId: null, items: [folder], canEdit: true } })
      const data = desktopFiles('Photos')
      fire(rowNamed('Projects'), 'dragenter', data)
      fire(rowNamed('Projects'), 'dragover', data)
      await expect.element(page.getByTestId('drive-drop-target')).toHaveTextContent('Upload here')
      fire(rowNamed('Projects'), 'drop', data)
      await expect.element(page.getByTestId('drive-notice')).toHaveTextContent('Uploaded 1 file in 1 folder to Projects.')
    } finally {
      DataTransferItem.prototype.webkitGetAsEntry = original
    }
    expect(api.createFolder).toHaveBeenCalledWith('f1', 'Photos')
    expect(api.upload.mock.calls.map(([id, files]) => [id, files[0].name])).toEqual([
      ['d1', 'one.jpg'],
      ['d1', 'huge.bin'],
    ])
    await expect.element(page.getByTestId('drive-upload-failures')).toHaveTextContent('1 item wasn’t uploaded:')
    await expect
      .element(page.getByTestId('drive-upload-failure'))
      .toHaveTextContent('Photos/huge.bin — “huge.bin” is 120 MB; files can be at most 100 MB.')
  })

  it('uploading a name that is already here asks first: Replace sends it as a new version, Cancel leaves the next one out (bug f45acdef)', async () => {
    api.upload.mockImplementation(async (_folderId: string | null, files: File[], onConflict: string) => {
      const f = files[0]!
      if (onConflict === 'fail' && f.name !== 'new.txt')
        return {
          uploaded: [],
          errors: [],
          conflicts: [{ name: f.name, error: `“${f.name}” already exists in Top.`, existing: { ...image, id: `old-${f.name}`, name: f.name } }],
        }
      return { uploaded: [{ ...image, name: f.name, outcome: onConflict === 'replace' ? 'replaced' : 'created' }], errors: [], conflicts: [] }
    })
    render(DriveBrowser, { props: { folderId: 'f0', path: [{ id: 'f0', name: 'Top' }], items: [], canEdit: true } })
    const input = page.getByTestId('drive-upload-input').element() as HTMLInputElement
    Object.defineProperty(input, 'files', { value: ['mood.png', 'new.txt', 'plan.md'].map((n) => new File(['x'], n)), configurable: true })
    input.dispatchEvent(new Event('change', { bubbles: true }))

    const dialog = page.getByTestId('drive-upload-conflict')
    await expect.element(dialog).toHaveTextContent('“mood.png” already exists in Top.')
    await page.getByTestId('drive-upload-conflict-replace').click()
    await expect.element(dialog).toHaveTextContent('“plan.md” already exists in Top.')
    await page.getByTestId('drive-upload-conflict-cancel').click()
    await expect
      .element(page.getByTestId('drive-notice'))
      .toHaveTextContent('Uploaded 1 file. Replaced 1 file with a new version (the old one stays in its history). Left out 1 file that is already there.')
    expect(api.upload.mock.calls.map(([id, files, mode]) => [id, files[0].name, mode])).toEqual([
      ['f0', 'mood.png', 'fail'],
      ['f0', 'mood.png', 'replace'],
      ['f0', 'new.txt', 'fail'],
      ['f0', 'plan.md', 'fail'],
    ])
    expect(page.getByTestId('drive-upload-conflict').elements()).toHaveLength(0)
  })
})

describe('drive-browser: unified overview origins and filter pills', () => {
  type OverviewListed = DriveItem & {
    canEdit: boolean
    canManage: boolean
    origin: DriveOrigin
    originLabel: string
  }

  const overviewItems: OverviewListed[] = [
    {
      ...folder,
      id: 'f-mine',
      name: 'Projects',
      origin: 'mine',
      originLabel: 'My drive',
    },
    {
      ...image,
      id: 'd-mine',
      name: 'notes.md',
      mime: 'text/markdown',
      canEdit: true,
      canManage: true,
      origin: 'mine',
      originLabel: 'My drive',
    },
    {
      ...folder,
      id: 'f-shared',
      name: 'Team',
      ownerId: 'u2',
      canEdit: false,
      canManage: false,
      origin: 'shared',
      originLabel: 'Shared with me',
    },
    {
      ...folder,
      id: 'f-msg',
      name: '#general',
      ownerId: 'messages',
      canEdit: true,
      canManage: false,
      origin: 'messages',
      originLabel: 'Messages',
    },
    {
      ...folder,
      id: 'f-gh',
      name: 'GitHub',
      ownerId: 'repos',
      canEdit: false,
      canManage: false,
      origin: 'source',
      originLabel: 'GitHub',
    },
  ]

  const overviewDescribe = {
    'folder:f-mine': { ownerName: 'Ada Owner', shared: false, readOnlyFrom: null },
    'file:d-mine': { ownerName: 'Ada Owner', shared: false, readOnlyFrom: null },
    'folder:f-shared': { ownerName: 'Ben Member', shared: null, readOnlyFrom: null },
    'folder:f-msg': { ownerName: 'Messages', shared: null, readOnlyFrom: null },
    'folder:f-gh': { ownerName: 'GitHub', shared: false, readOnlyFrom: 'GitHub' },
  }

  beforeEach(() => {
    localStorage.clear()
    vi.resetAllMocks()
  })

  it('renders filter pills, color-coded origin badges in list and grid, and updates visible count', async () => {
    render(DriveBrowser, {
      props: {
        folderId: null,
        root: { label: 'Overview', href: '/drive' },
        items: overviewItems,
        canEdit: true,
        describe: overviewDescribe,
      },
    })

    await expect.element(page.getByTestId('drive-filter-bar')).toBeInTheDocument()
    await expect.element(page.getByTestId('drive-filter-all')).toHaveAttribute('aria-pressed', 'true')
    await expect.element(page.getByTestId('drive-filter-mine')).toBeInTheDocument()
    await expect.element(page.getByTestId('drive-filter-shared')).toBeInTheDocument()
    await expect.element(page.getByTestId('drive-filter-messages')).toBeInTheDocument()
    await expect.element(page.getByTestId('drive-filter-source-github')).toBeInTheDocument()
    await expect.element(page.getByTestId('drive-visible-count')).toHaveTextContent('5 items')

    const badges = page.getByTestId('drive-origin-badge')
    expect(badges.elements()).toHaveLength(5)
    expect(badges.elements().map((el) => [el.getAttribute('data-origin'), el.textContent?.trim()])).toEqual([
      ['mine', 'My drive'],
      ['mine', 'My drive'],
      ['shared', 'Shared with me'],
      ['messages', 'Messages'],
      ['source', 'GitHub'],
    ])

    await page.getByTestId('drive-filter-mine').click()
    await expect.element(page.getByTestId('drive-filter-mine')).toHaveAttribute('aria-pressed', 'true')
    expect(page.getByTestId('drive-row').elements().map((el) => el.getAttribute('data-name'))).toEqual([
      'Projects',
      'notes.md',
    ])
    await expect.element(page.getByTestId('drive-visible-count')).toHaveTextContent('2 of 5 items')

    await page.getByTestId('drive-type-file').click()
    await expect.element(page.getByTestId('drive-type-file')).toHaveAttribute('aria-pressed', 'true')
    expect(page.getByTestId('drive-row').elements().map((el) => el.getAttribute('data-name'))).toEqual(['notes.md'])
    await expect.element(page.getByTestId('drive-visible-count')).toHaveTextContent('1 of 5 items')

    await page.getByTestId('drive-type-all').click()
    await page.getByTestId('drive-filter-source-github').click()
    expect(page.getByTestId('drive-row').elements().map((el) => el.getAttribute('data-name'))).toEqual(['GitHub'])
    await expect.element(page.getByTestId('drive-readonly-badge')).toHaveTextContent('Read-only')

    await page.getByTestId('drive-filter-all').click()
    expect(page.getByTestId('drive-row').elements()).toHaveLength(5)

    // Grid cards also display the origin badges.
    await page.getByTestId('drive-view-grid').click()
    await expect.element(page.getByTestId('drive-grid')).toBeInTheDocument()
    expect(page.getByTestId('drive-origin-badge').elements().map((el) => el.getAttribute('data-origin'))).toEqual([
      'mine',
      'mine',
      'shared',
      'messages',
      'source',
    ])
  })

  it('syncs initial origin prop without $effect, allows resetting empty filtered views, and follows rerenders', async () => {
    const sharedOnly = [overviewItems[2]!]
    const view = render(DriveBrowser, {
      props: {
        folderId: null,
        root: { label: 'Overview', href: '/drive' },
        items: sharedOnly,
        canEdit: true,
        origin: 'mine',
      },
    })

    await expect.element(page.getByTestId('drive-filter-bar')).toBeInTheDocument()
    await expect.element(page.getByTestId('drive-filter-mine')).toHaveAttribute('aria-pressed', 'true')
    await expect.element(page.getByTestId('drive-empty')).toHaveTextContent('Nothing in My drive yet.')
    await page.getByTestId('drive-filter-reset').click()
    await expect.element(page.getByTestId('drive-filter-all')).toHaveAttribute('aria-pressed', 'true')
    expect(page.getByTestId('drive-row').elements().map((el) => el.getAttribute('data-name'))).toEqual(['Team'])

    await view.rerender({
      folderId: null,
      root: { label: 'Overview', href: '/drive' },
      items: overviewItems,
      canEdit: true,
      origin: 'shared',
    })
    await expect.element(page.getByTestId('drive-filter-shared')).toHaveAttribute('aria-pressed', 'true')
    expect(page.getByTestId('drive-row').elements().map((el) => el.getAttribute('data-name'))).toEqual(['Team'])
  })

  it('creates new folders and drops uploads into My drive from the overview', async () => {
    api.createFolder.mockResolvedValue({ ...folder, id: 'f-inbox', name: 'Inbox' })
    render(DriveBrowser, {
      props: {
        folderId: null,
        root: { label: 'Overview', href: '/drive' },
        items: overviewItems,
        canEdit: true,
      },
    })

    const pane = page.getByTestId('drive-browser').element()
    fire(pane, 'dragenter', desktopFiles('a.txt'))
    await expect.element(page.getByTestId('drive-drop-overlay')).toHaveTextContent('Drop to upload to My drive')
    fire(pane, 'dragleave', desktopFiles('a.txt'))

    await page.getByTestId('drive-new-folder-button').click()
    await page.getByTestId('drive-name-input').fill('Inbox')
    await page.getByTestId('drive-name-save').click()
    expect(api.createFolder).toHaveBeenCalledWith(null, 'Inbox')
  })

  it('keeps filter bar and origin badges hidden on non-overview listings', async () => {
    render(DriveBrowser, {
      props: { folderId: null, items: [folder, image], canEdit: true, describe: describe_ },
    })
    expect(page.getByTestId('drive-filter-bar').elements()).toHaveLength(0)
    expect(page.getByTestId('drive-origin-badge').elements()).toHaveLength(0)
  })
})
