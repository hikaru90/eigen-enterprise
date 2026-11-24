import { beforeEach, describe, expect, it, vi } from 'vitest'

const { holder } = vi.hoisted(() => ({ holder: { drive: null as unknown } }))

vi.mock('$lib/server/drive', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/server/drive')>()
  return { ...actual, driveService: async () => holder.drive }
})

const { GET } = await import('./+server')
const { DriveError } = await import('$lib/server/drive')

const event = (q = '', user: { id: string } | null = { id: 'u1' }) =>
  ({
    locals: { user },
    url: new URL(`https://ee.test/api/messages/drive-folders${q ? `?q=${encodeURIComponent(q)}` : ''}`),
    request: new Request(`https://ee.test/api/messages/drive-folders${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  }) as never

const folderItem = (id: string, name: string, opts: { parentId?: string | null; inArchive?: boolean; archivedAt?: Date | null } = {}) => ({
  type: 'folder' as const,
  id,
  name,
  parentId: opts.parentId ?? null,
  ownerId: 'u1',
  updatedAt: new Date('2026-11-24T10:00:00Z'),
  trashedAt: null,
  archivedAt: opts.archivedAt ?? null,
  archivedBy: null,
  inArchive: opts.inArchive,
})

const fileItem = (id: string, name: string) => ({
  type: 'file' as const,
  id,
  name,
  parentId: null,
  ownerId: 'u1',
  updatedAt: new Date('2026-11-24T10:00:00Z'),
  trashedAt: null,
  archivedAt: null,
  archivedBy: null,
  size: 100,
  mime: 'text/plain',
})

describe('GET /api/messages/drive-folders', () => {
  beforeEach(() => {
    holder.drive = {
      listFolder: vi.fn(async (_actor: unknown, id: string | null) => {
        if (id === null) {
          return {
            folder: null,
            path: [],
            root: { label: 'My drive', href: '/drive' },
            items: [folderItem('f-my', 'Projects'), fileItem('file-1', 'notes.md')],
            canEdit: true,
            canManage: false,
            archivedIn: null,
          }
        }
        if (id === 'f-sub') {
          return {
            folder: folderItem('f-sub', 'Designs', { parentId: 'f-my' }),
            path: [
              { id: 'f-my', name: 'Projects' },
              { id: 'f-sub', name: 'Designs' },
            ],
            root: { label: 'My drive', href: '/drive' },
            items: [],
            canEdit: true,
            canManage: false,
            archivedIn: null,
          }
        }
        if (id === 'f-denied') {
          throw new DriveError('not_found', 'No such folder.')
        }
        throw new DriveError('not_found', 'No such folder.')
      }),
      sharedWithMe: vi.fn(async () => [
        folderItem('f-shared', 'Shared Specs'),
        folderItem('f-my', 'Projects'), // duplicate to verify deduplication
        fileItem('file-shared', 'sheet.csv'),
      ]),
      messagesFolders: vi.fn(async () => [folderItem('f-msg', '#general')]),
      sourceRoots: vi.fn(async () => [
        { source: 'github', folderId: 'f-src', name: 'GitHub', href: '/drive/folder/f-src' },
      ]),
      search: vi.fn(async () => [
        folderItem('f-sub', 'Designs', { parentId: 'f-my' }),
        fileItem('file-design', 'design.fig'),
        folderItem('f-denied', 'Hidden Designs'),
      ]),
    }
  })

  it('rejects unauthenticated requests with 401', async () => {
    const res = await GET(event('', null))
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/sign in/i)
  })

  it('lists deduplicated accessible folders from My drive, Shared with me, Messages, and Source roots when ?q= is empty', async () => {
    const res = await GET(event(''))
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      folders: Array<{ id: string; name: string; pathLabel: string; href: string }>
    }
    expect(body.folders).toEqual([
      { id: 'f-my', name: 'Projects', pathLabel: 'My drive', href: '/drive/folder/f-my' },
      {
        id: 'f-shared',
        name: 'Shared Specs',
        pathLabel: 'Shared with me',
        href: '/drive/folder/f-shared',
      },
      { id: 'f-msg', name: '#general', pathLabel: 'Messages', href: '/drive/folder/f-msg' },
      { id: 'f-src', name: 'GitHub', pathLabel: 'GitHub', href: '/drive/folder/f-src' },
    ])
  })

  it('searches folders by ?q=, excludes files and inaccessible hits, and resolves breadcrumb pathLabel', async () => {
    const res = await GET(event('design'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      folders: Array<{ id: string; name: string; pathLabel: string; href: string }>
    }
    expect(body.folders).toEqual([
      {
        id: 'f-sub',
        name: 'Designs',
        pathLabel: 'My drive / Projects',
        href: '/drive/folder/f-sub',
      },
    ])
  })

  it('maps top-level DriveError to its HTTP status and error report', async () => {
    const drive = holder.drive as { search: ReturnType<typeof vi.fn> }
    drive.search.mockRejectedValueOnce(new DriveError('forbidden', 'Access denied'))
    const res = await GET(event('design'))
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: string; code: string }
    expect(body.code).toBe('forbidden')
    expect(body.error).toBe('Access denied')
  })
})
