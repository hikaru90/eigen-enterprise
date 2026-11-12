import { describe, expect, it } from 'vitest'
import { sha256Hex, type BlobStore } from '../../../../modules/drive/storage'
import { readCompanyLogo, removeCompanyLogo, resolveCompanyIdentity, saveCompanyLogo, saveCompanyName, type CompanyDeps } from './service'
import { memoryCompanyProfileStore } from './store'

function memoryBlobs(): BlobStore & { shas: () => string[] } {
  const blobs = new Map<string, Uint8Array>()
  return {
    async put(bytes) {
      const sha256 = sha256Hex(bytes)
      const created = !blobs.has(sha256)
      blobs.set(sha256, bytes)
      return { sha256, size: bytes.byteLength, created }
    },
    async get(sha) {
      const b = blobs.get(sha)
      if (!b) throw new Error(`no blob ${sha}`)
      return b
    },
    async has(sha) {
      return blobs.has(sha)
    },
    async remove(sha) {
      blobs.delete(sha)
    },
    shas: () => [...blobs.keys()],
  }
}

function deps(interview: string | null = 'Founding Name'): CompanyDeps & { blobs: ReturnType<typeof memoryBlobs> } {
  return { store: memoryCompanyProfileStore(), blobs: memoryBlobs(), interviewName: async () => interview }
}

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>')

describe('resolveCompanyIdentity', () => {
  it('is the founding interview’s name until someone sets one in Settings → Company', async () => {
    const d = deps()
    expect(await resolveCompanyIdentity(d)).toEqual({ name: 'Founding Name', logo: null })
    await saveCompanyName('Kindred Digital Labs', 'u-owner', d)
    expect(await resolveCompanyIdentity(d)).toEqual({ name: 'Kindred Digital Labs', logo: null })
  })

  it('is unnamed while neither has a name', async () => {
    expect((await resolveCompanyIdentity(deps(null))).name).toBeNull()
  })

  it('a logo alone does not hide the founding name', async () => {
    const d = deps()
    await saveCompanyLogo({ bytes: png, mime: 'image/png' }, 'u1', d)
    const identity = await resolveCompanyIdentity(d)
    expect(identity.name).toBe('Founding Name')
    expect(identity.logo).toEqual({ sha256: sha256Hex(png), mime: 'image/png', url: `/api/company/logo/${sha256Hex(png)}` })
  })
})

describe('saveCompanyName', () => {
  it('normalizes and stores the name, saying who changed it', async () => {
    const d = deps()
    expect(await saveCompanyName('  Kindred   Labs ', 'u-admin', d)).toEqual({ ok: true, name: 'Kindred Labs' })
    expect(await d.store.get()).toMatchObject({ name: 'Kindred Labs', updatedBy: 'u-admin' })
  })

  it('refuses an empty name and stores nothing', async () => {
    const d = deps()
    expect(await saveCompanyName('  ', 'u1', d)).toEqual({ ok: false, error: 'The company name is required.' })
    expect(await d.store.get()).toBeNull()
  })
})

describe('logo', () => {
  it('replacing it removes the old bytes; removing it removes the last', async () => {
    const d = deps()
    await saveCompanyLogo({ bytes: png, mime: 'image/png' }, 'u1', d)
    expect(d.blobs.shas()).toEqual([sha256Hex(png)])
    await saveCompanyLogo({ bytes: svg, mime: 'image/svg+xml' }, 'u1', d)
    expect(d.blobs.shas()).toEqual([sha256Hex(svg)])
    await removeCompanyLogo('u1', d)
    expect(d.blobs.shas()).toEqual([])
    expect((await resolveCompanyIdentity(d)).logo).toBeNull()
  })

  it('uploading the same logo again keeps it', async () => {
    const d = deps()
    await saveCompanyLogo({ bytes: png, mime: 'image/png' }, 'u1', d)
    await saveCompanyLogo({ bytes: png, mime: 'image/png' }, 'u1', d)
    expect(d.blobs.shas()).toEqual([sha256Hex(png)])
  })

  it('serves only the current logo, with its type', async () => {
    const d = deps()
    await saveCompanyLogo({ bytes: png, mime: 'image/png' }, 'u1', d)
    expect(await readCompanyLogo(sha256Hex(png), d)).toEqual({ bytes: png, mime: 'image/png' })
    expect(await readCompanyLogo(sha256Hex(svg), d)).toBeNull()
    expect(await readCompanyLogo('not-a-sha', d)).toBeNull()
  })

  it('fails loud when the current logo is missing on disk', async () => {
    const d = deps()
    await saveCompanyLogo({ bytes: png, mime: 'image/png' }, 'u1', d)
    await d.blobs.remove(sha256Hex(png))
    await expect(readCompanyLogo(sha256Hex(png), d)).rejects.toThrow(/missing on disk/)
  })
})
