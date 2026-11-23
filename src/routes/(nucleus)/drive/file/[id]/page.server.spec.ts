import { beforeEach, describe, expect, it, vi } from 'vitest'

const { holder } = vi.hoisted(() => ({ holder: { drive: null as unknown, readText: vi.fn() } }))
vi.mock('$lib/server/drive', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/server/drive')>()
  return { ...actual, driveService: async () => holder.drive }
})

vi.mock('$lib/server/drive-view', () => ({ driveViewUrl: () => '/api/drive/view/token/site.html' }))

const { load } = await import('./+page.server')
const { TEXT_PREVIEW_MAX_BYTES } = await import('$lib/server/drive')

const file = (size: number | undefined, name = 'index.ts', mime = 'text/plain; charset=utf-8') => ({
  type: 'file',
  id: 'source-code',
  name,
  parentId: 'src',
  ownerId: 'repos',
  updatedAt: new Date('2026-11-20T10:00:00Z'),
  trashedAt: null,
  archivedAt: null,
  archivedBy: null,
  size,
  mime,
})

/** The file each test id opens: its size and kind. */
const FILES: Record<string, () => ReturnType<typeof file>> = {
  'source-code': () => file(TEXT_PREVIEW_MAX_BYTES),
  'too-large': () => file(TEXT_PREVIEW_MAX_BYTES + 1),
  'huge-md': () => file(TEXT_PREVIEW_MAX_BYTES + 1, 'notes.md', 'text/markdown'),
  'huge-csv': () => file(TEXT_PREVIEW_MAX_BYTES + 1, 'data.csv', 'text/csv'),
  'huge-html': () => file(TEXT_PREVIEW_MAX_BYTES + 1, 'site.html', 'text/html'),
  'no-size': () => file(undefined),
  'replaced-image': () => file(2048, 'logo.png', 'image/png'),
}

describe('/drive/file/[id] text previews', () => {
  beforeEach(() => {
    holder.readText = vi.fn(async () => ({ file: file(TEXT_PREVIEW_MAX_BYTES), content: 'export const answer = 42\n' }))
    holder.drive = {
      fileInfo: vi.fn(async (_actor: unknown, id: string) => ({
        file: FILES[id]!(),
        path: [],
        root: { label: 'GitHub', href: '/drive/folder/root' },
        canEdit: id === 'huge-md' || id === 'huge-csv',
        canManage: false,
        archivedIn: null,
      })),
      readText: holder.readText,
      describeItems: vi.fn(async () => ({
        'file:source-code': { ownerName: 'GitHub', shared: false, readOnlyFrom: 'GitHub' },
      })),
      listRevisions: vi.fn(async () => []),
      shareTargets: vi.fn(async () => ({ people: [], groups: [] })),
    }
  })

  it('refuses to read a text file over 2 MB and offers a clear download explanation', async () => {
    const result = (await load({ locals: { user: { id: 'alice' } }, params: { id: 'too-large' } } as never)) as {
      text: string | null
      textError: string | null
    }
    expect(holder.readText).not.toHaveBeenCalled()
    expect(result.text).toBeNull()
    expect(result.textError).toContain('too large to preview, download')
  })

  it('still reads a text file at the 2 MB boundary', async () => {
    const result = (await load({ locals: { user: { id: 'alice' } }, params: { id: 'source-code' } } as never)) as {
      text: string | null
      textError: string | null
    }
    expect(holder.readText).toHaveBeenCalledOnce()
    expect(result.text).toBe('export const answer = 42\n')
    expect(result.textError).toBeNull()
  })

  it.each(['huge-md', 'huge-csv', 'huge-html'])('caps every previewed text kind at 2 MB, the editor included (%s)', async (id) => {
    const result = (await load({ locals: { user: { id: 'alice' } }, params: { id } } as never)) as {
      text: string | null
      html: string | null
      table: unknown
      content: string | null
      editable: boolean
      textError: string | null
      viewUrl: string | null
    }
    expect(holder.readText).not.toHaveBeenCalled()
    expect(result).toMatchObject({ text: null, html: null, table: null, content: null, editable: false })
    expect(result.textError).toContain('too large to preview, download')
    // An HTML page still renders as itself; only its source text is not loaded.
    if (id === 'huge-html') expect(result).toMatchObject({ viewUrl: '/api/drive/view/token/site.html' })
  })

  it('fails loud when a previewed file has no size', async () => {
    await expect(load({ locals: { user: { id: 'alice' } }, params: { id: 'no-size' } } as never)).rejects.toThrow(/no size/)
    expect(holder.readText).not.toHaveBeenCalled()
  })

  it('lists an image’s revisions with their authors once an upload replaced it (the old version stays restorable)', async () => {
    const d = holder.drive as { listRevisions: ReturnType<typeof vi.fn>; shareTargets: ReturnType<typeof vi.fn> }
    const revs = [
      { id: 'r2', fileId: 'source-code', sha256: 'b', size: 2048, authorId: 'alice', createdAt: new Date('2026-11-21T10:00:00Z') },
      { id: 'r1', fileId: 'source-code', sha256: 'a', size: 1024, authorId: 'bob', createdAt: new Date('2026-11-20T10:00:00Z') },
    ]
    d.listRevisions.mockResolvedValue(revs)
    d.shareTargets.mockResolvedValue({ people: [{ id: 'alice', name: 'Alice', email: 'a@x' }, { id: 'bob', name: '', email: 'bob@x' }], groups: [] })
    const result = (await load({ locals: { user: { id: 'alice' } }, params: { id: 'replaced-image' } } as never)) as {
      revisions: unknown[]
      authors: Record<string, string>
      editable: boolean
    }
    expect(result.revisions).toEqual(revs)
    expect(result.authors).toEqual({ alice: 'Alice', bob: 'bob@x' })
    expect(result.editable).toBe(false)
  })
})
