import { describe, expect, it } from 'vitest'
import { MaterialError } from '../../../../modules/brand/material/types'
import { companyLogoFrom, materialFailure } from './material'

const sha = 'a'.repeat(64)

function storage(logo: { sha256: string; mime: 'image/png' } | null, onDisk = true) {
  return {
    store: {
      get: async () => (logo ? { name: 'Acme', logo, updatedBy: 'ana', updatedAt: new Date() } : null),
      setName: async () => {},
      setLogo: async () => ({ previous: null }),
    },
    blobs: {
      put: async () => ({ sha256: sha, size: 1 }),
      get: async () => new Uint8Array([9]),
      has: async () => onDisk,
      remove: async () => {},
    },
  }
}

describe('companyLogoFrom', () => {
  it('reads the current company logo’s bytes and type', async () => {
    await expect(companyLogoFrom(storage({ sha256: sha, mime: 'image/png' }) as never)).resolves.toEqual({
      mime: 'image/png',
      bytes: new Uint8Array([9]),
    })
  })

  it('no logo set → null; a logo missing on disk fails loud', async () => {
    await expect(companyLogoFrom(storage(null) as never)).resolves.toBeNull()
    await expect(companyLogoFrom(storage({ sha256: sha, mime: 'image/png' }, false) as never)).rejects.toThrow(/missing on disk/)
  })
})

describe('materialFailure', () => {
  it('maps the material errors to their status with a plain sentence and an agent report', async () => {
    const res = materialFailure('Exporting', new MaterialError('unavailable', 'No browser.'))!
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ message: 'No browser.' })
    expect(materialFailure('x', new MaterialError('not_found', 'none'))!.status).toBe(404)
    expect(materialFailure('x', new MaterialError('upstream', 'later'))!.status).toBe(502)
    expect(materialFailure('x', new MaterialError('invalid', 'no'))!.status).toBe(400)
  })

  it('anything else is not a refusal (the route rethrows it)', () => {
    expect(materialFailure('x', new Error('db down'))).toBeNull()
  })
})
