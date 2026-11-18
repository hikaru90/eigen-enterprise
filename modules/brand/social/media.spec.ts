import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import { createSocialMediaService, validateUploadFiles, type SocialBlobStore } from './media'
import { InMemorySocialPostStore } from './store'

const person = { kind: 'user' as const, userId: 'ana' }
const bytes = (s: string) => new TextEncoder().encode(s)

describe('validateUploadFiles', () => {
  const img = (name: string) => ({ name, mime: 'image/jpeg', bytes: bytes(name) })
  it('takes images (a carousel) or exactly one video', () => {
    expect(() => validateUploadFiles([img('a.jpg'), img('b.jpg')], 1000)).not.toThrow()
    expect(() => validateUploadFiles([{ name: 'c.mp4', mime: 'video/mp4', bytes: bytes('x') }], 1000)).not.toThrow()
  })
  it('refuses nothing, unknown types, mixes, too many, empty and too large files', () => {
    expect(() => validateUploadFiles([], 1000)).toThrow(/at least one/)
    expect(() => validateUploadFiles([{ name: 'a.pdf', mime: 'application/pdf', bytes: bytes('x') }], 1000)).toThrow(/supported/)
    expect(() => validateUploadFiles([img('a.jpg'), { name: 'c.mp4', mime: 'video/mp4', bytes: bytes('x') }], 1000)).toThrow(/exactly one video/)
    expect(() => validateUploadFiles(Array.from({ length: 11 }, (_, i) => img(`${i}.jpg`)), 1000)).toThrow(/at most 10/)
    expect(() => validateUploadFiles([{ name: 'e.png', mime: 'image/png', bytes: new Uint8Array() }], 1000)).toThrow(/empty/)
    expect(() => validateUploadFiles([img('big.jpg')], 3)).toThrow(/larger than/)
    expect(() => validateUploadFiles([img('  ')], 1000)).toThrow(/needs a name/)
  })
})

/** Content-addressed bytes in memory (the app wires the disk store). */
function memoryBlobs(): SocialBlobStore & { has(sha: string): boolean } {
  const blobs = new Map<string, Uint8Array>()
  return {
    async put(b) {
      const sha256 = createHash('sha256').update(b).digest('hex')
      blobs.set(sha256, b)
      return { sha256, size: b.byteLength }
    },
    async get(sha) {
      const b = blobs.get(sha)
      if (!b) throw new Error(`no blob ${sha}`)
      return b
    },
    async remove(sha) {
      blobs.delete(sha)
    },
    has: (sha) => blobs.has(sha),
  }
}

describe('social media service', () => {
  let blobs: ReturnType<typeof memoryBlobs>
  beforeEach(() => {
    blobs = memoryBlobs()
  })

  it('stores the bytes, reads them back, and frees them with the last post that uses them', async () => {
    const posts = new InMemorySocialPostStore()
    const media = createSocialMediaService({ posts, blobs, maxUploadBytes: 1000 })
    const file = { name: 'team.png', mime: 'image/png', bytes: bytes('png-bytes') }
    const a = await media.uploadPost(person, { title: 'A', networks: ['instagram'] }, [file])
    const b = await media.uploadPost(person, { title: 'B', networks: ['linkedin'] }, [file])
    const read = await media.readMedia(a.media[0].id)
    expect(new TextDecoder().decode(read.bytes)).toBe('png-bytes')
    expect(read.media).toMatchObject({ name: 'team.png', mime: 'image/png', size: 9 })

    await media.deletePost(a.id)
    expect(blobs.has(b.media[0].sha256)).toBe(true)
    await media.deletePost(b.id)
    expect(blobs.has(b.media[0].sha256)).toBe(false)
    await expect(media.readMedia(b.media[0].id)).rejects.toMatchObject({ code: 'not_found' })
  })

  it('a refused upload stores nothing', async () => {
    const posts = new InMemorySocialPostStore()
    const media = createSocialMediaService({ posts, blobs, maxUploadBytes: 1000 })
    await expect(media.uploadPost(person, { title: 'X', networks: ['x'] }, [{ name: 'a.txt', mime: 'text/plain', bytes: bytes('t') }])).rejects.toThrow()
    await expect(posts.list()).resolves.toEqual([])
  })
})
