import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import type { ArchiveGroup, DriveItem } from '$lib/drive/api'
import ArchivedView from './archived-view.svelte'

const { invalidateAllMock, api } = vi.hoisted(() => ({
  invalidateAllMock: vi.fn(async () => {}),
  api: {
    unarchive: vi.fn(),
    archiveMany: vi.fn(),
    suggestArchive: vi.fn(),
  },
}))
vi.mock('$app/navigation', () => ({ goto: vi.fn(), invalidateAll: invalidateAllMock }))
vi.mock('$app/paths', () => ({ base: '', resolve: (path: string) => path }))
vi.mock('$lib/drive/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('$lib/drive/api')>()
  return { ...real, driveApi: { ...real.driveApi, ...api } }
})

const file = (over: Partial<DriveItem> & { id: string; name: string }): DriveItem & { canEdit: boolean; archivedByName: string | null } => ({
  type: 'file',
  parentId: 'y2023',
  ownerId: 'u1',
  updatedAt: '2024-03-01T10:00:00.000Z',
  trashedAt: null,
  archivedAt: '2026-11-10T09:00:00.000Z',
  archivedBy: 'u1',
  size: 2048,
  mime: 'text/markdown',
  canEdit: true,
  archivedByName: 'Ada Owner',
  ...over,
})

const groups: ArchiveGroup[] = [
  { key: 'root', folder: null, root: { label: 'My drive', href: '/drive' }, path: [], items: [file({ id: 'top', name: 'top.md', parentId: null })] },
  {
    key: 'y2023',
    folder: { id: 'y2023', name: '2023' },
    root: { label: 'My drive', href: '/drive' },
    path: [
      { id: 'p', name: 'Projects' },
      { id: 'y2023', name: '2023' },
    ],
    items: [file({ id: 'a', name: 'a.md' }), file({ id: 'b', name: 'b.md', canEdit: false })],
  },
]

describe('archived-view: the Archived view', () => {
  beforeEach(() => vi.clearAllMocks())

  it('groups archived items by the folder they are in, with when and by whom; each still opens', async () => {
    render(ArchivedView, { props: { groups, suggestDays: 180 } })
    const heads = page.getByTestId('drive-archive-group-title')
    await expect.element(heads.first()).toHaveTextContent('My drive')
    await expect.element(heads.nth(1)).toHaveTextContent('My drive / Projects / 2023')
    await expect.element(page.getByRole('link', { name: '2023', exact: true })).toHaveAttribute('href', '/drive/folder/y2023')
    expect(page.getByTestId('drive-archive-row').elements()).toHaveLength(3)
    await expect.element(page.getByRole('link', { name: 'a.md', exact: true })).toHaveAttribute('href', '/drive/file/a')
    await expect.element(page.getByTestId('drive-archived-by').first()).toHaveTextContent('Ada Owner')
  })

  it('Unarchive is offered where you may edit, and says where the item is back', async () => {
    api.unarchive.mockResolvedValue({ item: file({ id: 'a', name: 'a.md', archivedAt: null }), stillIn: null })
    render(ArchivedView, { props: { groups, suggestDays: 180 } })
    // b.md is view-only: no Unarchive for it.
    expect(page.getByTestId('drive-unarchive').elements()).toHaveLength(2)
    await page.getByRole('button', { name: 'Unarchive a.md' }).click()
    expect(api.unarchive).toHaveBeenCalledWith(expect.objectContaining({ type: 'file', id: 'a' }))
    await expect.element(page.getByTestId('drive-notice')).toHaveTextContent('“a.md” is back in 2023.')
    expect(invalidateAllMock).toHaveBeenCalled()
  })

  it('unarchiving inside a folder that is still archived says so', async () => {
    api.unarchive.mockResolvedValue({ item: file({ id: 'a', name: 'a.md', archivedAt: null }), stillIn: { id: 'p', name: 'Projects' } })
    render(ArchivedView, { props: { groups, suggestDays: 180 } })
    await page.getByRole('button', { name: 'Unarchive a.md' }).click()
    await expect.element(page.getByTestId('drive-notice')).toHaveTextContent('“Projects”, the folder it is in, is still archived.')
  })

  it('an empty archive explains what archiving is and offers the suggestions', async () => {
    render(ArchivedView, { props: { groups: [], suggestDays: 180 } })
    await expect.element(page.getByTestId('drive-empty')).toHaveTextContent('Nothing is archived.')
    await expect.element(page.getByTestId('drive-suggest-archive')).toBeInTheDocument()
  })
})

