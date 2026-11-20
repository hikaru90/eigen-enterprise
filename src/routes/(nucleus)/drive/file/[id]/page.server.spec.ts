import { beforeEach, describe, expect, it, vi } from 'vitest'

const { holder } = vi.hoisted(() => ({ holder: { drive: null as unknown, readText: vi.fn() } }))
vi.mock('$lib/server/drive', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/server/drive')>()
  return { ...actual, driveService: async () => holder.drive }
})

const { load, TEXT_PREVIEW_MAX_BYTES } = await import('./+page.server')

const file = (size: number) => ({
  type: 'file',
  id: 'source-code',
  name: 'index.ts',
  parentId: 'src',
  ownerId: 'repos',
  updatedAt: new Date('2026-11-20T10:00:00Z'),
  trashedAt: null,
  archivedAt: null,
  archivedBy: null,
  size,
  mime: 'text/plain; charset=utf-8',
})

describe('/drive/file/[id] text previews', () => {
  beforeEach(() => {
    holder.readText = vi.fn(async () => ({ file: file(TEXT_PREVIEW_MAX_BYTES), content: 'export const answer = 42\n' }))
    holder.drive = {
      fileInfo: vi.fn(async (_actor: unknown, id: string) => ({
        file: file(id === 'too-large' ? TEXT_PREVIEW_MAX_BYTES + 1 : TEXT_PREVIEW_MAX_BYTES),
        path: [],
        root: { label: 'GitHub', href: '/drive/folder/root' },
        canEdit: false,
        canManage: false,
        archivedIn: null,
      })),
      readText: holder.readText,
      describeItems: vi.fn(async () => ({
        'file:source-code': { ownerName: 'GitHub', shared: false, readOnlyFrom: 'GitHub' },
      })),
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
})
