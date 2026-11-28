import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getTextFileMock } = vi.hoisted(() => ({ getTextFileMock: vi.fn() }))
vi.mock('$lib/server/text-files/service', () => ({ getTextFile: getTextFileMock }))

import { load } from './+page.server'

/** Memory's Documents tab is gone (wish f3fc516e): documents are Drive files; old links land in Drive. */
describe('memory/notes page server load', () => {
  const user = { id: 'u1', email: 'a@b.c' }
  const event = (search = '') =>
    ({ locals: { user }, url: new URL(`http://x/m/memory/notes${search}`) }) as never

  beforeEach(() => getTextFileMock.mockReset())

  it('redirects unauthenticated users to login', async () => {
    await expect(
      load({ locals: { user: null }, url: new URL('http://x/m/memory/notes') } as never),
    ).rejects.toMatchObject({
      status: 302,
      location: '/login',
    })
  })

  it('sends the Documents tab to Drive', async () => {
    await expect(load(event())).rejects.toMatchObject({ status: 308, location: '/drive' })
  })

  it('sends a link to one document (its Drive id or its old text-file id) to its Drive file', async () => {
    getTextFileMock.mockResolvedValue({ id: 'drive-file-1' })
    await expect(load(event('?note=old-id'))).rejects.toMatchObject({
      status: 308,
      location: '/drive/file/drive-file-1',
    })
    expect(getTextFileMock).toHaveBeenCalledWith('u1', 'old-id')
  })

  it('a document the reader cannot open lands on Drive', async () => {
    getTextFileMock.mockResolvedValue(null)
    await expect(load(event('?note=gone'))).rejects.toMatchObject({
      status: 308,
      location: '/drive',
    })
  })
})