describe('archive suggestions: the AI suggests, the person decides', () => {
  beforeEach(() => vi.clearAllMocks())

  const suggestion = (id: string, name: string, reason: string) => ({
    file: file({ id, name, archivedAt: null, archivedBy: null }),
    root: { label: 'My drive', href: '/drive' },
    path: [{ id: 'p', name: 'Projects' }],
    reason,
  })

  it('asks for files unchanged in the chosen time, shows each with its reason, and archives only what stays ticked', async () => {
    api.suggestArchive.mockResolvedValue({
      olderThanDays: 365,
      considered: 12,
      more: false,
      suggestions: [suggestion('d1', 'draft-v1.md', 'An early draft, replaced by v3.'), suggestion('e1', 'export-2023.csv', 'A one-off export from 2023.')],
    })
    api.archiveMany.mockResolvedValue({ archived: [file({ id: 'd1', name: 'draft-v1.md' })], errors: [] })
    render(ArchivedView, { props: { groups, suggestDays: 180 } })
    await page.getByTestId('drive-suggest-archive').click()
    await page.getByTestId('drive-suggest-age').selectOptions('365')
    await page.getByTestId('drive-suggest-run').click()
    expect(api.suggestArchive).toHaveBeenCalledWith(365)
    await expect.element(page.getByTestId('drive-suggest-summary')).toHaveTextContent('2 of 12 files')
    const rows = page.getByTestId('drive-suggestion')
    await expect.element(rows.first()).toHaveTextContent('An early draft, replaced by v3.')
    await expect.element(rows.first()).toHaveTextContent('My drive / Projects')
    expect(api.archiveMany).not.toHaveBeenCalled()

    await page.getByRole('checkbox', { name: 'Archive export-2023.csv' }).click()
    await expect.element(page.getByTestId('drive-suggest-confirm')).toHaveTextContent('Archive 1 file')
    await page.getByTestId('drive-suggest-confirm').click()
    expect(api.archiveMany).toHaveBeenCalledWith([{ type: 'file', id: 'd1' }])
    await expect.element(page.getByTestId('drive-notice')).toHaveTextContent('Archived 1 file.')
    expect(invalidateAllMock).toHaveBeenCalled()
  })

  it('nothing to suggest is said plainly', async () => {
    api.suggestArchive.mockResolvedValue({ olderThanDays: 180, considered: 0, more: false, suggestions: [] })
    render(ArchivedView, { props: { groups, suggestDays: 180 } })
    await page.getByTestId('drive-suggest-archive').click()
    await page.getByTestId('drive-suggest-run').click()
    await expect.element(page.getByTestId('drive-suggest-summary')).toHaveTextContent('No file you can edit has gone unchanged that long.')
    expect(page.getByTestId('drive-suggest-confirm').elements()).toHaveLength(0)
  })

  it('no AI provider: the server’s sentence is shown, nothing else happens', async () => {
    api.suggestArchive.mockRejectedValue(new Error('The company has no AI provider set up yet, so Drive can’t suggest what to archive.'))
    render(ArchivedView, { props: { groups, suggestDays: 180 } })
    await page.getByTestId('drive-suggest-archive').click()
    await page.getByTestId('drive-suggest-run').click()
    await expect.element(page.getByTestId('drive-suggest-error')).toHaveTextContent('no AI provider set up yet')
    expect(api.archiveMany).not.toHaveBeenCalled()
  })
})
